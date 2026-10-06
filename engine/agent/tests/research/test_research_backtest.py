import math

import numpy as np
import pandas as pd
import pytest
from research_testlib import synthetic_prices

from xtxc_agent.research import backtest as bt


def test_metrics_known_answers_constant_growth():
    r, n = 0.001, 504
    eq = 100 * (1 + r) ** np.arange(n + 1)
    m = bt.compute_metrics(eq)
    assert m["total_return"] == pytest.approx((1 + r) ** n - 1, rel=1e-12)
    assert m["cagr"] == pytest.approx((1 + r) ** 252 - 1, rel=1e-12)
    assert m["max_drawdown"] == 0.0
    assert m["volatility"] == pytest.approx(0.0, abs=1e-12)


def test_metrics_known_answers_drawdown_vol_sharpe():
    eq = np.array([100.0, 120.0, 90.0, 150.0])
    m = bt.compute_metrics(eq)
    assert m["max_drawdown"] == pytest.approx(90 / 120 - 1)
    assert m["total_return"] == pytest.approx(0.5)
    # alternating +a / -a daily returns: mean known, sample std known
    a = 0.01
    rets = np.array([a, -a] * 126)
    eq = 100 * np.concatenate([[1.0], np.cumprod(1 + rets)])
    m = bt.compute_metrics(eq)
    sd = math.sqrt(np.sum((rets - rets.mean()) ** 2) / (len(rets) - 1))
    assert m["volatility"] == pytest.approx(sd * math.sqrt(252), rel=1e-9)
    assert m["sharpe"] == pytest.approx(rets.mean() / sd * math.sqrt(252), abs=1e-9)
    assert m["total_return"] == pytest.approx((1 + a) ** 126 * (1 - a) ** 126 - 1, rel=1e-9)


def _single_asset(n=60, g=0.01):
    idx = pd.bdate_range("2024-01-01", periods=n)
    return pd.DataFrame({"ONE": 100 * (1 + g) ** np.arange(n)}, index=idx)


@pytest.mark.parametrize("bps", [0.0, 5.0, 100.0])
def test_backtest_known_answer_single_asset(bps):
    prices = _single_asset()
    spec = {"template": "equal_weight", "universe": ["ONE"], "max_weight": "1", "min_cash": "0",
            "rebalance": "weekly", "period": {"start": "2024-01-01"}, "benchmark": "ONE"}
    res = bt.simulate(spec, prices, {"default_bps": bps})
    eq = np.array([v for _, v in res["equity"]])
    # signal at close of day 0, bought at close of day 1 (so day 1's +1% is missed), then +1%/day
    expected_final = 100 / (1 + bps / 1e4) * 1.01 ** (len(prices) - 2)
    assert eq[0] == 100.0 and eq[1] == pytest.approx(100 / (1 + bps / 1e4), rel=1e-9)
    assert eq[-1] == pytest.approx(expected_final, rel=1e-6)
    assert res["trades"] == 1
    assert res["benchmark"][0][1] == 100.0
    assert res["benchmark"][-1][1] == pytest.approx(100 * 1.01 ** (len(prices) - 1), rel=1e-6)


def test_execution_is_next_close_not_signal_close():
    # price jumps +50% on the day after the first signal: a same-close execution would capture it.
    idx = pd.bdate_range("2024-01-01", periods=10)
    px = np.array([100, 100, 150, 150, 150, 150, 150, 150, 150, 150], dtype=float)
    prices = pd.DataFrame({"ONE": px}, index=idx)
    spec = {"template": "equal_weight", "universe": ["ONE"], "max_weight": "1", "min_cash": "0",
            "rebalance": "weekly", "period": {"start": "2024-01-01"}}
    res = bt.simulate(spec, prices, {"default_bps": 0.0})
    eq = [v for _, v in res["equity"]]
    assert eq[1] == 100.0  # bought at day-1 close (100) -> no gain yet
    assert eq[2] == pytest.approx(150.0)
    spec["period"] = {"start": "2024-01-02"}  # signal day 1 -> bought at day 2's close (150) -> misses the jump
    res = bt.simulate(spec, prices, {"default_bps": 0.0})
    assert [v for _, v in res["equity"]][-1] == pytest.approx(100.0)


def test_cost_monotonicity_synthetic():
    prices = synthetic_prices(n_days=600)
    spec = {"template": "momentum", "universe": list(prices.columns), "max_weight": "0.25", "min_cash": "0.2",
            "rebalance": "weekly", "period": {"years": 2}}
    rets = [bt.simulate(spec, prices, {"default_bps": b})["metrics"]["total_return"] for b in (0, 1, 5, 20, 50, 100, 300)]
    assert all(x >= y for x, y in zip(rets, rets[1:]))
    assert rets[0] > rets[-1]


