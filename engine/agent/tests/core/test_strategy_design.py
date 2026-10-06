"""AI 전략 설계: the model designs, code validates, the isolated runner compares on the earlier years, checks follow."""
import json
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from xtxc_agent.core.config import Settings
from xtxc_agent.core.db import Database
from xtxc_agent.core.kiln import ModelOutputInvalid, ModelResult
from xtxc_agent.core.ledger import Ledger
from xtxc_agent.core.research_runner import ResearchRunner
from xtxc_agent.core.strategy_design import choose, describe, design_checks, validate_candidates

TICKERS = ["AAA", "BBB", "CCC", "DDD", "EEE"]
GOOD = [
    {"name": "추세 따라가기", "idea": "오르는 종목을 따라가되 시장이 약하면 덜 담아요.",
     "design": {"score": [{"signal": "momentum", "lookback": 126, "skip": 21, "weight": 1}], "filters": [], "top_n": 3,
                "weighting": "equal", "risk_off": {"ticker": "QQQ", "signal": "trend", "lookback": 100, "below": 0, "exposure": 0.5}}},
    {"name": "덜 흔들리는 종목", "idea": "흔들림이 작은 종목에 더 담아요. 급등장에서는 뒤처질 수 있어요.",
     "design": {"score": [{"signal": "volatility", "lookback": 63, "weight": -1}], "filters": [], "top_n": None,
                "weighting": "inverse_volatility", "risk_off": None}},
]


class Kiln:
    def __init__(self, answers):
        self.answers, self.calls = list(answers), []

    def complete_json(self, flow, messages, validate, **kw):
        self.calls.append((flow, messages))
        for a in list(self.answers):
            self.answers.remove(a)
            try:
                return ModelResult(validate(a), f"call-{len(self.calls)}", False, {"input_tokens": 1500, "output_tokens": 600})
            except ValueError:
                continue
        raise ModelOutputInvalid("no valid answer")


def _prices(n=1500, seed=5):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2019-01-01", periods=n)
    cols = TICKERS + ["QQQ", "SPY"]
    return pd.DataFrame({t: 40 * np.exp(np.cumsum(rng.normal(0.0003, 0.012 + 0.003 * i, n))) for i, t in enumerate(cols)}, index=idx)


def test_candidates_must_be_blocks_with_wordy_names():
    ok = validate_candidates({"candidates": GOOD})["candidates"]
    assert [c["name"] for c in ok] == ["추세 따라가기", "덜 흔들리는 종목"] and all(len(c["design_hash"]) == 64 for c in ok)
    for bad in ({"candidates": [{**GOOD[0], "name": "6개월 추세"}]},                         # digits belong to code
                {"candidates": [{**GOOD[0], "design": {"python": "print(1)"}}]},              # never code
                {"candidates": [{**GOOD[0], "design": {**GOOD[0]["design"], "top_n": 99}}]}):
        with pytest.raises(ValueError):
            validate_candidates(bad)
    # code drops a bad or repeated candidate and keeps the usable ones (the model is asked again only if none is left)
    mixed = validate_candidates({"candidates": [GOOD[0], GOOD[0], {**GOOD[1], "design": {**GOOD[1]["design"], "score": []}}]})
    assert [c["name"] for c in mixed["candidates"]] == ["추세 따라가기"] and [r["index"] for r in mixed["rejected"]] == [1, 2]


def test_describe_puts_every_rule_into_words():
    d = describe(GOOD[0]["design"])
    assert d["score"].startswith("6개월 수익률 (최근 1개월 제외)") and "QQQ" in d["risk_off"] and d["pick"] == "상위 3종목"


def test_choose_prefers_return_per_risk_then_simplicity():
    c = [{"design": validate_candidates({"candidates": [g]})["candidates"][0]["design"], "training": {"sharpe": s}} for g, s in zip(GOOD, (0.8, 0.8))]
    assert choose(c) == 1                                                                     # equal: the simpler design
    c[0]["training"]["sharpe"] = 0.95
    assert choose(c) == 0


def test_design_checks_flag_luck_and_fragility():
    chosen = {"training": {"sharpe": 1.2}}
    good = design_checks(chosen, {"holdout_metrics": {"sharpe": 0.9}, "metrics": {"sharpe": 1.0}}, [{"sharpe": 0.8}, {"sharpe": 1.1}], 3)
    assert [c["status"] for c in good] == ["pass", "pass", "pass"]
    bad = design_checks(chosen, {"holdout_metrics": {"sharpe": -0.2}, "metrics": {"sharpe": 1.0}}, [{"sharpe": 0.1}, {"sharpe": 1.1}], 3)
    assert [c["id"] for c in bad] == ["design", "selection", "robustness"] and [c["status"] for c in bad] == ["pass", "warn", "warn"]


def test_the_runner_designs_isolates_and_records(tmp_path):
    prices = _prices()
    settings = Settings(db_path=tmp_path / "t.db", data_dir=tmp_path / "data")
    db = Database(settings.db_path)
    ledger = Ledger(db)
    kiln = Kiln([{"candidates": [{**GOOD[0], "idea": "숫자 3개"}]}, {"candidates": GOOD}])    # first answer is repaired
    research = SimpleNamespace(universe=SimpleNamespace(load_universe=lambda: [SimpleNamespace(ticker=t, sector="big_tech") for t in TICKERS]),
                               marketdata=SimpleNamespace(load_prices=lambda sid: prices))
    runner = ResearchRunner(settings, db, ledger, kiln, None, research)
    runner._step = lambda *a, **k: None
    brief = {"source_text": "AI가 알아서 전략을 짜 줘", "rebalance": "monthly", "max_weight": "0.35", "min_cash": "0.1", "wallet": "W"}
    spec = {"template": "equal_weight", "params": {}, "universe": TICKERS, "max_weight": "0.35", "min_cash": "0.1", "rebalance": "monthly",
            "exclude_leveraged": True}
    new_spec, design = runner._design("r_1", brief, spec, SimpleNamespace(snapshot_id="snap"), {"default_bps": 10}, {t: t for t in TICKERS})
    assert new_spec["template"] == "custom" and new_spec["params"]["design"] == design["candidates"][design["chosen"]]["design"]
    assert all(c["training"]["sharpe"] is not None for c in design["candidates"])
    assert design["training_period"]["end"] < design["holdout_start"]                            # the last year was not used to choose
    assert design["isolation"][0]["mode"] == "process" and design["isolation"][0]["task"] == "training"
    res = runner._isolated_backtest(new_spec, prices, {"default_bps": 10}, "snap", design)
    variants = runner._robustness(new_spec, prices, {"default_bps": 10}, "snap", design)
    assert res["latest_target"]["weights"] and len(variants) == 2 and [x["task"] for x in design["isolation"]] == ["training", "backtest", "robustness"]
    ev = json.loads(db.one("SELECT payload FROM events WHERE type = 'strategy.designed'")["payload"])
    assert ev["chosen"] == design["chosen"] and len(ev["designs"]) == 2 and len(ev["implementation"]) == 64
    assert [c[0] for c in kiln.calls] == ["strategy_design"]
