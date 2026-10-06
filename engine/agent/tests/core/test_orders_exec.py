"""Planner / Executor rules against a fake chain (no validator, no model)."""
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest

from xtxc_agent.core.claims import Claims
from xtxc_agent.core.config import Settings
from xtxc_agent.core.db import Database, dumps, now_iso
from xtxc_agent.core.execution import ExecutionError, Executor
from xtxc_agent.core.ledger import Ledger
from xtxc_agent.core.orders import Planner

CLOSE = {"AAA": Decimal("100"), "BBB": Decimal("50"), "OTH": Decimal("10")}


class FakeChain:
    network = "local"

    def __init__(self, premium=0.0, holdings=None, depth=None):
        self.premium = premium          # token price vs close
        self.depth = depth or {}        # ticker -> USDC atoms of pool depth (price impact = size / depth)
        self.recovered = True           # whether the pool is back at the reference price
        self.holdings_rows = holdings or []
        self.submitted = []
        self.fail_group = None
        self.released = []

    def status(self):
        return {"stateTime": now_iso()}

    def quote(self, ticker, side, input_atoms, wallet=None):
        px = CLOSE[ticker] * Decimal(1 + self.premium)
        if ticker in self.depth:
            px *= 1 + Decimal(input_atoms) / Decimal(self.depth[ticker])
        if side == "BUY":
            out = int(Decimal(input_atoms) / Decimal(10**6) / px * Decimal(10**8))
            ind, outd = 6, 8
        else:
            out = int(Decimal(input_atoms) / Decimal(10**8) * px * Decimal(10**6))
            ind, outd = 8, 6
        return {"available": True, "routeId": f"{ticker}:{side}", "venue": "fake", "inputAtoms": str(input_atoms),
                "expectedOutAtoms": str(out), "inputDecimals": ind, "outputDecimals": outd, "stockUiMultiplier": 1.0,
                "outputMint": f"mint-{ticker}", "inputMint": f"mint-{ticker}", "quotedAt": now_iso(), "stateTime": now_iso(), "network": "local"}

    def holdings(self, wallet):
        return [{"ticker": "USDC", "amount": str(10_000 * 10**6), "decimals": 6}] + self.holdings_rows

    def prepare(self, wallet, orders, plan_hash, mode, deadline_seconds=None):
        indexed = [dict(o, index=i) for i, o in enumerate(orders)]
        rounds = sorted({o.get("round", 0) for o in indexed})
        groups = []
        for r in rounds:
            members = [o for o in indexed if o.get("round", 0) == r]
            groups += [members[:2], members[2:]] if len(members) > 2 else [members]
        self.last_prepared = groups
        return {"network": "local", "genesis": "g", "transactions": [
            {"transaction": f"unsigned-{i}", "orders": [{"ticker": o["routeId"].split(":")[0], "outputAccount": "x", "index": o["index"],
                                                        "input": o["input"], "minOut": o["minOut"]} for o in g],
             "nonceAccount": f"nonce-{i}" if mode == "presign" else None, "deadlineSlot": "1", "bytes": 500} for i, g in enumerate(groups)]}

    def verify(self, unsigned, signed):
        return {"bytesMatch": signed == unsigned.replace("unsigned", "signed"), "signatureValid": True, "payer": "W", "addedInstructions": [],
                "recentBlockhashChanged": False}

    def submit(self, signed, preflight=True):
        self.submitted.append(signed)
        i = int(signed.split("-")[1])
        if self.fail_group == i:
            return {"ok": False, "landed": True, "signature": f"sig{i}", "error": {"name": "MIN_OUT"}, "orders": []}
        return {"ok": True, "landed": True, "signature": f"sig{i}", "memo": "Memo", "orders": []}

    def simulate(self, signed):
        return {"pass": self.recovered}

    def cancel_tx(self, wallet):
        return {"transaction": "cancel", "nonceAccounts": ["nonce-0"]}

    def release(self, nonces):
        self.released += nonces

    def devnet_status(self):
        return {"enabled": False}