def test_cost_monotonicity_real_data(real_snapshot_id, semis_spec):
    rets = []
    for b in (0.0, 5.0, 25.0, 100.0, 200.0):
        res = bt.run_backtest(semis_spec, real_snapshot_id, {"default_bps": b, "per_ticker_bps": {}})
        rets.append(res["metrics"]["total_return"])
    assert all(x >= y for x, y in zip(rets, rets[1:]))
    # per-ticker override raises cost for that name only -> still <= default-only run
    hi = bt.run_backtest(semis_spec, real_snapshot_id, {"default_bps": 5.0, "per_ticker_bps": {"NVDA": 300.0}})
    assert hi["metrics"]["total_return"] <= rets[1]


def test_result_shape_and_invariants(real_snapshot_id, semis_spec):
    res = bt.run_backtest(semis_spec, real_snapshot_id, {"default_bps": 5.0, "per_ticker_bps": {}})
    for key in ("equity", "benchmark", "weights", "trades", "turnover", "metrics", "holdout_start"):
        assert key in res
    assert set(res["metrics"]) == {"total_return", "cagr", "max_drawdown", "volatility", "sharpe", "turnover",
                                   "exposure", "trades"}
    assert res["equity"][0][1] == 100.0 and res["benchmark"][0][1] == 100.0
    assert [d for d, _ in res["equity"]] == [d for d, _ in res["benchmark"]]
    dates = [d for d, _ in res["equity"]]
    assert res["holdout_start"] == dates[-252]
    assert res["metrics"]["max_drawdown"] <= 0
    for _, w in res["weights"]:
        assert all(0 < v <= 0.25 for v in w.values()) and sum(w.values()) <= 0.8
    # exposure is measured end-of-day, so price drift between rebalances can push it a bit above 0.8
    assert 0.5 < res["metrics"]["exposure"] < 1.0
    assert res["holdout_metrics"]["total_return"] is not None
    # five years ending at the snapshot's as-of date
    start, end = pd.Timestamp(dates[0]), pd.Timestamp(dates[-1])
    assert 4.95 < (end - start).days / 365.25 <= 5.0
    curve = bt.report_curve(res)
    assert len(curve["dates"]) <= 260 and curve["strategy"][0] == 100.0 and curve["dates"][-1] == dates[-1]


def test_cost_model_validation():
    with pytest.raises(ValueError):
        bt.normalize_cost_model({"default_bps": -1})
    assert bt.normalize_cost_model({"per_ticker_bps": {"nvda": 3}}) == {"default_bps": 5.0,
                                                                         "per_ticker_bps": {"NVDA": 3.0}}


# ------------------------------------------------------------------------------------------------
# no-trade band.  golden_pre_band.json was produced by the pre-band engine (same code minus the band)
# on 2026-09-28: band = 0 must reproduce it bit for bit.

import hashlib  # noqa: E402
import json  # noqa: E402
from pathlib import Path  # noqa: E402

GOLDEN = json.loads((Path(__file__).parent / "golden_pre_band.json").read_text())


def _with_band(spec, band):
    return {**spec, "params": {**(spec.get("params") or {}), "band": band}}


def _assert_same_as_golden(res, g):
    assert hashlib.sha256(json.dumps(res["equity"]).encode()).hexdigest() == g["equity_sha256"]
    assert res["equity"][-1][1] == g["final"]
    # Keep the entire published equity curve byte-exact above. Derived float64
    # reductions can differ by a few ULPs across libm/CPU implementations; 1e-12
    # is eight orders below one basis point, not an economic-error allowance.
    assert res["metrics"] == pytest.approx(g["metrics"], rel=1e-12, abs=1e-12)
    assert res["turnover"] == pytest.approx(g["turnover"], rel=1e-12, abs=1e-12)
    assert res["costs_paid"] == pytest.approx(g["costs_paid"], rel=1e-12, abs=1e-12)
    assert res["trades"] == g["trades"]


def test_golden_tolerance_does_not_hide_an_economic_change():
    g = GOLDEN["synthetic"]["equal_weight_weekly_100bps"]
    res = bt.simulate(_with_band(g["spec"], 0), synthetic_prices(n_days=600), g["cost_model"])
    # A one-basis-point summary error is still rejected, without needing a
    # changed curve to catch it. Transaction counts stay exactly integral.
    res["metrics"]["total_return"] += 0.0001
    with pytest.raises(AssertionError):
        _assert_same_as_golden(res, g)


