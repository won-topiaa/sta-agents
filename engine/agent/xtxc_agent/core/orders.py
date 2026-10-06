"""Order plans (결재 카드), their checks, preparation, submission and receipts.

Money is handled in integer atoms (USDC has 6 decimals). Prices used to value
holdings come from the research snapshot's last close and are labelled so.
"""

from __future__ import annotations

import hashlib
import json  # noqa: F401  (positions() parses receipt bodies)
from datetime import datetime, timedelta, timezone
from decimal import ROUND_DOWN, Decimal

from . import i18n, market
from .claims import Claims
from .i18n import tr
from .config import Settings
from .db import Database, dumps, new_id, now_iso
from .ledger import Ledger

USDC_DECIMALS = 6
USDC_UNIT = 10 ** USDC_DECIMALS

# 나눠 사기: when one order would move a thin pool too much, split it into time slices.
SLICE_TRIGGER_BPS = 50.0      # price impact of the whole order above which slicing is considered
SLICE_TARGET_BPS = 30.0       # each slice must move the price at most this much
SLICE_COUNTS = (2, 3, 4, 5, 6, 8)
SLICE_INTERVAL_MIN = 20
SLICE_INTERVAL_OPTIONS = (5, 10, 20)   # the user may try the next slice sooner; each slice still waits for the price to return


def krw_to_usdc_atoms(krw: int, fx: str) -> int:
    return int((Decimal(krw) / Decimal(fx) * USDC_UNIT).to_integral_value(ROUND_DOWN))


def usdc_atoms_to_krw(atoms: int, fx: str) -> int:
    return int((Decimal(atoms) / USDC_UNIT * Decimal(fx)).to_integral_value())


def won(krw: int) -> str:
    """1,234,567 -> '123만 4,567원' style kept simple: '123.5만 원' for >=10,000."""
    if abs(krw) >= 10_000:
        man = Decimal(krw) / 10_000
        text = f"{man:.1f}".rstrip("0").rstrip(".")
        return f"{text}만 원"
    return f"{krw:,}원"


def _has_batchim(word: str) -> bool:
    ch = word.rstrip()[-1:] if word.strip() else ""
    if "가" <= ch <= "힣":
        return (ord(ch) - 0xAC00) % 28 != 0
    return ch.lower() in "lmnr0136789"  # rough reading of latin letters/digits


# Korean particles only when the display language is Korean (see i18n).
topic = i18n.topic
obj = i18n.obj


def check(id_: str, label: str, status: str, detail: str) -> dict:
    return {"id": id_, "label_ko": label, "status": status, "detail_ko": detail}


