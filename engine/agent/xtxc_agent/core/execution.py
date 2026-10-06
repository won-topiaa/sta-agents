"""After approval: preparation, signature check, ordered submission, conditional
orders, receipts, claim scoring, stop, and daily seals.

Rules proven in docs/EXPERIMENT_PRESIGN_20260929.md:
- submit pre-signed groups strictly in sequence order and always with preflight;
- a failed group makes later groups unusable -> they are cancelled, never retried blindly;
- UNKNOWN results are looked up, never re-bought.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from ..chain.client import ChainError
from . import i18n, market
from .i18n import tr
from .claims import Claims
from .config import Settings
from .db import Database, dumps, new_id, now_iso
from .ledger import Ledger
from .orders import USDC_UNIT, topic, usdc_atoms_to_krw, won


class ExecutionError(RuntimeError):
    pass


class Executor:
    def __init__(self, settings: Settings, db: Database, ledger: Ledger, claims: Claims, chain, planner, kiln):
        self.s = settings
        self.db = db
        self.ledger = ledger
        self.claims = claims
        self.chain = chain
        self.planner = planner
        self.kiln = kiln
        self._stop = threading.Event()
        # One pass over waiting orders at a time: the background watcher, the demo "check now" tool and stop must never
        # send (or drop) the same pre-signed group concurrently -- a double send fails and would cancel the later groups.
        self._watch_lock = threading.RLock()

    # --------------------------------------------------------------- helpers
    def plan(self, plan_id: str) -> dict:
        row = self.db.one("SELECT body, status FROM plans WHERE plan_id = ?", (plan_id,))
        if not row:
            raise ExecutionError(tr("err.exec.plan_not_found"))
        plan = json.loads(row["body"])
        plan["status"] = row["status"]
        return plan

    def _set_plan_status(self, plan_id: str, status: str) -> None:
        self.db.execute("UPDATE plans SET status = ?, updated_at = ? WHERE plan_id = ?", (status, now_iso(), plan_id))

    def _market_open(self) -> bool:
        return market.status()["open"]

    # dev-only demo switch, shared with the planner through the market module
    @property
    def market_override(self) -> bool | None:
        return market._override

    @market_override.setter
    def market_override(self, value: bool | None) -> None:
        market.set_override(value)

    def _current_brief_version(self, brief_id: str) -> int:
        row = self.db.one("SELECT MAX(version) v FROM briefs WHERE brief_id = ? AND status = 'confirmed'", (brief_id,))
        return row["v"] or 0

    # --------------------------------------------------------------- prepare
    def prepare(self, plan_id: str, mode: str, condition: dict | None) -> dict:
        plan = self.plan(plan_id)
        if plan["status"] != "shown":
            raise ExecutionError(tr("err.exec.used"))
        if plan["tier"] == "blocked":
            raise ExecutionError(tr("err.exec.blocked"))
        if plan["brief_version"] != self._current_brief_version(plan["brief_id"]):
            self._set_plan_status(plan_id, "superseded")
            raise ExecutionError(tr("err.exec.superseded"))
        if mode not in plan["mode_options"]:
            if mode == "now" and (plan.get("immediate") or {}).get("reason_ko"):
                raise ExecutionError(plan["immediate"]["reason_ko"])
            raise ExecutionError(tr("err.exec.mode"))
        condition = condition or {}
        immediate = mode == "now" and bool(plan.get("immediate"))
        if immediate and condition.get("accept_extra_cost") is not True:
            # the thin stock is bought in one go only after the user has seen what that costs
            raise ExecutionError(tr("err.exec.ack", note=plan["immediate"]["note_ko"]))
        interval = None
        if mode == "slice" and condition.get("interval_minutes") is not None:
            interval = condition["interval_minutes"]
            if interval not in (plan.get("slice_interval_options") or []):
                raise ExecutionError(tr("err.exec.interval", opts=i18n.join(tr("unit.minutes", n=m) for m in plan.get("slice_interval_options") or [])))
        orders, offsets, labels = self._chain_orders(plan, mode, interval)
        prep_id = new_id("prep")
        if mode == "notify":
            body = {"condition": condition, "transactions": [], "plan_hash": plan["plan_hash"]}
            status = "notify_waiting"
            result = {"prep_id": prep_id, "transactions": [], "mode": mode}
        else:
            deadline_s = None
            if mode in ("presign", "slice"):
                if not condition.get("deadline"):
                    # no deadline chosen: 12 hours, written into the condition so the watcher and the screens use the same one
                    condition = {**condition, "deadline": (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat(),
                                 "deadline_default": True}
                deadline = condition["deadline"]
                deadline_s = int((datetime.fromisoformat(deadline.replace("Z", "+00:00")) - datetime.now(timezone.utc)).total_seconds())
                if deadline_s < 60:
                    raise ExecutionError(tr("err.exec.deadline_min"))
                if mode == "slice" and deadline_s < max(offsets) * 60 + 60:
                    raise ExecutionError(tr("err.exec.deadline_slices", m=max(offsets)))
            prepared = self.chain.prepare(plan["wallet"], orders, plan["plan_hash"], "now" if mode == "now" else "presign", deadline_s)
            txs = prepared["transactions"]
            group_offsets = [max(offsets[o["index"]] for o in t["orders"]) for t in txs]
            group_labels = [" · ".join(sorted({labels[o["index"]] for o in t["orders"]})) for t in txs]
            body = {"condition": condition, "transactions": txs, "plan_hash": plan["plan_hash"], "network": prepared["network"],
                    "genesis": prepared["genesis"], "offsets_min": group_offsets, "group_labels": group_labels,
                    "group_state": ["pending"] * len(txs), "results": [None] * len(txs)}
            status = "awaiting_signature"
            result = {"prep_id": prep_id, "mode": mode, "network": prepared["network"],
                      "transactions": [t["transaction"] for t in txs],
                      "groups": [{"orders": [o["ticker"] for o in t["orders"]], "label_ko": group_labels[i], "bytes": t["bytes"],
                                  "nonce_account": t["nonceAccount"], "deadline_slot": t["deadlineSlot"], "not_before_min": group_offsets[i]}
                                 for i, t in enumerate(txs)],
                      "preview": plan["immediate"]["wallet_preview"] if immediate else plan["wallet_preview"]}
        self.db.execute("INSERT INTO prepared(prep_id, plan_id, wallet, mode, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                        (prep_id, plan_id, plan["wallet"], mode, dumps(body), status, now_iso(), now_iso()))
        label = i18n.label("mode", mode)
        payload = {"prep_id": prep_id, "mode": mode, "condition": condition, "plan_hash": plan["plan_hash"]}
        if immediate:
            label = tr("mode.immediate")
            payload["immediate"] = {k: plan["immediate"][k] for k in ("tickers", "extra_cost_krw", "worst_cost_bps")}
            self.planner.immediate_claims(plan)
        if interval:
            label = tr("mode.slice_interval", m=interval)
        self.ledger.append("plan.prepared", tr("ledger.plan.prepared", label=label, headline=plan["headline_ko"]), wallet=plan["wallet"], ref=plan_id, payload=payload)
        if mode == "notify":
            self._set_plan_status(plan_id, "waiting")
        return result

    @staticmethod
    def _chain_orders(plan: dict, mode: str, interval: int | None = None) -> tuple[list[dict], list[int], list[str]]:
        """Orders for the chain in submission order. In 'slice' mode slice k of every thin stock goes into round k
        (one transaction per round, k x interval after the first); stocks bought in one go ride in round 0.
        In 'now' mode a thin stock goes at full size with its full-size minimum (지금 한 번에).
        Settlement sequence numbers follow this order, so time order and sequence order agree."""
        rows = []
        for o in plan["orders"]:
            sl = o.get("slicing")
            if sl and mode == "slice":
                n = len(sl["slice_inputs"])
                gap = interval or sl["interval_minutes"]
                for k, (inp, mn) in enumerate(zip(sl["slice_inputs"], sl["slice_min_outs"])):
                    rows.append((k, k * gap, f"{o['name_ko']} {k + 1}/{n}",
                                 {"routeId": o["route"]["route_id"], "input": inp, "minOut": mn, "round": k}))
            else:
                if sl and not o.get("immediate"):
                    raise ExecutionError(tr("err.exec.only_split", name=topic(o["name_ko"])))
                min_out = o["immediate"]["min_out_atoms"] if sl else o["quote"]["min_out_atoms"]
                rows.append((0, 0, tr("label.all", name=o["name_ko"]),
                             {"routeId": o["route"]["route_id"], "input": o["input_atoms"], "minOut": min_out, "round": 0}))
        rows.sort(key=lambda r: r[0])
        return [r[3] for r in rows], [r[1] for r in rows], [r[2] for r in rows]

    # ---------------------------------------------------------------- submit
    def submit(self, plan_id: str, signed: list[str]) -> dict:
        row = self.db.one("SELECT * FROM prepared WHERE plan_id = ? AND status = 'awaiting_signature' ORDER BY created_at DESC LIMIT 1", (plan_id,))
        if not row:
            raise ExecutionError(tr("err.exec.no_pending_sig"))
        body = json.loads(row["body"])
        plan = self.plan(plan_id)
        txs = body["transactions"]
        if len(signed) != len(txs):
            raise ExecutionError(tr("err.exec.need_all", n=len(txs)))
        checks = [self.chain.verify(t["transaction"], s) for t, s in zip(txs, signed)]
        verification = {"bytes_match": all(c["bytesMatch"] for c in checks), "signature_valid": all(c["signatureValid"] for c in checks),
                        "payer_matches": all(c["payer"] == plan["wallet"] for c in checks),
                        "added_instructions": [a for c in checks for a in c["addedInstructions"]]}
        if not (verification["bytes_match"] and verification["signature_valid"] and verification["payer_matches"]):
            self._update_prepared(row["prep_id"], "rejected", {"verification": verification})
            self.ledger.append("plan.signature_mismatch", tr("ledger.sig_mismatch"), wallet=plan["wallet"],
                               ref=plan_id, payload=verification)
            return {"verification": verification, "status": "rejected"}
        for t, s in zip(txs, signed):
            t["signed"] = s
        if row["mode"] in ("presign", "slice"):
            self._update_prepared(row["prep_id"], "presigned_waiting", {"transactions": txs, "verification": verification})
            self._set_plan_status(plan_id, "presigned")
            cond = body["condition"]
            text = self._condition_text(cond, plan)
            if row["mode"] == "slice":
                gap = max(body.get("offsets_min") or [0])
                text = tr("ledger.presigned.slice", n=len(txs), m=gap, headline=plan["headline_ko"])
            self.ledger.append("order.presigned", text, wallet=plan["wallet"], ref=plan_id,
                               payload={"prep_id": row["prep_id"], "condition": cond, "plan_hash": plan["plan_hash"],
                                        "nonce_accounts": [t["nonceAccount"] for t in txs]})
            return {"verification": verification, "status": "presigned_waiting", "prep_id": row["prep_id"]}
        receipt = self._execute_groups(plan, row["prep_id"], txs, approved_at=now_iso())
        return {"verification": verification, "status": "submitted", "receipt_id": receipt["receipt_id"], "receipt": receipt}

    def _update_prepared(self, prep_id: str, status: str, patch: dict) -> None:
        row = self.db.one("SELECT body FROM prepared WHERE prep_id = ?", (prep_id,))
        body = {**json.loads(row["body"]), **patch}
        if status in ("rejected", "expired", "superseded"):
            # Dropped without landing: forget the signed bytes and free the nonce accounts they would have used.
            for t in body.get("transactions", []):
                t.pop("signed", None)
            try:
                self.chain.release([t["nonceAccount"] for t in body.get("transactions", []) if t.get("nonceAccount")])
            except Exception:
                pass
        self.db.execute("UPDATE prepared SET status = ?, body = ?, updated_at = ? WHERE prep_id = ?", (status, dumps(body), now_iso(), prep_id))

    @staticmethod
    def _condition_text(cond: dict, plan: dict) -> str:
        parts = []
        if cond.get("market_open"):
            parts.append(tr("cond.market_open"))
        if cond.get("max_premium_bps") is not None:
            parts.append(tr("cond.premium", p=f"{cond['max_premium_bps']/100:.2f}"))
        if cond.get("deadline"):
            parts.append(tr("cond.deadline", t=cond["deadline"][:16].replace("T", " ")))
        return tr("ledger.presigned.cond", parts=" ".join(parts) or tr("cond.none"), headline=plan["headline_ko"])

    def _execute_groups(self, plan: dict, prep_id: str, txs: list[dict], approved_at: str) -> dict:
        results = []
        failed_at = None
        for i, t in enumerate(txs):
            if failed_at is not None:
                results.append({"group": i, "status": "cancelled", "reason": tr("reason.prev_failed")})
                continue
            r = self.chain.submit(t["signed"], preflight=True)
            status = "filled" if r.get("ok") else ("unknown" if (r.get("error") or {}).get("name") == "UNKNOWN" else "failed")
            results.append({"group": i, "status": status, "signature": r.get("signature"), "error": r.get("error"),
                            "fee": r.get("fee"), "compute_units": r.get("computeUnits"), "memo": r.get("memo"),
                            "orders": r.get("orders", []), "landed": r.get("landed")})
            if status != "filled":
                failed_at = i
        self._update_prepared(prep_id, "done", {"results": results, "group_state": [r["status"] for r in results]})
        return self._receipt(plan, prep_id, txs, results, approved_at)

    def _receipt(self, plan: dict, prep_id: str, txs: list[dict], results: list[dict], approved_at: str) -> dict:
        fx = plan["fx_krw_per_usdc"]
        by_ticker = {o["ticker"]: o for o in plan["orders"]}
        agg: dict[str, dict] = {}
        for tx, res in zip(txs, results):
            res = res or {"status": "expired"}
            received = {(o["ticker"], o.get("index")): int(o["receivedAtoms"]) for o in res.get("orders", [])}
            for o in tx["orders"]:
                a = agg.setdefault(o["ticker"], {"parts": 0, "filled": 0, "input": 0, "received": 0, "min": 0, "statuses": []})
                a["parts"] += 1
                a["statuses"].append(res["status"])
                if res["status"] == "filled":
                    a["filled"] += 1
                    a["input"] += int(o["input"])
                    a["min"] += int(o["minOut"])
                    a["received"] += received.get((o["ticker"], o.get("index")), 0)
        order_results = []
        cost_usdc = 0
        for ticker, a in agg.items():
            po = by_ticker[ticker]
            q = po["quote"]
            if a["filled"] == a["parts"]:
                status = "filled"
            elif a["filled"]:
                status = "partial"
            else:
                status = next(st for st in a["statuses"] if st != "filled")
            entry = {"ticker": ticker, "name_ko": po["name_ko"], "side": po["side"], "status": status,
                     "input_atoms": str(a["input"]) if a["filled"] else po["input_atoms"],
                     "planned_input_atoms": po["input_atoms"],
                     "received_atoms": str(a["received"]) if a["filled"] else None,
                     "min_out_atoms": str(a["min"]) if a["filled"] else q["min_out_atoms"],
                     "in_decimals": q.get("in_decimals"), "out_decimals": q["out_decimals"], "ui_multiplier": q.get("ui_multiplier", 1.0)}
            if a["parts"] > 1:
                entry["slices"] = {"total": a["parts"], "filled": a["filled"]}
            close = Decimal(po["close_usd"]) if po.get("close_usd") else None
            if a["filled"] and close:
                mult = Decimal(str(q.get("ui_multiplier") or 1))
                if po["side"] == "BUY":
                    value = Decimal(a["received"]) / (Decimal(10) ** q["out_decimals"]) * mult * close * USDC_UNIT
                    cost = Decimal(a["input"]) - value
                    entry["cost_bps"] = round(float(cost / Decimal(a["input"]) * 10_000), 1)
                else:
                    value_in = Decimal(a["input"]) / (Decimal(10) ** q["in_decimals"]) * mult * close * USDC_UNIT
                    cost = value_in - Decimal(a["received"])
                    entry["cost_bps"] = round(float(cost / value_in * 10_000), 1)
                cost_usdc += int(cost)
            order_results.append(entry)
        self._score_claims(plan, order_results)
        usage = self._ai_usage(plan)
        receipt_id = new_id("rc")
        signatures = [r.get("signature") for r in results if r.get("signature")]
        run = self.db.one("SELECT report FROM runs WHERE run_id = ?", (plan["run_id"],))
        report = json.loads(run["report"]) if run and run["report"] else {}
        receipt = {
            "receipt_id": receipt_id, "plan_id": plan["plan_id"], "plan_hash": plan["plan_hash"],
            "strategy": report.get("title_ko", tr("word.strategy")), "lang": i18n.lang(), "report_run_id": plan["run_id"], "data_as_of": plan.get("prices_as_of"),
            "approved_at": approved_at, "signatures": len(signatures), "results": order_results,
            "cost_krw": usdc_atoms_to_krw(cost_usdc, fx) if cost_usdc else 0,
            "ai": usage,
            "chain": {"network": self.chain.network, "signatures": signatures, "memo": f"xtxc:plan:v1:{plan['plan_hash']}",
                      "memo_on_chain": next((r.get("memo") for r in results if r.get("memo")), None)},
            "seal": {"day": now_iso()[:10], "included": False},
        }
        receipt["chain"]["memo_matches"] = receipt["chain"]["memo_on_chain"] == receipt["chain"]["memo"]
        receipt["chain"]["devnet"] = self._devnet(receipt["chain"]["memo"])
        self.db.execute("INSERT INTO receipts(receipt_id, plan_id, wallet, body, created_at) VALUES (?,?,?,?,?)",
                        (receipt_id, plan["plan_id"], plan["wallet"], dumps(receipt), now_iso()))
        filled = [o for o in order_results if o["status"] == "filled"]
        not_filled = [o for o in order_results if o["status"] != "filled"]
        self._set_plan_status(plan["plan_id"], "done" if not not_filled else "partial")
        status_ko = i18n.Names("status")
        summary = tr("receipt.summary", n=len(filled))
        for o in not_filled:
            extra = tr("receipt.slices", f=o["slices"]["filled"], t=o["slices"]["total"]) if o.get("slices") else ""
            summary += f", {o['name_ko']} {status_ko.get(o['status'], o['status'])}{extra}"
        self.ledger.append("order.filled" if not not_filled else "order.failed", summary, wallet=plan["wallet"], ref=receipt_id,
                           payload={"plan_hash": plan["plan_hash"], "signatures": signatures, "results": order_results})
        return receipt

    def _score_claims(self, plan: dict, order_results: list[dict]) -> None:
        by = {o["ticker"]: o for o in order_results}
        for c in self.claims.for_plan(plan["plan_id"]):
            o = by.get(c["subject"])
            if o and o["status"] == "partial" and c["metric"] == "cost_bps" and o.get("cost_bps") is not None:
                self.claims.resolve(c["claim_id"], o["cost_bps"])
            elif not o or o["status"] != "filled":
                self.claims.void(c["claim_id"], o["status"] if o else "missing")
            elif c["metric"] == "received_atoms" and o.get("received_atoms"):
                self.claims.resolve(c["claim_id"], float(o["received_atoms"]))
            elif c["metric"] == "cost_bps" and o.get("cost_bps") is not None:
                self.claims.resolve(c["claim_id"], o["cost_bps"])

    def _ai_usage(self, plan: dict) -> dict:
        refs = [plan["brief_id"], plan["run_id"], plan["plan_id"]]
        row = self.db.one(
            f"SELECT COUNT(*) calls, SUM(cache_hit) hits, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) tokens, SUM(cost_usd) cost"
            f" FROM ai_calls WHERE ref IN ({','.join('?' * len(refs))})", refs)
        return {"model": self.s.kiln_model, "calls": row["calls"] or 0, "cache_hits": row["hits"] or 0,
                "tokens": row["tokens"] or 0, "cost_usd": round(row["cost"] or 0.0, 6)}

    # ------------------------------------------------------------ conditions
    def evaluate_condition(self, plan: dict, cond: dict) -> dict:
        """Returns {'ok': bool, 'reasons': [...], 'premium_bps': float|None}. Code only."""
        reasons = []
        if cond.get("deadline"):
            if datetime.now(timezone.utc) > datetime.fromisoformat(cond["deadline"].replace("Z", "+00:00")):
                return {"ok": False, "expired": True, "reasons": [tr("cond.reason.expired")]}
        if cond.get("market_open") and not self._market_open():
            reasons.append(tr("cond.reason.closed"))
        worst = None
        if cond.get("max_premium_bps") is not None:
            for o in plan["orders"]:
                if not o.get("close_usd"):
                    continue
                size = int(o["slicing"]["slice_inputs"][0]) if o.get("slicing") else int(o["input_atoms"])
                qp = self.planner._quote_pair(o["ticker"], o["side"], size, plan["wallet"])
                if not qp["available"]:
                    reasons.append(tr("cond.reason.route", name=o["name_ko"]))
                    continue
                econ = self.planner._economics(o["side"], qp, Decimal(o["close_usd"]))
                if econ["premium_bps"] is not None:
                    worst = econ["premium_bps"] if worst is None else max(worst, econ["premium_bps"])
            if worst is not None and worst > cond["max_premium_bps"]:
                reasons.append(tr("cond.reason.premium", p=f"{worst/100:.2f}"))
        return {"ok": not reasons, "reasons": reasons, "premium_bps": worst}

    def watch_once(self) -> list[dict]:
        with self._watch_lock, i18n.speaking(i18n.lang()):   # each order below switches to its plan's language
            return self._watch_once()

    def _watch_once(self) -> list[dict]:
        try:
            genesis = self.chain.status().get("genesis")
        except ChainError:
            return []            # the chain is (re)starting: nothing can be checked or sent now; try again next pass
        actions = []
        for row in self.db.all("SELECT * FROM prepared WHERE status IN ('presigned_waiting','notify_waiting') ORDER BY created_at"):
            try:
                action = self._watch_row(row, genesis)
            except Exception as exc:  # one broken order must never stop the others from being checked
                self.ledger.append("watcher.error", tr("ledger.watcher_error", e=str(exc)[:100]), ref=row["plan_id"],
                                   payload={"prep_id": row["prep_id"], "error": str(exc)[:500]})
                action = {"prep_id": row["prep_id"], "action": "error", "error": str(exc)[:200]}
            if action:
                actions.append(action)
        return actions

    def _watch_row(self, row, genesis: str | None) -> dict | None:
        body = json.loads(row["body"])
        plan = self.plan(row["plan_id"])
        i18n.set_lang(plan.get("lang"))
        if genesis and body.get("genesis") and body["genesis"] != genesis:
            # The (demo) chain was restarted: signatures made for the old chain can never land. Close them honestly.
            if "filled" in (body.get("group_state") or []):
                receipt = self._close_partial(plan, row, body, reason=tr("reason.chain_reset"))
                return {"prep_id": row["prep_id"], "action": "expired_partial", "receipt_id": receipt["receipt_id"]}
            self._update_prepared(row["prep_id"], "expired", {"last_check": {"ok": False, "reasons": [tr("reason.chain_reset")]}})
            self._set_plan_status(plan["plan_id"], "expired")
            for c in self.claims.for_plan(plan["plan_id"]):
                self.claims.void(c["claim_id"], "chain reset")
            self.ledger.append("order.expired", tr("ledger.order.chain_reset"), wallet=plan["wallet"], ref=plan["plan_id"],
                               payload={"prep_id": row["prep_id"], "old_genesis": body["genesis"], "genesis": genesis})
            return {"prep_id": row["prep_id"], "action": "expired", "reason": "chain_reset"}
        if plan["brief_version"] != self._current_brief_version(plan["brief_id"]):
            self._update_prepared(row["prep_id"], "superseded", {})
            self._set_plan_status(plan["plan_id"], "superseded")
            self.ledger.append("order.superseded", tr("ledger.order.superseded"),
                               wallet=plan["wallet"], ref=plan["plan_id"], payload={"prep_id": row["prep_id"]})
            return {"prep_id": row["prep_id"], "action": "superseded"}
        verdict = self.evaluate_condition(plan, body["condition"])
        if verdict.get("expired") and "filled" in (body.get("group_state") or []):
            # Some slices already landed: close the rest as expired and issue a receipt for what happened.
            receipt = self._close_partial(plan, row, body)
            return {"prep_id": row["prep_id"], "action": "expired_partial", "receipt_id": receipt["receipt_id"]}
        if verdict.get("expired"):
            self._update_prepared(row["prep_id"], "expired", {"last_check": verdict})
            self._set_plan_status(plan["plan_id"], "expired")
            for c in self.claims.for_plan(plan["plan_id"]):
                self.claims.void(c["claim_id"], "expired")
            self.ledger.append("order.expired", tr("ledger.order.expired"), wallet=plan["wallet"], ref=plan["plan_id"],
                               payload={"prep_id": row["prep_id"]})
            return {"prep_id": row["prep_id"], "action": "expired"}
        self._update_prepared(row["prep_id"], row["status"], {"last_check": {**verdict, "at": now_iso()}})
        if not verdict["ok"]:
            return None
        if row["status"] == "notify_waiting":
            self._update_prepared(row["prep_id"], "notify_ready", {})
            self._set_plan_status(plan["plan_id"], "ready")
            self.ledger.append("order.ready", tr("ledger.order.ready", headline=plan["headline_ko"]), wallet=plan["wallet"], ref=plan["plan_id"],
                               payload={"prep_id": row["prep_id"], "premium_bps": verdict["premium_bps"]})
            return {"prep_id": row["prep_id"], "action": "notify_ready"}
        body = json.loads(self.db.one("SELECT body FROM prepared WHERE prep_id = ?", (row["prep_id"],))["body"])
        outcome = self._advance(plan, row, body)
        return {"prep_id": row["prep_id"], **outcome} if outcome else None

    def _advance(self, plan: dict, row, body: dict) -> dict | None:
        """Send every pre-signed group that is due, in sequence order. A group is sent only if its signed bytes
        simulate cleanly now (for a slice: the pool is back near the pre-trade price). Stops at the first group
        that must wait; a failed group cancels the rest (their sequence can no longer land)."""
        txs = body["transactions"]
        n = len(txs)
        state = body.get("group_state") or ["pending"] * n
        results = body.get("results") or [None] * n
        offsets = body.get("offsets_min") or [0] * n
        labels = body.get("group_labels") or [""] * n
        started = body.get("started_at")
        wait = None
        sent = []
        for i in range(n):
            if state[i] != "pending":
                continue
            if started and offsets[i]:
                due = datetime.fromisoformat(started.replace("Z", "+00:00")) + timedelta(minutes=offsets[i])
                if datetime.now(timezone.utc) < due:
                    wait = {"group": i, "label_ko": labels[i], "reason_ko": tr("wait.not_yet"), "due": due.isoformat()}
                    break
            sim = self.chain.simulate(txs[i]["signed"])
            if not sim.get("pass"):
                reason = tr("wait.price") if offsets[i] else tr("wait.min_out")
                wait = {"group": i, "label_ko": labels[i], "reason_ko": reason, "simulation": sim}
                break
            r = self.chain.submit(txs[i]["signed"], preflight=True)
            status = "filled" if r.get("ok") else ("unknown" if (r.get("error") or {}).get("name") == "UNKNOWN" else "failed")
            results[i] = {"group": i, "status": status, "signature": r.get("signature"), "error": r.get("error"), "fee": r.get("fee"),
                          "compute_units": r.get("computeUnits"), "memo": r.get("memo"), "orders": r.get("orders", []),
                          "landed": r.get("landed"), "at": now_iso()}
            state[i] = status
            started = started or now_iso()
            sent.append(i)
            if row["mode"] == "slice" and status == "filled":
                self.ledger.append("order.slice", tr("ledger.order.slice", label=labels[i]), wallet=plan["wallet"], ref=plan["plan_id"],
                                   payload={"group": i, "signature": r.get("signature")})
            if status != "filled":
                for j in range(i + 1, n):
                    if state[j] == "pending":
                        state[j] = "cancelled"
                        results[j] = {"group": j, "status": "cancelled", "reason_ko": tr("reason.prev_failed")}
                        txs[j].pop("signed", None)
                self._release([t for j, t in enumerate(txs) if state[j] == "cancelled"])
                break
        body.update(transactions=txs, group_state=state, results=results, started_at=started, last_wait=wait)
        if all(st != "pending" for st in state):
            self._update_prepared(row["prep_id"], "done", body)
            receipt = self._receipt(plan, row["prep_id"], txs, results, approved_at=row["created_at"])
            return {"action": "submitted", "receipt_id": receipt["receipt_id"], "groups_sent": sent}
        self._update_prepared(row["prep_id"], row["status"], body)
        return {"action": "progress", "groups_sent": sent, "waiting": wait} if sent else None

    def fast_forward(self, wallet: str) -> list[dict]:
        """Demo tool: make the next round of this wallet's sliced orders due now (the chain part is unchanged:
        a slice still goes only if its signed bytes simulate at the promised minimum). Recorded in the ledger."""
        moved = []
        with self._watch_lock:
            for row in self.db.all("SELECT * FROM prepared WHERE wallet = ? AND mode = 'slice' AND status = 'presigned_waiting'", (wallet,)):
                body = json.loads(row["body"])
                state, offsets = body.get("group_state") or [], body.get("offsets_min") or []
                nxt = next((i for i, st in enumerate(state) if st == "pending"), None)
                if nxt is None or not body.get("started_at") or not offsets[nxt]:
                    continue
                started = datetime.fromisoformat(body["started_at"].replace("Z", "+00:00"))
                ahead = started + timedelta(minutes=offsets[nxt]) - datetime.now(timezone.utc)
                if ahead.total_seconds() <= 0:
                    continue
                body["started_at"] = (started - ahead).isoformat()
                self._update_prepared(row["prep_id"], row["status"], body)
                label = (body.get("group_labels") or [""] * len(state))[nxt]
                self.ledger.append("demo.fast_forward", tr("ledger.fast_forward", label=label, m=int(ahead.total_seconds() // 60)),
                                   wallet=wallet, ref=row["plan_id"], payload={"prep_id": row["prep_id"], "group": nxt,
                                                                               "seconds": int(ahead.total_seconds())})
                moved.append({"prep_id": row["prep_id"], "group": nxt, "label_ko": label, "seconds": int(ahead.total_seconds())})
        return moved

    def _release(self, txs: list[dict]) -> None:
        try:
            self.chain.release([t["nonceAccount"] for t in txs if t.get("nonceAccount")])
        except Exception:
            pass

    def _close_partial(self, plan: dict, row, body: dict, reason: str | None = None) -> dict:
        txs, state, results = body["transactions"], body["group_state"], body["results"]
        for j, st in enumerate(state):
            if st == "pending":
                state[j] = "expired"
                results[j] = {"group": j, "status": "expired", "reason_ko": reason or tr("reason.expired_slice")}
                txs[j].pop("signed", None)
        self._release([t for j, t in enumerate(txs) if state[j] == "expired"])
        body.update(transactions=txs, group_state=state, results=results)
        self._update_prepared(row["prep_id"], "done", body)
        return self._receipt(plan, row["prep_id"], txs, results, approved_at=row["created_at"])

    def start_watcher(self, interval: float = 10.0) -> threading.Thread:
        def loop():
            last_seal_day = None
            while not self._stop.is_set():
                try:
                    self.watch_once()
                    today = now_iso()[:10]
                    if last_seal_day and last_seal_day != today:
                        self.seal_day(last_seal_day)
                    last_seal_day = today
                except ChainError:
                    pass          # chain briefly unavailable (restart): not an event worth recording
                except Exception as exc:  # keep watching; record the failure
                    self.ledger.append("watcher.error", tr("ledger.watcher_error", e=str(exc)[:100]), payload={"error": str(exc)[:500]})
                self._stop.wait(interval)
        t = threading.Thread(target=loop, name="xtxc-watcher", daemon=True)
        t.start()
        return t

    def stop_watcher(self) -> None:
        self._stop.set()

    # ------------------------------------------------------------------ stop
    def stop_all(self, wallet: str) -> dict:
        with self._watch_lock:
            return self._stop_all(wallet)

    def _stop_all(self, wallet: str) -> dict:
        cancelled = []
        for row in self.db.all("SELECT prep_id, plan_id, status, body FROM prepared WHERE wallet = ? AND status IN "
                               "('awaiting_signature','presigned_waiting','notify_waiting','notify_ready')", (wallet,)):
            body = json.loads(row["body"])
            for t in body.get("transactions", []):
                t.pop("signed", None)  # drop stored signed bytes; the nonce advance makes them void on chain
            self.db.execute("UPDATE prepared SET status = 'cancelled', body = ?, updated_at = ? WHERE prep_id = ?", (dumps(body), now_iso(), row["prep_id"]))
            self._set_plan_status(row["plan_id"], "cancelled")
            for c in self.claims.for_plan(row["plan_id"]):
                self.claims.void(c["claim_id"], "stopped")
            cancelled.append(row["prep_id"])
        cancel = self.chain.cancel_tx(wallet)
        self.ledger.append("stop", tr("ledger.stop", n=len(cancelled)) + (tr("ledger.stop.void_tx") if cancel else ""),
                           wallet=wallet, payload={"cancelled": cancelled, "nonce_accounts": (cancel or {}).get("nonceAccounts", [])})
        return {"cancelled": cancelled, "transactions": [cancel["transaction"]] if cancel else []}

    def submit_stop(self, wallet: str, signed: list[str]) -> dict:
        results = [self.chain.submit(s, preflight=True) for s in signed]
        ok = all(r.get("ok") for r in results)
        self.ledger.append("stop.confirmed" if ok else "stop.failed",
                           tr("ledger.stop.ok") if ok else tr("ledger.stop.fail"),
                           wallet=wallet, payload={"signatures": [r.get("signature") for r in results]})
        return {"ok": ok, "results": results}

    # ------------------------------------------------------------------ seal
    def seal_day(self, day: str) -> dict:
        """Seal the day's events not covered yet (a day can have several parts)."""
        info = self.ledger.unsealed(day)
        if not info["event_count"]:
            return {**self.verify_seal(day), "note_ko": tr("seal.nothing")}
        part = self.ledger.next_part(day)
        memo = self.ledger.seal_memo(day, part, info["root"])
        chain = self.chain.seal(memo)
        sealed = self.ledger.record_seal(day, info, chain["signature"], chain["network"])
        devnet = self._devnet(memo)
        self.ledger.append("seal", tr("ledger.seal", day=day, n=info["event_count"], p=part),
                           payload={"root": info["root"], "part": part, "signature": chain["signature"], "devnet": devnet})
        return {**sealed, "devnet": devnet}

    def _devnet(self, memo: str) -> dict | None:
        """Public-devnet copy of a plan/seal memo, only when the operator enabled the recorder."""
        if not self.chain.devnet_status().get("enabled"):
            return None
        try:
            return self.chain.devnet_record(memo)
        except Exception as exc:
            return {"error": str(exc)[:200]}

    def verify_seal(self, day: str) -> dict:
        """Recompute each sealed part's root and find its memo on chain: the local chain first; when that copy is gone
        (the demo chain restarts from its captured state), the public-devnet copy. Altered records change the
        recomputed root, so they match nowhere."""
        seal = self.ledger.seal(day)
        if not seal:
            return {"day": day, "sealed": False, "unsealed_after": self.ledger.unsealed(day)["event_count"]}
        for p in seal["parts"]:
            expected = self.ledger.seal_memo(day, p["part"], p["recomputed_root"])
            try:
                on_chain = self.chain.memo_of(p["signature"]) if p.get("signature") else None
            except Exception:
                on_chain = None
            p["memo_on_chain"] = on_chain
            p["verified_on"] = "local" if on_chain == expected else None
            if p["verified_on"] is None:
                ev = self.db.one("SELECT payload FROM events WHERE type = 'seal' AND json_extract(payload, '$.part') = ?"
                                 " AND json_extract(payload, '$.root') = ? ORDER BY seq DESC LIMIT 1", (p["part"], p["root"]))
                dv = ((json.loads(ev["payload"]) if ev else {}).get("devnet") or {}).get("signature")
                if dv:
                    try:
                        p["memo_on_devnet"] = self.chain.devnet_memo(dv)
                    except Exception:
                        p["memo_on_devnet"] = None
                    p["devnet_signature"] = dv
                    if p["memo_on_devnet"] == expected:
                        p["verified_on"] = "devnet"
            p["chain_matches"] = p["verified_on"] is not None
        return {**seal, "sealed": True, "memo_on_chain": seal["parts"][-1]["memo_on_chain"],
                "chain_matches": all(p["chain_matches"] for p in seal["parts"]), "chain_ok": self.ledger.verify_chain()}
