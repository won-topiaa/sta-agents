import copy

import pytest

from xtxc_agent.research import backtest as bt
from xtxc_agent.research import evaluator as ev
from xtxc_agent.research import strategies as st
from xtxc_agent.research.marketdata import load_snapshot

IDS = ["leakage", "costs", "holdout", "survivorship", "attempts"]


@pytest.fixture(scope="module")
def runs(real_snapshot_id):
    spec = {"template": "momentum", "params": {}, "universe": ["NVDA", "AMD", "AVGO", "TSM", "MU", "MRVL", "INTC"],
            "max_weight": "0.25", "min_cash": "0.20", "rebalance": "weekly", "exclude_leveraged": True}
    u = bt.run_backtest(spec, real_snapshot_id, {"default_bps": 5.0, "per_ticker_bps": {}})
    x = bt.run_backtest(spec, real_snapshot_id, {"default_bps": 100.0, "per_ticker_bps": {}})
    return spec, load_snapshot(real_snapshot_id), u, x


@pytest.mark.parametrize("template", st.TEMPLATES)
def test_no_lookahead_perturbation_on_real_data(real_prices, template):
    universe = ["NVDA", "AMD", "AVGO", "TSM", "MU", "MRVL", "INTC", "SPCX", "CRCL", "TQQQ", "QQQ"]
    spec = {"template": template, "universe": universe, "max_weight": "0.25", "min_cash": "0.2", "rebalance": "weekly"}
    if template == "custom":      # an AI-style design, with the market risk-off rule reading QQQ
        spec["params"] = {"design": {"score": [{"signal": "momentum", "lookback": 126, "skip": 21, "weight": 1},
                                               {"signal": "volatility", "lookback": 63, "weight": -0.5}],
                                     "filters": [{"signal": "trend", "lookback": 100, "rule": "above", "value": 0}], "top_n": None,
                                     "weighting": "rank", "risk_off": {"ticker": "QQQ", "signal": "trend", "lookback": 200, "below": 0,
                                                                       "exposure": 0.5}}}
    res = ev.leakage_test(spec, real_prices, n_dates=8)
    assert res["passed"], res["failures"]
    assert len(res["dates_tested"]) == 16 and all(x["same"] for x in res["dates_tested"])
    assert res["backtest_dates_tested"] and all(x["same_equity_through_date"] for x in res["backtest_dates_tested"])


def test_leakage_test_catches_a_leaky_strategy(real_prices, monkeypatch):
    real_tw = st.target_weights

    def leaky(spec, prices, i):  # peeks 5 rows ahead
        return real_tw(spec, prices, min(i + 5, len(prices) - 1))

    monkeypatch.setattr(ev, "target_weights", leaky)
    spec = {"template": "momentum", "universe": ["NVDA", "AMD", "AVGO", "TSM", "MU", "MRVL", "INTC"],
            "max_weight": "0.25", "min_cash": "0.2", "rebalance": "weekly"}
    res = ev.leakage_test(spec, real_prices, n_dates=6, n_backtest_dates=0)
    assert not res["passed"]


def test_evaluate_shape_and_verdict(runs):
    spec, snap, u, x = runs
    out = ev.evaluate(spec, snap, u, x, attempts=1)
    assert [c["id"] for c in out["checks"]] == IDS
    for c in out["checks"]:
        assert set(c) == {"id", "label_ko", "status", "detail_ko"}
        assert c["status"] in ("pass", "warn", "fail") and c["label_ko"] and c["detail_ko"]
    by = {c["id"]: c for c in out["checks"]}
    assert by["leakage"]["status"] == "pass"
    assert by["costs"]["status"] == "pass"
    assert by["survivorship"]["status"] == "warn"
    assert by["attempts"]["status"] == "pass"
    assert out["verdict"] == "warn"  # survivorship always warns
    assert ev.evaluate(spec, snap.snapshot_id, u, x, attempts=11)["checks"][4]["status"] == "warn"


def test_zero_cost_fails(runs):
    spec, snap, u, x = runs
    free = bt.run_backtest(spec, snap.snapshot_id, {"default_bps": 0.0, "per_ticker_bps": {}})
    out = ev.evaluate(spec, snap, free, x, attempts=1)
    assert out["checks"][1]["status"] == "fail" and out["verdict"] == "fail"
    partly_free = bt.run_backtest(spec, snap.snapshot_id, {"default_bps": 100.0, "per_ticker_bps": {"NVDA": 0.0}})
    assert ev.evaluate(spec, snap, u, partly_free, attempts=1)["checks"][1]["status"] == "fail"


def test_holdout_warns_when_benchmark_wins(runs):
    spec, snap, u, x = runs
    x2 = copy.deepcopy(x)
    x2["holdout_metrics"]["total_return"] = x2["benchmark_holdout_metrics"]["total_return"] - 0.01
    out = ev.evaluate(spec, snap, u, x2, attempts=1)
    assert out["checks"][2]["status"] == "warn"
    assert "나스닥100 ETF(QQQ)" in out["checks"][2]["detail_ko"]