class Planner:
    def __init__(self, settings: Settings, db: Database, ledger: Ledger, claims: Claims, chain, universe_fn, closes_fn):
        self.s = settings
        self.db = db
        self.ledger = ledger
        self.claims = claims
        self.chain = chain
        self.universe_fn = universe_fn      # () -> {ticker: Instrument}
        self.closes_fn = closes_fn          # (snapshot_id, tickers) -> ({ticker: Decimal close}, as_of)

    # ------------------------------------------------------------ quoting
    def _quote_pair(self, ticker: str, side: str, input_atoms: int, wallet: str | None = None) -> dict:
        # A sale can only be simulated from a wallet that holds the tokens.
        who = wallet if side == "SELL" else None
        small = max(1, input_atoms // 100)
        full = self.chain.quote(ticker, side, input_atoms, who)
        if not full.get("available"):
            return {"available": False, "reason": full.get("reason", "no route")}
        tiny = self.chain.quote(ticker, side, small, who)
        return {"available": True, "full": full, "small": tiny if tiny.get("available") else None}

    @staticmethod
    def _usdc_and_shares(side: str, q: dict) -> tuple[Decimal, Decimal]:
        """(USDC amount, share-equivalent amount) of a quote. Shares = token UI amount x ScaledUiAmount multiplier."""
        mult = Decimal(str(q.get("stockUiMultiplier") or 1))
        inp = Decimal(q["inputAtoms"]) / (Decimal(10) ** q["inputDecimals"])
        out = Decimal(q["expectedOutAtoms"]) / (Decimal(10) ** q["outputDecimals"])
        return (inp, out * mult) if side == "BUY" else (out, inp * mult)

    def _economics(self, side: str, qp: dict, close: Decimal | None) -> dict:
        full = qp["full"]
        small = qp["small"] or full
        uf, sf = self._usdc_and_shares(side, full)
        us, ss = self._usdc_and_shares(side, small)
        pf, ps = uf / sf, us / ss                      # USDC per share at order size / at tiny size
        impact_bps = float((pf / ps - 1) * 10_000) if side == "BUY" else float((1 - pf / ps) * 10_000)
        premium_bps = cost_bps = None
        ratio_ok = True
        if close and close > 0:
            ratio = ps / close
            ratio_ok = Decimal("0.8") <= ratio <= Decimal("1.25")
            premium_bps = float((ratio - 1) * 10_000)
            cost_bps = float((1 - sf * close / uf) * 10_000) if side == "BUY" else float((1 - uf / (sf * close)) * 10_000)
        tolerance_bps = min(300.0, max(30.0, 2 * max(impact_bps, 0.0) + 20.0))
        return {"impact_bps": round(impact_bps, 2), "premium_bps": None if premium_bps is None else round(premium_bps, 1),
                "cost_bps": None if cost_bps is None else round(cost_bps, 1), "tolerance_bps": round(tolerance_bps, 1),
                "presign_ok": impact_bps <= 150.0, "ratio_ok": ratio_ok,
                "ui_multiplier": float(full.get("stockUiMultiplier") or 1)}

    def _plan_slices(self, ticker: str, side: str, input_atoms: int, wallet: str, small: dict | None) -> dict | None:
        """Smallest slice count whose ONE slice moves the price <= SLICE_TARGET_BPS versus a tiny reference quote."""
        who = wallet if side == "SELL" else None
        if not small or not small.get("available", True):
            small = self.chain.quote(ticker, side, max(1, input_atoms // 100), who)
        if not small.get("available"):
            return None
        u0, s0 = self._usdc_and_shares(side, small)
        ref = u0 / s0
        for n in SLICE_COUNTS:
            each = input_atoms // n
            if each <= 0:
                break
            q = self.chain.quote(ticker, side, each, who)
            if not q.get("available"):
                continue
            u, s = self._usdc_and_shares(side, q)
            p = u / s
            impact = float((p / ref - 1) * 10_000) if side == "BUY" else float((1 - p / ref) * 10_000)
            if impact <= SLICE_TARGET_BPS:
                tol = min(300.0, max(30.0, 2 * max(impact, 0.0) + 20.0))
                inputs = [each] * (n - 1) + [input_atoms - each * (n - 1)]
                rate = Decimal(small["expectedOutAtoms"]) / Decimal(small["inputAtoms"])   # atoms out per atom in, pre-trade
                expected = [int(Decimal(i) * rate) for i in inputs]
                mins = [int(Decimal(e) * (1 - Decimal(str(tol)) / 10_000)) for e in expected]
                return {"count": n, "interval_minutes": SLICE_INTERVAL_MIN, "slice_inputs": [str(i) for i in inputs],
                        "slice_min_outs": [str(m) for m in mins], "expected_outs": [str(e) for e in expected],
                        "slice_impact_bps": round(impact, 1), "tolerance_bps": round(tol, 1), "first_quote": q, "small_quote": small}
        return None

    def positions(self, wallet: str, brief_id: str) -> dict[str, int]:
        """Net token atoms this strategy (brief) holds, from its filled receipts."""
        pos: dict[str, int] = {}
        rows = self.db.all("SELECT r.body FROM receipts r JOIN plans p ON p.plan_id = r.plan_id "
                           "WHERE r.wallet = ? AND json_extract(p.body, '$.brief_id') = ? ORDER BY r.created_at", (wallet, brief_id))
        for r in rows:
            for x in json.loads(r["body"])["results"]:
                if x["status"] != "filled":
                    continue
                if x["side"] == "BUY" and x.get("received_atoms"):
                    pos[x["ticker"]] = pos.get(x["ticker"], 0) + int(x["received_atoms"])
                elif x["side"] == "SELL":
                    pos[x["ticker"]] = pos.get(x["ticker"], 0) - int(x["input_atoms"])
        return pos

    # ------------------------------------------------------------- build
    def build(self, run: dict, brief: dict, wallet: str) -> dict:
        report = run.get("report") or run  # ResearchRunner.get() returns the report fields flattened into the run
        fx = brief["fx_krw_per_usdc"]
        budget = int(brief["budget_usdc_atoms"])
        weights = report["target"]["weights"]
        universe = self.universe_fn()
        tickers = sorted(weights)
        try:
            state_time = self.chain.status().get("stateTime")
        except Exception:
            state_time = None
        holdings_ok = True
        try:
            holdings = self.chain.holdings(wallet)
        except Exception:  # holdings unreadable -> blocked, never guessed
            holdings, holdings_ok = [], False
        held = {h["ticker"]: h for h in holdings if h.get("ticker") and int(h.get("amount", 0)) > 0 or h.get("ticker") == "USDC"}
        # A strategy only manages what IT bought (from its own receipts), never other strategies'
        # holdings or stocks the user bought elsewhere; the wallet balance is an upper bound.
        own = self.positions(wallet, brief["brief_id"])
        for t in [t for t in held if t != "USDC"]:
            mine = min(int(held[t]["amount"]), max(own.get(t, 0), 0))
            if mine > 0:
                held[t] = {**held[t], "amount": str(mine)}
            else:
                del held[t]
        valued = sorted(set(tickers) | {t for t in held if t != "USDC"})
        closes, as_of = self.closes_fn(run["snapshot_id"], valued, state_time)
        usdc_balance = int(held.get("USDC", {}).get("amount", 0))
        min_trade = max(krw_to_usdc_atoms(10_000, fx), budget // 100)

        orders = []
        for t in valued:
            target = int(Decimal(budget) * Decimal(str(weights.get(t, 0.0))))
            h = held.get(t)
            mult = Decimal(str(h.get("uiMultiplier") or 1)) if h else Decimal(1)
            cur_shares = Decimal(h["amount"]) / (Decimal(10) ** h["decimals"]) * mult if h else Decimal(0)
            close = closes.get(t)
            inst = universe.get(t)
            if h and not close:
                # Never drop a holding silently: without a price it cannot be valued, so the plan is blocked.
                orders.append({"ticker": t, "name_ko": i18n.stock_name(inst, t), "side": "SELL" if t not in weights else "BUY",
                               "krw": 0, "usdc_atoms": "0", "input_atoms": "0",
                               "route": {"available": False, "backend": self.chain.network, "reason": tr("route.no_close")}})
                continue
            current = int(cur_shares * close * USDC_UNIT) if close else 0
            diff = target - current
            if abs(diff) < min_trade:
                continue
            side = "BUY" if diff > 0 else "SELL"
            if side == "BUY":
                input_atoms = diff
            else:
                if not h or not close:
                    continue
                shares_to_sell = Decimal(-diff) / USDC_UNIT / close
                input_atoms = min(int(h["amount"]), int(shares_to_sell / mult * (Decimal(10) ** h["decimals"])))
            qp = self._quote_pair(t, side, input_atoms, wallet)
            slicing = None
            full_size_impact = None
            if qp["available"]:
                full_size_impact = self._economics(side, qp, close)["impact_bps"]
                if full_size_impact > SLICE_TRIGGER_BPS:
                    slicing = self._plan_slices(t, side, input_atoms, wallet, qp.get("small"))
            else:  # the whole amount has no route at once; small slices may still have one
                slicing = self._plan_slices(t, side, input_atoms, wallet, None)
                if slicing:
                    qp = {"available": True, "full": slicing["first_quote"], "small": slicing["small_quote"]}
            order = {"ticker": t, "name_ko": i18n.stock_name(inst, t), "side": side,
                     "krw": usdc_atoms_to_krw(diff if side == "BUY" else -diff, fx),
                     "usdc_atoms": str(input_atoms if side == "BUY" else -diff), "input_atoms": str(input_atoms),
                     "route": {"available": qp["available"], "backend": self.chain.network, "reason": None if qp["available"] else tr("route.none"),
                               "reason_detail": qp.get("reason")}}
            if qp["available"]:
                full = qp["full"]
                if slicing:
                    # Cost and tolerance are those of ONE slice. Every slice's minimum is set at the pre-trade price,
                    # so a slice only lands once the pool has come back near it.
                    econ = self._economics(side, {"full": slicing["first_quote"], "small": slicing["small_quote"]}, close)
                    econ["tolerance_bps"] = slicing["tolerance_bps"]
                    econ["presign_ok"] = True
                    expected = sum(int(x) for x in slicing["expected_outs"])
                    min_out = sum(int(x) for x in slicing["slice_min_outs"])
                    order["slicing"] = {k: slicing[k] for k in ("count", "interval_minutes", "slice_inputs", "slice_min_outs",
                                                                "expected_outs", "slice_impact_bps", "tolerance_bps")}
                    order["slicing"]["full_size_impact_bps"] = full_size_impact  # None: no route for the whole amount at once
                    if full_size_impact is not None:
                        # 지금 한 번에: the same order at full size, kept as the user's alternative to waiting.
                        ie = self._economics(side, qp, close)        # qp is still the quote for the whole amount
                        i_expected = int(full["expectedOutAtoms"])
                        order["immediate"] = {
                            "expected_out_atoms": str(i_expected),
                            "min_out_atoms": str(int(Decimal(i_expected) * (1 - Decimal(str(ie["tolerance_bps"])) / 10_000))),
                            "cost_bps": ie["cost_bps"], "impact_bps": ie["impact_bps"], "tolerance_bps": ie["tolerance_bps"]}
                else:
                    econ = self._economics(side, qp, close)
                    expected = int(full["expectedOutAtoms"])
                    min_out = int(Decimal(expected) * (1 - Decimal(str(econ["tolerance_bps"])) / 10_000))
                product = next((p for p in getattr(inst, "products", ()) if p.get("mint") in (full["outputMint"], full["inputMint"])), None)
                order.update({
                    "route": {**order["route"], "route_id": full["routeId"], "venue": full["venue"]},
                    "product": product or {"mint": full["outputMint"] if side == "BUY" else full["inputMint"], "issuer": None, "verified": False},
                    "quote": {"expected_out_atoms": str(expected), "min_out_atoms": str(min_out), "out_decimals": full["outputDecimals"],
                              "in_decimals": full["inputDecimals"],
                              "cost_bps": econ["cost_bps"], "premium_bps": econ["premium_bps"], "impact_bps": econ["impact_bps"],
                              "tolerance_bps": econ["tolerance_bps"], "presign_ok": econ["presign_ok"], "quoted_at": full["quotedAt"],
                              "ui_multiplier": econ["ui_multiplier"], "ratio_ok": econ["ratio_ok"],
                              "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=self.s.quote_ttl_seconds)).isoformat()},
                    "close_usd": str(close) if close else None,
                })
            orders.append(order)

        buys = sum(int(o["input_atoms"]) for o in orders if o["side"] == "BUY")
        lights, reasons = self._lights(brief, orders, universe, budget, usdc_balance, buys, holdings_ok)
        mkt = market.status()
        if not mkt["open"]:
            for light in lights:
                if light["id"] == "premium" and light["status"] == "pass":
                    light.update(status="warn", detail_ko=light["detail_ko"] + tr("light.premium.closed"))
        first_time = self.db.one("SELECT 1 FROM plans WHERE wallet = ? AND status IN ('submitted','presigned','done') AND json_extract(body,'$.brief_id') = ?",
                                 (wallet, brief["brief_id"])) is None
        big = any(Decimal(str(weights.get(o["ticker"], 0))) >= Decimal(brief["max_weight"]) * Decimal("0.8") for o in orders)
        if any(l["status"] == "fail" for l in lights):
            tier = "blocked"
        elif any(l["status"] == "warn" for l in lights) or first_time or big:
            tier = "careful"
        else:
            tier = "fast"
        cost_usdc = sum(int(Decimal(o["input_atoms"]) * Decimal(str(o["quote"]["cost_bps"] or 0)) / 10_000)
                        for o in orders if o.get("quote") and o["side"] == "BUY")
        cash_after = budget - buys
        plan_core = {"wallet": wallet, "brief_id": brief["brief_id"], "brief_version": brief["version"], "run_id": run["run_id"],
                     "spec_hash": run["spec_hash"], "snapshot_id": run["snapshot_id"],
                     "orders": [{"ticker": o["ticker"], "side": o["side"], "input_atoms": o["input_atoms"],
                                 "min_out_atoms": o.get("quote", {}).get("min_out_atoms"), "route_id": o["route"].get("route_id"),
                                 **({"slice_min_outs": o["slicing"]["slice_min_outs"]} if o.get("slicing") else {}),
                                 **({"immediate_min_out_atoms": o["immediate"]["min_out_atoms"]} if o.get("immediate") else {})}
                                for o in orders],
                     "created_at": now_iso()}
        plan_hash = hashlib.sha256(dumps(plan_core).encode()).hexdigest()
        plan_id = new_id("p")
        immediate = self._immediate(orders, fx, cost_usdc) if tier != "blocked" else None
        plan = {
            "plan_id": plan_id, "plan_hash": plan_hash, "lang": i18n.lang(), "run_id": run["run_id"], "brief_id": brief["brief_id"], "brief_version": brief["version"],
            "wallet": wallet, "orders": orders, "headline_ko": self._headline(orders, fx),
            "cash_after_krw": usdc_atoms_to_krw(max(cash_after, 0), fx), "cost_krw_est": usdc_atoms_to_krw(cost_usdc, fx),
            "fx_krw_per_usdc": fx, "prices_as_of": as_of, "chain_state_time": state_time, "market": mkt, "lights": lights, "tier": tier,
            "blocked_reasons_ko": reasons, "mode_options": self._modes(orders, tier, immediate), "atomic": True,
            "immediate": immediate,
            # the public demo chain's market simulator restores a pool within about 20 seconds, so 1 minute is enough there
            "slice_interval_options": ([1] if self.s.mode == "demo" else []) + list(SLICE_INTERVAL_OPTIONS) if immediate else None,
            # up to 4 settlements per transaction; with slicing, one transaction per time round
            "tx_count": (max(o["slicing"]["count"] for o in orders if o.get("slicing")) if any(o.get("slicing") for o in orders)
                         else max(1, -(-len([o for o in orders if o.get("quote")]) // 4))),
            "slicing_note_ko": self._slicing_note(orders),
            "wallet_preview": self._preview(orders), "core": plan_core, "status": "shown",
        }
        plan["claims"] = self._claims(plan) if tier != "blocked" else []
        self.db.execute("INSERT INTO plans(plan_id, plan_hash, run_id, wallet, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                        (plan_id, plan_hash, run["run_id"], wallet, dumps(plan), "shown", now_iso(), now_iso()))
        if tier == "blocked":
            self.ledger.append("plan.blocked", tr("ledger.plan.blocked", reasons="; ".join(reasons)[:120]), wallet=wallet, ref=plan_id,
                               payload={"plan_hash": plan_hash, "reasons": reasons, "lights": lights})
        else:
            self.ledger.append("plan.created", plan["headline_ko"], wallet=wallet, ref=plan_id,
                               payload={"plan_hash": plan_hash, "tier": tier, "orders": plan_core["orders"]})
        return plan

    def _lights(self, brief, orders, universe, budget, usdc_balance, buys, holdings_ok):
        reasons: list[str] = []
        lights = []
        allowed = set(brief["universe"]["tickers"]) - set(brief["universe"].get("exclude", []))
        outside = [o["ticker"] for o in orders if o["side"] == "BUY" and o["ticker"] not in allowed]
        cash_min = int(Decimal(budget) * Decimal(brief["min_cash"]))
        rule_problems = []
        if outside:
            rule_problems.append(tr("rule.outside", names=i18n.join(outside)))
        if buys > budget - cash_min + budget // 1000:
            rule_problems.append(tr("rule.cash"))
        if buys > usdc_balance:
            rule_problems.append(tr("rule.usdc"))
        lev = [o["ticker"] for o in orders if brief.get("exclude_leveraged") and getattr(universe.get(o["ticker"]), "kind", "") == "leveraged_etf"]
        if lev:
            rule_problems.append(tr("rule.leveraged", names=i18n.join(lev)))
        lights.append(check("rules", tr("light.rules"), "fail" if rule_problems else "pass",
                            " ".join(rule_problems) if rule_problems else tr("light.rules.ok")))
        reasons += rule_problems
        lights.append(check("holdings", tr("light.holdings"), "pass" if holdings_ok else "fail",
                            tr("light.holdings.ok") if holdings_ok else tr("light.holdings.fail")))
        if not holdings_ok:
            reasons.append(tr("reason.holdings"))
        no_buy = [o["name_ko"] for o in orders if not o["route"]["available"] and o["side"] == "BUY"]
        no_sell = [o["name_ko"] for o in orders if not o["route"]["available"] and o["side"] == "SELL"]
        unverified = [o["name_ko"] for o in orders if o.get("product") and o["product"].get("verified") is False]
        unit_mismatch = [o["name_ko"] for o in orders if o.get("quote") and o["quote"].get("ratio_ok") is False]
        prod_problem = []
        if unit_mismatch:
            prod_problem.append(tr("prod.unit", names=i18n.join(unit_mismatch)))
        if no_buy:
            prod_problem.append(tr("prod.no_buy", names=i18n.join(no_buy)))
        if no_sell:
            prod_problem.append(tr("prod.no_sell", names=i18n.join(no_sell)))
        if unverified:
            prod_problem.append(tr("prod.unverified", names=i18n.join(unverified)))
        lights.append(check("product", tr("light.product"), "fail" if prod_problem else "pass",
                            " ".join(prod_problem) if prod_problem else tr("light.product.ok")))
        reasons += prod_problem
        prem = [o["quote"]["premium_bps"] for o in orders if o.get("quote") and o["quote"]["premium_bps"] is not None]
        worst_p = max((abs(p) for p in prem), default=0.0)
        p_status = "fail" if worst_p > self.s.premium_block_bps else "warn" if worst_p > self.s.premium_warn_bps else "pass"
        lights.append(check("premium", tr("light.premium"), p_status if prem else "warn",
                            tr("light.premium.detail", p=f"{worst_p/100:.2f}") if prem else tr("light.premium.none")))
        if p_status == "fail":
            reasons.append(tr("reason.premium", p=f"{worst_p/100:.1f}"))
        costs = [o["quote"]["cost_bps"] for o in orders if o.get("quote") and o["quote"]["cost_bps"] is not None]
        worst_c = max(costs, default=0.0)
        c_status = "fail" if worst_c > self.s.cost_block_bps else "warn" if worst_c > self.s.cost_warn_bps else "pass"
        lights.append(check("cost", tr("light.cost"), c_status if costs else "warn",
                            tr("light.cost.detail", c=f"{worst_c/100:.2f}") if costs else tr("light.cost.none")))
        if c_status == "fail":
            reasons.append(tr("reason.cost", c=f"{worst_c/100:.1f}"))
        lights.append(check("quote", tr("light.quote"), "pass" if all(o.get("quote") for o in orders if o["route"]["available"]) else "fail",
                            tr("light.quote.detail", sec=self.s.quote_ttl_seconds)))
        if not orders:
            lights = [check("rules", tr("light.rules"), "pass", tr("light.rules.nothing"))]
        return lights, reasons

    @staticmethod
    def _headline(orders, fx) -> str:
        buys = [o for o in orders if o["side"] == "BUY"]
        sells = [o for o in orders if o["side"] == "SELL"]
        parts = []
        if buys:
            parts.append(tr("headline.buy", n=len(buys), amount=i18n.money(sum(o["krw"] for o in buys), fx)))
        if sells:
            parts.append(tr("headline.sell", n=len(sells), amount=i18n.money(sum(o["krw"] for o in sells), fx)))
        return " · ".join(parts) or tr("headline.none")

    @staticmethod
    def _modes(orders, tier, immediate=None) -> list[str]:
        if tier == "blocked" or not orders:
            return []
        if any(o.get("slicing") for o in orders):
            # 나눠 사기 is the default; buying the thin stock in one go is offered only with its extra cost shown
            return ["slice", "now"] if immediate and immediate["available"] else ["slice"]
        modes = ["now", "notify"]
        if all(o.get("quote", {}).get("presign_ok") for o in orders):
            modes.insert(1, "presign")
        return modes

    @staticmethod
    def _preview(orders) -> list[dict]:
        """What the wallet will show: one USDC line in total, one line per stock token (share-equivalent aware)."""
        lines, usdc_out, usdc_in_min = [], Decimal(0), Decimal(0)
        for o in orders:
            q = o.get("quote")
            if not q:
                continue
            if o["side"] == "BUY":
                usdc_out += Decimal(o["input_atoms"]) / USDC_UNIT
                amount = Decimal(q["min_out_atoms"]) / (Decimal(10) ** q["out_decimals"])
                note = tr("preview.split", n=o["slicing"]["count"]) if o.get("slicing") else ""
                lines.append({"label": tr("preview.token", name=o["name_ko"], note=note), "delta": tr("preview.min", x=f"{amount:,.4f}")})
            else:
                amount = Decimal(o["input_atoms"]) / (Decimal(10) ** q.get("in_decimals", 8))
                usdc_in_min += Decimal(q["min_out_atoms"]) / (Decimal(10) ** q["out_decimals"])
                note = tr("preview.split", n=o["slicing"]["count"]) if o.get("slicing") else ""
                lines.append({"label": tr("preview.token", name=o["name_ko"], note=note), "delta": f"-{amount:,.4f}"})
        if usdc_out:
            lines.insert(0, {"label": "USDC", "delta": f"-{usdc_out:,.2f}"})
        if usdc_in_min:
            lines.append({"label": "USDC", "delta": tr("preview.min", x=f"{usdc_in_min:,.2f}")})
        rounds = max((o["slicing"]["count"] for o in orders if o.get("slicing")), default=0)
        if rounds:
            title = tr("preview.title.slice", n=rounds)
        else:
            title = tr("preview.title.one")
        return [{"step": 1, "title": title, "lines": lines}]

    @staticmethod
    def immediate_orders(orders) -> list[dict]:
        """The plan's orders as they would go out in one go: sliced orders at full size with the full-size minimum."""
        out = []
        for o in orders:
            if o.get("slicing") and o.get("immediate"):
                im = o["immediate"]
                o = {**{k: v for k, v in o.items() if k not in ("slicing", "immediate")},
                     "quote": {**o["quote"], **{k: im[k] for k in ("expected_out_atoms", "min_out_atoms", "cost_bps", "impact_bps", "tolerance_bps")}}}
            out.append(o)
        return out

    def _immediate(self, orders, fx, plan_cost_usdc) -> dict | None:
        """지금 한 번에: what skipping 나눠 사기 costs, and whether it is allowed at all."""
        thin = [o for o in orders if o.get("slicing")]
        if not thin:
            return None
        sides = {o["side"] for o in thin}
        kind = "BUY" if sides == {"BUY"} else "SELL" if sides == {"SELL"} else "MIX"
        verbs = {"verb": tr(f"verb.{kind}"), "verb_if": tr(f"verb.{kind}"), "ger": tr(f"ger.{kind}"), "stem": tr(f"stem.{kind}")}
        no_route = [o["name_ko"] for o in thin if not o.get("immediate")]
        costs = [o["immediate"]["cost_bps"] for o in thin if o.get("immediate") and o["immediate"]["cost_bps"] is not None]
        worst = max(costs, default=None)
        too_costly = [o["name_ko"] for o in thin if o.get("immediate") and (o["immediate"]["cost_bps"] or 0) > self.s.cost_block_bps]
        extra = Decimal(0)
        for o in thin:
            im, q = o.get("immediate"), o.get("quote") or {}
            if im and im["cost_bps"] is not None and q.get("cost_bps") is not None:
                notional = Decimal(o["usdc_atoms"])
                extra += notional * Decimal(str(im["cost_bps"] - q["cost_bps"])) / 10_000
        extra_krw = max(usdc_atoms_to_krw(int(extra), fx), 0)
        out = {"available": not no_route and not too_costly, "requires_ack": True, "tickers": [o["ticker"] for o in thin],
               "worst_cost_bps": worst, "extra_cost_krw": extra_krw,
               "cost_krw_est": usdc_atoms_to_krw(max(plan_cost_usdc + int(extra), 0), fx),
               "status": "warn" if worst is not None and worst > self.s.cost_warn_bps else "pass",
               "reason_ko": None, "note_ko": None, "wallet_preview": None, "tx_count": None}
        if no_route:
            out["reason_ko"] = tr("imm.no_route", names=topic(i18n.join(no_route)), **verbs)
        elif too_costly:
            out["reason_ko"] = tr("imm.too_costly", names=obj(i18n.join(too_costly)), c=f"{worst/100:.1f}", **verbs)
        else:
            imm = self.immediate_orders(orders)
            out["wallet_preview"] = self._preview(imm)
            out["tx_count"] = max(1, -(-len([o for o in imm if o.get("quote")]) // 4))
            cost_txt = tr("imm.cost", c=f"{worst/100:.2f}") if worst is not None else ""
            if extra_krw > 0:
                out["note_ko"] = tr("imm.note_extra", extra=i18n.money(extra_krw, fx), cost=cost_txt, **verbs)
            else:
                out["note_ko"] = tr("imm.note_same", cost=cost_txt, **verbs)
        return out

    @staticmethod
    def _slicing_note(orders) -> str | None:
        parts = []
        for o in orders:
            sl = o.get("slicing")
            if sl:
                parts.append(tr("slice.part", name=topic(o["name_ko"]), n=sl["count"], done=tr(f"slice.done.{o['side']}")))
        if not parts:
            return None
        return tr("slice.join").join(parts) + tr("slice.tail")

    def immediate_claims(self, plan) -> list[dict]:
        """The user chose 지금 한 번에: the per-slice predictions no longer describe what will happen. They are voided
        (kept, not deleted) and replaced by the full-size predictions the plan hash already commits to."""
        tickers = set(plan["immediate"]["tickers"])
        for c in self.claims.for_plan(plan["plan_id"]):
            if c["subject"] in tickers and c["verdict"] is None:
                self.claims.void(c["claim_id"], tr("claim.void.immediate"))
        imm = [o for o in self.immediate_orders(plan["orders"]) if o["ticker"] in tickers]
        return self._claims(plan, imm)

    def _claims(self, plan, orders=None) -> list[dict]:
        out = []
        for o in plan["orders"] if orders is None else orders:
            q = o.get("quote")
            if not q:
                continue
            name = o["name_ko"]
            if q["cost_bps"] is not None:
                c = q["cost_bps"]  # positive = worse than the stock price for the user
                worse = c > 0          # BUY: paid more than the stock price; SELL: received less
                direction = ("higher" if worse else "lower") if o["side"] == "BUY" else ("lower" if worse else "higher")
                out.append(self.claims.add(wallet=plan["wallet"], plan_id=plan["plan_id"], subject=o["ticker"], metric="cost_bps",
                                           predicted=c, tolerance=max(15.0, abs(c) * 0.3), unit="bps",
                                           statement_ko=tr(f"claim.cost.{o['side']}", name=topic(name), c=f"{abs(c)/100:.2f}",
                                                           dir=tr(f"claim.dir.{direction}"))))
            out.append(self.claims.add(wallet=plan["wallet"], plan_id=plan["plan_id"], subject=o["ticker"], metric="received_atoms",
                                       predicted=float(q["min_out_atoms"]), tolerance=0.0, unit="atoms>=",
                                       statement_ko=tr(f"claim.min.{o['side']}", name=name)))
        return out
