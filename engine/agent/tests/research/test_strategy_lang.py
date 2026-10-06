"""AI-designed strategies are data: validated, canonical, and evaluated with the same guarantees as the templates."""
import numpy as np
import pandas as pd
import pytest

from xtxc_agent.research import strategy_lang as sl
from xtxc_agent.research.evaluator import leakage_test
from xtxc_agent.research.strategies import normalize_spec, spec_hash, target_weights

DESIGN = {"score": [{"signal": "momentum", "lookback": 126, "skip": 21, "weight": 1}, {"signal": "volatility", "lookback": 63, "weight": -0.5}],
          "filters": [{"signal": "trend", "lookback": 100, "rule": "above", "value": 0}], "top_n": None, "weighting": "equal",
          "risk_off": {"ticker": "QQQ", "signal": "trend", "lookback": 100, "below": 0, "exposure": 0.5}}


def _prices(n=700, tickers=("AAA", "BBB", "CCC", "DDD", "EEE", "QQQ"), seed=3):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2020-01-01", periods=n)
    return pd.DataFrame({t: 50 * np.exp(np.cumsum(rng.normal(0.0004 * (i - 2), 0.01 + 0.004 * i, n))) for i, t in enumerate(tickers)}, index=idx)


def spec(design=DESIGN, **kw):
    return {"template": "custom", "params": {"design": design}, "universe": ["AAA", "BBB", "CCC", "DDD", "EEE"], "max_weight": "0.3",
            "min_cash": "0.1", "rebalance": "monthly", **kw}


def test_designs_are_checked_and_canonical():
    same = {**DESIGN, "score": list(reversed(DESIGN["score"]))}
    assert sl.design_hash(DESIGN) == sl.design_hash(same)                       # order does not matter
    assert spec_hash(spec()) == spec_hash(spec(same))
    bad = [{**DESIGN, "score": []}, {**DESIGN, "score": [{"signal": "magic", "lookback": 20, "weight": 1}]},
           {**DESIGN, "score": [{"signal": "trend", "lookback": 999, "weight": 1}]}, {**DESIGN, "score": [{"signal": "trend", "lookback": 20, "weight": 0}]},
           {**DESIGN, "weighting": "leverage"}, {**DESIGN, "code": "import os"}, {**DESIGN, "risk_off": {**DESIGN["risk_off"], "ticker": "TSLA"}},
           {**DESIGN, "filters": [{"signal": "trend", "lookback": 20, "rule": "top_fraction", "value": 1.5}]},
           {**DESIGN, "score": [{"signal": "volatility", "lookback": 20, "skip": 5, "weight": 1}]}]
    for b in bad:
        with pytest.raises(ValueError):
            sl.normalize_design(b)
    assert sl.window(DESIGN) == 148 and sl.market_tickers(DESIGN) == ["QQQ"]


def test_custom_weights_keep_the_caps_and_never_look_ahead():
    prices = _prices()
    s = normalize_spec(spec())
    for i in range(200, 700, 37):
        w = target_weights(s, prices, i)
        assert all(0 < x <= 0.3 + 1e-12 for x in w.values()) and sum(w.values()) <= 0.9 + 1e-12
        assert set(w) <= set(s["universe"])                                        # the market ticker is read, not bought
    lk = leakage_test(s, prices, n_dates=5, n_backtest_dates=1, seed=1)
    assert lk["passed"], lk["failures"]


def test_risk_off_halves_the_invested_budget_when_the_market_is_below_trend():
    prices = _prices()
    s = spec({**DESIGN, "filters": [], "risk_off": {"ticker": "QQQ", "signal": "trend", "lookback": 50, "below": 10.0 / 10, "exposure": 0.5}})
    s = normalize_spec({**s, "min_cash": "0"})
    w = target_weights(s, prices, 600)                                             # "below 1.0" is always true -> risk off
    assert abs(sum(w.values()) - 0.5) < 1e-9


def test_filters_and_weightings():
    prices = _prices()
    top = normalize_spec(spec({"score": [{"signal": "sharpe", "lookback": 60, "weight": 1}],
                               "filters": [{"signal": "volatility", "lookback": 60, "rule": "bottom_fraction", "value": 0.4}],
                               "top_n": 5, "weighting": "rank", "risk_off": None}))
    w = target_weights(top, prices, 650)
    assert len(w) == 2                                                             # 40% of five stocks -> the two calmest
    inv = normalize_spec(spec({**top["params"]["design"], "filters": [], "weighting": "inverse_volatility"}))
    wi = target_weights(inv, prices, 650)
    assert wi["AAA"] >= wi["EEE"]                                                   # AAA swings least in the fixture


def test_scaled_changes_only_the_periods():
    d = sl.scaled(DESIGN, 1.25)
    assert [t["lookback"] for t in d["score"]] == [158, 79] and d["risk_off"]["lookback"] == 125
    assert [t["weight"] for t in d["score"]] == [1.0, -0.5]