def setup(tmp_path, chain, weights=None):
    s = Settings(db_path=tmp_path / "t.db")
    db = Database(s.db_path)
    ledger, claims = Ledger(db), Claims(db)
    universe = {t: SimpleNamespace(name_ko=t, products=({"mint": f"mint-{t}", "issuer": "x"},), kind="common") for t in CLOSE}
    planner = Planner(s, db, ledger, claims, chain, lambda: universe, lambda sid, tickers, at=None: ({t: CLOSE[t] for t in tickers if t in CLOSE}, "2026-09-18"))
    ex = Executor(s, db, ledger, claims, chain, planner, None)
    brief = {"brief_id": "b1", "version": 1, "fx_krw_per_usdc": "1000", "budget_usdc_atoms": str(4000 * 10**6),
             "universe": {"tickers": ["AAA", "BBB"], "exclude": []}, "min_cash": "0.1", "max_weight": "0.5", "exclude_leveraged": True}
    db.execute("INSERT INTO briefs(brief_id, version, wallet, status, body, created_at) VALUES ('b1',1,'W','confirmed',?,?)", (dumps(brief), now_iso()))
    run = {"run_id": "r1", "snapshot_id": "s", "spec_hash": "h", "report": {"target": {"weights": weights or {"AAA": 0.45, "BBB": 0.45}}}}
    db.execute("INSERT INTO runs(run_id, brief_id, brief_version, status, created_at, report) VALUES ('r1','b1',1,'done',?,?)", (now_iso(), dumps({"title_ko": "t"})))
    return db, planner, ex, brief, run


def test_plan_buys_and_ignores_other_strategies_holdings(tmp_path):
    chain = FakeChain(holdings=[{"ticker": "OTH", "amount": str(5 * 10**8), "decimals": 8, "uiMultiplier": 1.0}])
    db, planner, ex, brief, run = setup(tmp_path, chain)
    plan = planner.build(run, brief, "W")
    assert {o["ticker"] for o in plan["orders"]} == {"AAA", "BBB"}          # OTH belongs to nobody here
    assert all(o["side"] == "BUY" for o in plan["orders"]) and plan["tier"] in ("fast", "careful")
    assert plan["tx_count"] == 1 and "presign" in plan["mode_options"]


def test_large_premium_blocks_the_plan(tmp_path):
    db, planner, ex, brief, run = setup(tmp_path, FakeChain(premium=0.03))
    plan = planner.build(run, brief, "W")
    assert plan["tier"] == "blocked" and plan["mode_options"] == []
    assert any("원주식과" in r for r in plan["blocked_reasons_ko"])
    with pytest.raises(ExecutionError):
        ex.prepare(plan["plan_id"], "now", None)


def test_tampered_signature_is_rejected_and_nothing_is_sent(tmp_path):
    chain = FakeChain()
    db, planner, ex, brief, run = setup(tmp_path, chain)
    plan = planner.build(run, brief, "W")
    prep = ex.prepare(plan["plan_id"], "now", None)
    out = ex.submit(plan["plan_id"], ["tampered-0"] * len(prep["transactions"]))
    assert out["status"] == "rejected" and chain.submitted == []
    assert db.one("SELECT COUNT(*) n FROM events WHERE type = 'plan.signature_mismatch'")["n"] == 1


def test_failed_group_stops_later_groups(tmp_path):
    chain = FakeChain()
    db, planner, ex, brief, run = setup(tmp_path, chain, weights={"AAA": 0.3, "BBB": 0.3, "OTH": 0.3})
    brief["universe"]["tickers"] = ["AAA", "BBB", "OTH"]
    db.execute("UPDATE briefs SET body = ? WHERE brief_id = 'b1'", (dumps(brief),))
    plan = planner.build(run, brief, "W")
    prep = ex.prepare(plan["plan_id"], "now", None)
    assert len(prep["transactions"]) == 2
    chain.fail_group = 0
    out = ex.submit(plan["plan_id"], [t.replace("unsigned", "signed") for t in prep["transactions"]])
    assert chain.submitted == ["signed-0"]                                   # group 1 never sent
    statuses = {r["ticker"]: r["status"] for r in out["receipt"]["results"]}
    assert set(statuses.values()) <= {"failed", "cancelled"} and "cancelled" in statuses.values()


