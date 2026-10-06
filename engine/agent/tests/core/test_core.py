import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from xtxc_agent.core import market
from xtxc_agent.core.claims import Claims
from xtxc_agent.core.config import Settings
from xtxc_agent.core.db import Database
from xtxc_agent.core.kiln import Kiln, ModelOutputInvalid, extract_json
from xtxc_agent.core.ledger import Ledger, merkle_root
from xtxc_agent.core.orders import krw_to_usdc_atoms, usdc_atoms_to_krw, won
from xtxc_agent.core.prompts import fill, validate_brief, validate_sentences


@pytest.fixture()
def db(tmp_path: Path) -> Database:
    return Database(tmp_path / "t.db")


def settings(tmp_path: Path) -> Settings:
    return Settings(db_path=tmp_path / "t.db", kiln_base_url="https://example.invalid/v1", kiln_model="qwen3-32b", kiln_api_key="x")


# ----------------------------------------------------------------- ledger
def test_ledger_chain_detects_tampering(db):
    ledger = Ledger(db)
    for i in range(5):
        ledger.append("test", f"event {i}", wallet="W", payload={"i": i})
    assert ledger.verify_chain()["ok"]
    db.execute("UPDATE events SET summary_ko = 'rewritten' WHERE seq = 3")
    broken = ledger.verify_chain()
    assert broken["ok"] is False and broken["broken_at"] == 3


def test_day_root_changes_when_history_changes(db):
    ledger = Ledger(db)
    for i in range(3):
        ledger.append("test", f"e{i}")
    day = ledger.today()
    root = ledger.day_root(day)["root"]
    ledger.record_seal(day, ledger.day_root(day), "sig", "local")
    assert ledger.seal(day)["matches"]
    db.execute("DELETE FROM events WHERE seq = 2")
    assert ledger.day_root(day)["root"] != root
    assert ledger.seal(day)["matches"] is False


def test_merkle_root_odd_and_empty():
    a, b, c = ("aa" * 32, "bb" * 32, "cc" * 32)
    assert merkle_root([a, b, c]) != merkle_root([a, b])
    assert len(merkle_root([])) == 64


# ---------------------------------------------------------------- prompts
def test_explanations_reject_digits_outside_placeholders():
    allowed = {"total_return_xtxc", "years"}
    ok = validate_sentences({"sentences": ["{years} 동안 {total_return_xtxc} 올랐어요.", "과거 계산이에요."]}, "sentences", allowed, 2, 3)
    assert fill(ok, {"years": "5년", "total_return_xtxc": "+81%"})[0] == "5년 동안 +81% 올랐어요."
    with pytest.raises(ValueError, match="digits"):
        validate_sentences({"sentences": ["5년 동안 81% 올랐어요.", "과거 계산이에요."]}, "sentences", allowed, 2, 3)
    with pytest.raises(ValueError, match="placeholders"):
        validate_sentences({"sentences": ["{sharpe}가 좋아요.", "과거예요."]}, "sentences", allowed, 2, 3)


def test_brief_validator_rejects_untradable_tickers_and_bad_ranges():
    base = {"budget_krw": 3_000_000, "sectors": ["semiconductors"], "tickers": [], "exclude": [], "max_weight": "0.25",
            "min_cash": "0.2", "rebalance": None, "template": None, "exclude_leveraged": None, "questions": []}
    out = validate_brief(base, {"NVDA", "AMD"}, {"semiconductors"})
    assert out["min_cash"] == "0.2"
    with pytest.raises(ValueError, match="not tradable"):
        validate_brief({**base, "tickers": ["ASML"]}, {"NVDA"}, {"semiconductors"})
    with pytest.raises(ValueError, match="max_weight"):
        validate_brief({**base, "max_weight": "1.5"}, {"NVDA"}, {"semiconductors"})
    with pytest.raises(ValueError, match="keys"):
        validate_brief({**base, "extra": 1}, {"NVDA"}, {"semiconductors"})