@pytest.mark.parametrize("name", sorted(GOLDEN["synthetic"]))
def test_band_zero_reproduces_pre_band_results_synthetic(name):
    g = GOLDEN["synthetic"][name]
    res = bt.simulate(_with_band(g["spec"], 0), synthetic_prices(n_days=600), g["cost_model"])
    _assert_same_as_golden(res, g)


def test_band_zero_reproduces_pre_band_results_real():
    from xtxc_agent.research import marketdata as md

    sid = GOLDEN["real_snapshot_id"]
    if not (md.data_dir() / "snapshots" / f"{sid}.json").exists():
        pytest.skip("golden snapshot not present")
    px = md.load_prices(sid)
    for name, g in GOLDEN["real"].items():
        _assert_same_as_golden(bt.simulate(_with_band(g["spec"], "0"), px, g["cost_model"], snapshot_id=sid), g)


def _check_band_invariants(res, spec, band, tol=1e-3):
    max_w, min_cash = float(spec["max_weight"]), float(spec["min_cash"])
    assert len(res["held_weights"]) == len(res["weights"]) == len(res["held_cash"])
    for (d, held), (d2, tgt), (d3, cash) in zip(res["held_weights"], res["weights"], res["held_cash"]):
        assert d == d2 == d3
        assert set(held) == set(tgt)  # entering / leaving names are always traded
        for t, w in held.items():
            assert abs(w - tgt[t]) <= band + tol  # tol: costs shift post-trade weights slightly
            assert w <= max_w + band + tol
        assert tgt == {} or all(v <= max_w for v in tgt.values())
        assert cash >= min_cash - band - tol and cash >= 0.0


@pytest.mark.parametrize("band", ["0.005", "0.02", "0.05"])
def test_band_lowers_turnover_and_keeps_caps_synthetic(band):
    prices = synthetic_prices(n_days=600)
    for template in ("momentum", "low_vol", "equal_weight"):
        spec = {"template": template, "universe": list(prices.columns), "max_weight": "0.25", "min_cash": "0.2",
                "rebalance": "weekly", "period": {"years": 2}}
        base = bt.simulate(_with_band(spec, 0), prices, {"default_bps": 20.0})
        res = bt.simulate(_with_band(spec, band), prices, {"default_bps": 20.0})
        assert res["turnover"] <= base["turnover"]
        assert res["costs_paid"] <= base["costs_paid"]
        assert res["trades"] <= base["trades"]
        assert res["band"] == {"0.005": "0.005", "0.02": "0.02", "0.05": "0.05"}[band]
        _check_band_invariants(res, spec, float(band))


def test_band_lowers_turnover_real_data(real_snapshot_id, semis_spec):
    base = bt.run_backtest(_with_band(semis_spec, 0), real_snapshot_id, {"default_bps": 5.0})
    res = bt.run_backtest(semis_spec, real_snapshot_id, {"default_bps": 5.0})  # default band 0.02
    assert res["band"] == "0.02" and base["band"] == "0"
    assert res["turnover"] <= base["turnover"] and res["costs_paid"] <= base["costs_paid"]
    assert res["band_skipped"] > 0
    _check_band_invariants(res, semis_spec, 0.02)


def test_band_cash_floor_guard_trims_overweights():
    # four names bought at 0.2 each; all jump +20% -> each ~0.207 (inside the band) but invested ~0.828
    # > 1 - 0.2 + 0.02: the guard must trim the largest overweights (two of them) back to target.
    idx = pd.bdate_range("2024-01-01", periods=15)
    px = np.where(np.arange(15)[:, None] < 2, 100.0, 120.0) * np.ones((15, 4))
    prices = pd.DataFrame(px, index=idx, columns=["A", "B", "C", "D"])
    spec = {"template": "equal_weight", "universe": ["A", "B", "C", "D"], "max_weight": "0.25", "min_cash": "0.2",
            "rebalance": "weekly", "period": {"start": "2024-01-01"}}
    res = bt.simulate(_with_band(spec, "0.02"), prices, {"default_bps": 0.0})
    assert res["trades"] == 4 + 2
    held_after = dict(res["held_weights"])["2024-01-08"]
    assert held_after["A"] == pytest.approx(0.2) and held_after["B"] == pytest.approx(0.2)
    assert held_after["C"] == pytest.approx(0.24 / 1.16) and held_after["D"] == pytest.approx(0.24 / 1.16)
    assert dict(res["held_cash"])["2024-01-08"] >= 0.2 - 0.02
    assert bt.simulate(_with_band(spec, 0), prices, {"default_bps": 0.0})["trades"] == 4 + 4