def test_presigned_order_expires_and_releases_nonce(tmp_path):
    chain = FakeChain()
    db, planner, ex, brief, run = setup(tmp_path, chain)
    plan = planner.build(run, brief, "W")
    deadline = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    prep = ex.prepare(plan["plan_id"], "presign", {"market_open": True, "deadline": deadline})
    ex.submit(plan["plan_id"], [t.replace("unsigned", "signed") for t in prep["transactions"]])
    ex.market_override = False
    assert ex.watch_once() == [] and chain.submitted == []                  # market closed: waits
    row = db.one("SELECT body FROM prepared WHERE status = 'presigned_waiting'")
    body = json.loads(row["body"])
    body["condition"]["deadline"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    db.execute("UPDATE prepared SET body = ? WHERE status = 'presigned_waiting'", (dumps(body),))
    actions = ex.watch_once()
    assert actions[0]["action"] == "expired" and chain.submitted == [] and chain.released == ["nonce-0"]
    assert "signed" not in json.loads(db.one("SELECT body FROM prepared")["body"])["transactions"][0]


def test_stop_drops_stored_signatures(tmp_path):
    chain = FakeChain()
    db, planner, ex, brief, run = setup(tmp_path, chain)
    plan = planner.build(run, brief, "W")
    prep = ex.prepare(plan["plan_id"], "presign", {"market_open": True})
    ex.submit(plan["plan_id"], [t.replace("unsigned", "signed") for t in prep["transactions"]])
    out = ex.stop_all("W")
    assert out["transactions"] == ["cancel"] and len(out["cancelled"]) == 1
    assert "signed" not in json.loads(db.one("SELECT body FROM prepared")["body"])["transactions"][0]
    ex.market_override = True
    assert ex.watch_once() == [] and chain.submitted == []


def test_thin_pool_is_sliced_and_slices_wait_for_price_recovery(tmp_path):
    # AAA: 120,000 USDC depth -> 1,800 USDC at once moves the price ~1.5% (5 slices: ~0.3% each); BBB is deep.
    chain = FakeChain(depth={"AAA": 120_000 * 10**6})
    db, planner, ex, brief, run = setup(tmp_path, chain)
    plan = planner.build(run, brief, "W")
    aaa = next(o for o in plan["orders"] if o["ticker"] == "AAA")
    sl = aaa["slicing"]
    assert sl["count"] >= 2 and sl["slice_impact_bps"] <= 30 and plan["mode_options"] == ["slice", "now"]
    assert sum(int(x) for x in sl["slice_inputs"]) == int(aaa["input_atoms"])
    assert plan["slicing_note_ko"] and plan["tx_count"] == sl["count"]
    deadline = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
    prep = ex.prepare(plan["plan_id"], "slice", {"deadline": deadline})
    assert prep["groups"][0]["not_before_min"] == 0 and prep["groups"][1]["not_before_min"] == 20   # round 0 now, round 1 later
    ex.submit(plan["plan_id"], [t.replace("unsigned", "signed") for t in prep["transactions"]])
    first = ex.watch_once()
    assert first[0]["action"] == "progress" and first[0]["groups_sent"] == [0]     # round 0 (BBB + AAA slice 1); later rounds not due
    body = json.loads(db.one("SELECT body FROM prepared WHERE status = 'presigned_waiting'")["body"])
    body["started_at"] = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()   # all slices now due
    db.execute("UPDATE prepared SET body = ? WHERE status = 'presigned_waiting'", (dumps(body),))
    chain.recovered = False                                                          # pool has not come back yet
    assert ex.watch_once() == [] and len(chain.submitted) == 1
    waiting = json.loads(db.one("SELECT body FROM prepared WHERE status = 'presigned_waiting'")["body"])["last_wait"]
    assert "돌아오지" in waiting["reason_ko"]
    body = json.loads(db.one("SELECT body FROM prepared WHERE status = 'presigned_waiting'")["body"])
    body["condition"]["deadline"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    db.execute("UPDATE prepared SET body = ? WHERE status = 'presigned_waiting'", (dumps(body),))
    closed = ex.watch_once()
    assert closed[0]["action"] == "expired_partial"
    receipt = json.loads(db.one("SELECT body FROM receipts")["body"])
    by = {r["ticker"]: r for r in receipt["results"]}
    assert by["BBB"]["status"] == "filled" and by["AAA"]["status"] == "partial"
    assert by["AAA"]["slices"] == {"total": sl["count"], "filled": 1}
    assert set(chain.released) >= {f"nonce-{i}" for i in range(1, sl["count"])}


def test_slices_all_land_when_price_recovers(tmp_path):
    chain = FakeChain(depth={"AAA": 120_000 * 10**6})
    db, planner, ex, brief, run = setup(tmp_path, chain)
    plan = planner.build(run, brief, "W")
    prep = ex.prepare(plan["plan_id"], "slice", {})
    ex.submit(plan["plan_id"], [t.replace("unsigned", "signed") for t in prep["transactions"]])
    ex.watch_once()
    body = json.loads(db.one("SELECT body FROM prepared WHERE status = 'presigned_waiting'")["body"])
    body["started_at"] = (datetime.now(timezone.utc) - timedelta(hours=5)).isoformat()
    db.execute("UPDATE prepared SET body = ? WHERE status = 'presigned_waiting'", (dumps(body),))
    assert body["condition"]["deadline_default"] is True and body["condition"]["deadline"]   # 12h default is explicit
    done = ex.watch_once()
    assert done[0]["action"] == "submitted"
    receipt = json.loads(db.one("SELECT body FROM receipts")["body"])
    aaa = next(r for r in receipt["results"] if r["ticker"] == "AAA")
    assert aaa["status"] == "filled" and aaa["slices"]["filled"] == aaa["slices"]["total"]
    slice_events = db.all("SELECT summary_ko FROM events WHERE type = 'order.slice' ORDER BY seq")
    assert len(slice_events) == aaa["slices"]["total"] and "1/" in slice_events[0]["summary_ko"]   # round 1 is logged too
    assert "분 간격" not in plan["slicing_note_ko"]                                                  # interval is the user's choice


def test_thin_pool_can_be_bought_at_once_after_the_extra_cost_is_acknowledged(tmp_path):
    chain = FakeChain(depth={"AAA": 120_000 * 10**6})          # whole AAA order moves the price ~1.5%
    db, planner, ex, brief, run = setup(tmp_path, chain)
    plan = planner.build(run, brief, "W")
    im = plan["immediate"]
    assert plan["mode_options"] == ["slice", "now"] and im["available"] and im["tickers"] == ["AAA"]
    assert im["extra_cost_krw"] > 0 and im["status"] == "warn" and "더 들어요" in im["note_ko"] and im["tx_count"] == 1
    assert plan["core"]["orders"][0].get("immediate_min_out_atoms") or plan["core"]["orders"][1].get("immediate_min_out_atoms")
    with pytest.raises(ExecutionError, match="추가 비용 확인"):
        ex.prepare(plan["plan_id"], "now", {})
    prep = ex.prepare(plan["plan_id"], "now", {"accept_extra_cost": True})
    assert len(prep["transactions"]) == 1 and prep["preview"] == im["wallet_preview"]
    aaa = next(o for o in chain.last_prepared[0] if o["routeId"].startswith("AAA"))
    plan_aaa = next(o for o in plan["orders"] if o["ticker"] == "AAA")
    assert aaa["input"] == plan_aaa["input_atoms"] and aaa["minOut"] == plan_aaa["immediate"]["min_out_atoms"]
    out = ex.submit(plan["plan_id"], [t.replace("unsigned", "signed") for t in prep["transactions"]])
    assert out["status"] == "submitted"
    claims = [c for c in ex.claims.for_plan(plan["plan_id"]) if c["subject"] == "AAA"]
    voided = [c for c in claims if c["verdict"] == "void"]
    scored_cost = [c for c in claims if c["metric"] == "cost_bps" and c["verdict"] in ("hit", "miss")]
    assert len(voided) == 2 and len(scored_cost) == 1
    assert abs(scored_cost[0]["predicted"] - plan_aaa["immediate"]["cost_bps"]) < 1e-6
    ev = db.one("SELECT summary_ko FROM events WHERE type = 'plan.prepared'")["summary_ko"]
    assert "지금 한 번에" in ev


def test_buying_at_once_is_refused_when_it_would_cost_too_much(tmp_path):
    chain = FakeChain(depth={"AAA": 80_000 * 10**6})           # at once ~2.2% (> 2% block); 8 slices ~0.26% each
    db, planner, ex, brief, run = setup(tmp_path, chain)
    plan = planner.build(run, brief, "W")
    assert plan["mode_options"] == ["slice"] and plan["immediate"]["available"] is False
    assert "막아 두었어요" in plan["immediate"]["reason_ko"] and "첫 조각은 바로" in plan["immediate"]["reason_ko"]
    with pytest.raises(ExecutionError, match="막아 두었어요"):
        ex.prepare(plan["plan_id"], "now", {"accept_extra_cost": True})


def test_slice_interval_can_be_shortened(tmp_path):
    chain = FakeChain(depth={"AAA": 120_000 * 10**6})
    db, planner, ex, brief, run = setup(tmp_path, chain)
    plan = planner.build(run, brief, "W")
    assert plan["slice_interval_options"] == [5, 10, 20]
    with pytest.raises(ExecutionError, match="조각 간격"):
        ex.prepare(plan["plan_id"], "slice", {"interval_minutes": 7})
    prep = ex.prepare(plan["plan_id"], "slice", {"interval_minutes": 5})
    assert [g["not_before_min"] for g in prep["groups"]][:3] == [0, 5, 10]


def test_demo_fast_forward_makes_the_next_slice_due_and_is_recorded(tmp_path):
    chain = FakeChain(depth={"AAA": 120_000 * 10**6})
    db, planner, ex, brief, run = setup(tmp_path, chain)
    plan = planner.build(run, brief, "W")
    prep = ex.prepare(plan["plan_id"], "slice", {"interval_minutes": 5})
    ex.submit(plan["plan_id"], [t.replace("unsigned", "signed") for t in prep["transactions"]])
    assert ex.watch_once()[0]["groups_sent"] == [0]
    assert ex.watch_once() == []                                   # round 1 is 5 minutes away
    moved = ex.fast_forward("W")
    assert len(moved) == 1 and moved[0]["group"] == 1 and 250 <= moved[0]["seconds"] <= 300
    assert ex.watch_once()[0]["groups_sent"] == [1]                # due now, price is back -> sent
    assert ex.fast_forward("someone-else") == []
    ev = db.one("SELECT summary_ko FROM events WHERE type = 'demo.fast_forward'")["summary_ko"]
    assert "시연 도구" in ev and "앞당겼어요" in ev


def test_demo_mode_offers_a_one_minute_slice_interval(tmp_path):
    chain = FakeChain(depth={"AAA": 120_000 * 10**6})
    db, planner, ex, brief, run = setup(tmp_path, chain)
    planner.s = Settings(db_path=tmp_path / "t.db", mode="demo")
    assert planner.build(run, brief, "W")["slice_interval_options"] == [1, 5, 10, 20]


def test_orders_signed_for_a_restarted_chain_expire_and_never_block_others(tmp_path):
    chain = FakeChain(depth={"AAA": 120_000 * 10**6})
    db, planner, ex, brief, run = setup(tmp_path, chain)
    plan = planner.build(run, brief, "W")
    prep = ex.prepare(plan["plan_id"], "slice", {"interval_minutes": 5})
    ex.submit(plan["plan_id"], [t.replace("unsigned", "signed") for t in prep["transactions"]])
    ex.watch_once()                                                       # round 0 lands on chain "g"
    chain.status = lambda: {"stateTime": now_iso(), "genesis": "g-restarted"}
    out = ex.watch_once()
    assert out[0]["action"] == "expired_partial"                          # the landed slice gets its receipt; the rest never goes
    receipt = json.loads(db.one("SELECT body FROM receipts")["body"])
    aaa = next(r for r in receipt["results"] if r["ticker"] == "AAA")
    assert aaa["status"] == "partial" and aaa["slices"]["filled"] == 1


def test_one_broken_order_does_not_stop_the_watcher(tmp_path):
    chain = FakeChain(depth={"AAA": 120_000 * 10**6})
    db, planner, ex, brief, run = setup(tmp_path, chain)
    plan = planner.build(run, brief, "W")
    prep = ex.prepare(plan["plan_id"], "slice", {})
    ex.submit(plan["plan_id"], [t.replace("unsigned", "signed") for t in prep["transactions"]])
    ex.watch_once()
    body = json.loads(db.one("SELECT body FROM prepared WHERE status = 'presigned_waiting'")["body"])
    body["started_at"] = (datetime.now(timezone.utc) - timedelta(hours=5)).isoformat()
    db.execute("UPDATE prepared SET body = ? WHERE status = 'presigned_waiting'", (dumps(body),))

    def boom(signed):
        raise RuntimeError("address table account doesn't exist")
    chain.simulate = boom
    out = ex.watch_once()
    assert out and out[0]["action"] == "error"
    assert db.one("SELECT COUNT(*) n FROM events WHERE type = 'watcher.error'")["n"] == 1


def test_seal_is_verified_on_devnet_when_the_local_chain_was_restarted(tmp_path):
    chain = FakeChain()
    db, planner, ex, brief, run = setup(tmp_path, chain)
    planner.build(run, brief, "W")                                     # some events to seal
    devnet = {}
    chain.seal = lambda memo: {"signature": "local-sig", "network": "local"}
    chain.devnet_status = lambda: {"enabled": True}
    chain.devnet_record = lambda memo: devnet.setdefault("dsig", memo) and {"signature": "dsig", "network": "devnet"}
    chain.devnet_memo = lambda sig: devnet.get(sig)
    chain.memo_of = lambda sig: None                                   # the local copy is gone (demo chain restarted)
    day = now_iso()[:10]
    ex.seal_day(day)
    v = ex.verify_seal(day)
    assert v["sealed"] and v["matches"] and v["chain_matches"] and v["parts"][0]["verified_on"] == "devnet"
    db.execute("UPDATE events SET summary_ko = 'tampered' WHERE seq = 1")  # editing a record breaks the hash chain
    assert ex.verify_seal(day)["chain_ok"]["ok"] is False
    db.execute("UPDATE events SET hash = '0000000000000000000000000000000000000000000000000000000000000000' WHERE seq = 1")           # rewriting its hash changes the sealed root
    v = ex.verify_seal(day)
    assert v["matches"] is False and v["chain_matches"] is False