def test_extract_json_handles_fences():
    assert extract_json('\n\n```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('prefix {"a": 2} suffix') == {"a": 2}


# ------------------------------------------------------------------ kiln
def _resp(content: str, prompt=100, completion=50, cost=0.00002):
    return {"choices": [{"message": {"content": content}}],
            "usage": {"prompt_tokens": prompt, "completion_tokens": completion, "cost": cost,
                      "completion_tokens_details": {"reasoning_tokens": 0}, "prompt_tokens_details": {"cached_tokens": 10}}}


def test_kiln_repairs_then_caches_and_accounts(tmp_path, db):
    calls = []

    def transport(body):
        calls.append(body)
        assert body["chat_template_kwargs"] == {"enable_thinking": False}
        return _resp("not json" if len(calls) == 1 else '```json\n{"v": 1}\n```')

    k = Kiln(settings(tmp_path), db, transport)
    msgs = [{"role": "user", "content": "hi"}]
    r1 = k.complete_json("flow", msgs, lambda a: a if a.get("v") == 1 else (_ for _ in ()).throw(ValueError("bad")))
    assert r1.value == {"v": 1} and not r1.cache_hit and len(calls) == 2
    assert r1.usage["input_tokens"] == 200 and r1.usage["output_tokens"] == 100
    r2 = k.complete_json("flow", msgs, lambda a: a)
    assert r2.cache_hit and len(calls) == 2
    usage = k.usage()
    flow = usage["flows"][0]
    assert flow["calls"] == 2 and flow["cache_hits"] == 1 and flow["input_tokens"] == 200


def test_kiln_cache_hits_when_validator_reshapes_the_answer(tmp_path, db):
    calls = []

    def transport(body):
        calls.append(body)
        return _resp('{"sentences": ["과거 계산이에요.", "{years} 동안이에요."]}')

    k = Kiln(settings(tmp_path), db, transport)
    msgs = [{"role": "user", "content": "facts"}]
    check = lambda a: validate_sentences(a, "sentences", {"years"}, 1, 3)   # returns a list, not the dict
    first = k.complete_json("report_explain", msgs, check)
    second = k.complete_json("report_explain", msgs, check)
    assert first.value == second.value and second.cache_hit and len(calls) == 1


def test_kiln_gives_up_after_bounded_repairs(tmp_path, db):
    k = Kiln(settings(tmp_path), db, lambda body: _resp("still not json"))
    with pytest.raises(ModelOutputInvalid):
        k.complete_json("flow", [{"role": "user", "content": "x"}], lambda a: a, repair_attempts=1)
    row = db.one("SELECT attempts, outcome FROM ai_calls")
    assert row["attempts"] == 2 and row["outcome"].startswith("INVALID")


# ---------------------------------------------------------------- claims
def test_claims_two_sided_and_one_sided(db):
    c = Claims(db)
    cost = c.add(wallet="W", plan_id="p", subject="NVDA", metric="cost_bps", predicted=40, tolerance=15, unit="bps", statement_ko="비용 0.40%")
    qty = c.add(wallet="W", plan_id="p", subject="NVDA", metric="received_atoms", predicted=100, tolerance=0, unit="atoms>=", statement_ko="최소 수량")
    miss = c.add(wallet="W", plan_id="p", subject="MSFT", metric="cost_bps", predicted=10, tolerance=5, unit="bps", statement_ko="비용 0.10%")
    assert c.resolve(cost["claim_id"], 50)["verdict"] == "hit"
    assert c.resolve(qty["claim_id"], 130)["verdict"] == "hit"
    assert c.resolve(miss["claim_id"], 40)["verdict"] == "miss"
    card = c.scorecard("W")
    assert card["total"] == 3 and card["hits"] == 2 and card["misses"][0]["subject"] == "MSFT"


# ------------------------------------------------------------ market/fx
def test_market_hours_and_holidays():
    ny_open = datetime(2026, 9, 29, 14, 0, tzinfo=timezone.utc)      # 10:00 EDT Tuesday
    assert market.status(ny_open)["open"]
    labor_day = datetime(2026, 9, 7, 15, 0, tzinfo=timezone.utc)
    assert not market.status(labor_day)["open"]
    kst_afternoon = datetime(2026, 9, 29, 5, 0, tzinfo=timezone.utc)  # 14:00 KST, 01:00 EDT
    s = market.status(kst_afternoon)
    assert not s["open"] and s["next_open_kst"].startswith("2026-09-29T22:30")


def test_money_conversions():
    atoms = krw_to_usdc_atoms(3_000_000, "1390")
    assert atoms == 2_158_273_381
    assert usdc_atoms_to_krw(atoms, "1390") == 3_000_000
    assert won(1_860_000) == "186만 원" and won(9_600) == "9,600원"
