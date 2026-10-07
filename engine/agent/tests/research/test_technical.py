"""Technical agent tools: a turnover buffer, exit rules between rebalances, relative strength, a breadth guard, money
flow and sector signals. Each uses rows <= t only and keeps designs without them unchanged."""
import numpy as np
import pandas as pd
import pytest

from xtxc_agent.core.strategy_design import describe
from xtxc_agent.research import agent_profile as ap
from xtxc_agent.research import strategy_lang as sl
from xtxc_agent.research import volume as V
from xtxc_agent.research.backtest import simulate
from xtxc_agent.research.evaluator import leakage_test
from xtxc_agent.research.strategies import normalize_spec, target_weights

from test_agent_profile import AGENT
from test_strategy_lang import DESIGN, _prices, spec

BASE = {"score": [{"signal": "momentum", "lookback": 63, "weight": 1}], "filters": [], "top_n": 2, "weighting": "equal", "risk_off": None}


def test_new_parts_are_optional_and_checked():
    assert sl.normalize_design(DESIGN) == sl.normalize_design({**DESIGN, "hold_buffer": None, "exit": None, "breadth_off": None})
    d = sl.normalize_design({**BASE, "hold_buffer": 2, "exit": {"stop_loss": 0.1}, "breadth_off": {"lookback": 200, "below": 0.5, "exposure": 0.3}})
    assert d["hold_buffer"] == 2 and d["exit"] == {"stop_loss": 0.1, "trailing_stop": None} and d["breadth_off"]["below"] == 0.5
    for bad in ({"hold_buffer": 9}, {"exit": {"stop_loss": 0.9}}, {"exit": {"take_profit": 0.1}}, {"breadth_off": {"lookback": 200, "below": 2, "exposure": 0}}):
        with pytest.raises(sl.DesignError):
            sl.normalize_design({**BASE, **bad})
    assert "exit" not in sl.normalize_design({**BASE, "exit": {"stop_loss": None, "trailing_stop": None}})


def test_a_holding_within_the_buffer_is_kept():
    hist = np.column_stack([np.linspace(10, 10 * (1 + r), 80) for r in (0.30, 0.25, 0.20, 0.05)])   # AAA > BBB > CCC > DDD
    names = ["AAA", "BBB", "CCC", "DDD"]
    plain, _ = sl.design_scores(BASE, hist, names, {}, 2)
    assert set(plain) == {"AAA", "BBB"}
    held, _ = sl.design_scores({**BASE, "hold_buffer": 2}, hist, names, {}, 2, held={"CCC"})
    assert set(held) == {"AAA", "CCC"}                                     # CCC (3rd) stays; the best other fills the slot
    gone, _ = sl.design_scores({**BASE, "hold_buffer": 1.5}, hist, names, {}, 2, held={"DDD"})
    assert set(gone) == {"AAA", "BBB"}                                     # DDD (4th) is outside 1.5 x 2 = 3


def test_relative_strength_and_breadth_guard():
    n = 300
    up, flat = np.linspace(10, 20, n), np.full(n, 10.0)
    hist = np.column_stack([up, flat * np.linspace(1, 1.05, n), flat])
    qqq = np.linspace(10, 13, n)
    rs = sl._signal_values({"signal": "rel_strength", "lookback": 126}, hist, bench=qqq)
    assert rs[0] > 0 > rs[1] and np.isnan(sl._signal_values({"signal": "rel_strength", "lookback": 126}, hist)[0])
    assert sl.market_tickers({**BASE, "filters": [{"signal": "rel_strength", "lookback": 126, "rule": "above", "value": 0}]}) == ["QQQ"]
    down = np.column_stack([np.linspace(20, 10, n)] * 3)
    guard = {**BASE, "breadth_off": {"lookback": 200, "below": 0.5, "exposure": 0.2}}
    assert sl.design_scores(guard, down, ["A", "B", "C"], {}, 2)[1] == 0.2
    assert sl.design_scores(guard, hist, ["A", "B", "C"], {}, 2)[1] == 1.0


def test_exit_rules_sell_between_rebalances_without_looking_ahead():
    prices = _prices()
    crash = prices.copy()
    crash.iloc[300:, crash.columns.get_loc("AAA")] *= 0.5                 # AAA halves on day 300
    design = {**BASE, "top_n": 5, "exit": {"stop_loss": 0.15}}
    s = normalize_spec(spec(design, max_weight="0.3", min_cash="0"))
    res = simulate(s, crash, {"default_bps": 10, "per_ticker_bps": {}}, holdout_days=50)
    sold = [x for x in res["exits"] if x[1] == "AAA"]
    assert sold and sold[0][0] == str(crash.index[301].date())            # checked on the day-300 close, sold at the next close
    assert any("exit rules" in a for a in res["assumptions"])
    plain = simulate(normalize_spec(spec(BASE, max_weight="0.3", min_cash="0")), crash, {"default_bps": 10, "per_ticker_bps": {}}, holdout_days=50)
    assert plain["exits"] == [] and plain["metrics"] != res["metrics"]
    lk = leakage_test(normalize_spec(spec({**design, "hold_buffer": 2, "breadth_off": {"lookback": 100, "below": 0.5, "exposure": 0.5}})),
                      prices, n_dates=4, n_backtest_dates=2, seed=5)
    assert lk["passed"], lk["failures"]


def test_buffered_backtest_trades_less():
    prices = _prices(tickers=("AAA", "BBB", "CCC", "DDD", "EEE", "QQQ"), seed=11)
    cost = {"default_bps": 25, "per_ticker_bps": {}}
    base = {**BASE, "score": [{"signal": "momentum", "lookback": 21, "weight": 1}], "top_n": 2}
    loose = simulate(normalize_spec(spec(base, rebalance="weekly", min_cash="0")), prices, cost, holdout_days=50)
    sticky = simulate(normalize_spec(spec({**base, "hold_buffer": 2}, rebalance="weekly", min_cash="0")), prices, cost, holdout_days=50)
    assert sticky["turnover"] < loose["turnover"]
    w = target_weights(normalize_spec(spec({**base, "hold_buffer": 2})), prices, 400, held=frozenset({"EEE"}))
    assert w


def test_money_flow_and_sector_signals_use_past_rows_only():
    idx = pd.bdate_range("2024-01-01", periods=200)
    rng = np.random.default_rng(1)
    closes = pd.DataFrame({t: 20 * np.exp(np.cumsum(rng.normal(0, 0.01, 200))) for t in ("A", "B", "C", "D")}, index=idx)
    volumes = pd.DataFrame({t: rng.integers(1_000, 5_000, 200).astype(float) for t in closes}, index=idx)
    mf = V.ticker_panel(closes["A"], volumes["A"])["money_flow"]
    assert np.isnan(mf[:19]).all() and np.all(np.abs(mf[20:]) <= 1)
    up = closes["A"].copy(); up.iloc[150:] = np.linspace(up.iloc[149], up.iloc[149] * 1.5, 50)
    assert V.ticker_panel(up, volumes["A"])["money_flow"][-1] == pytest.approx(1.0)        # only up days: all money in
    sectors = {"A": "tech", "B": "tech", "C": "tech", "D": "energy"}
    cols = V.sector_columns(idx, closes, volumes, sectors, {"A", "D"})
    assert set(cols) == {"A::sector_momentum", "A::sector_money_flow", "D::sector_momentum", "D::sector_money_flow"}
    assert np.isnan(cols["D::sector_momentum"]).all()                    # a one-company sector has no median
    later = closes.copy(); later.iloc[120:] *= 3                          # change the future only
    again = V.sector_columns(idx, later, volumes, sectors, {"A"})
    np.testing.assert_array_equal(cols["A::sector_momentum"][:120], again["A::sector_momentum"][:120])
    np.testing.assert_array_equal(cols["A::sector_money_flow"][:120], again["A::sector_money_flow"][:120])


def test_agent_rules_for_the_new_tools():
    agent = {**AGENT, "rules": [{"id": "stop_loss", "params": {"loss": 0.1}}, {"id": "trailing_stop", "params": {"drop": 0.2}},
                                {"id": "fewer_trades", "params": {"within": 2}}, {"id": "breadth_guard", "params": {"share": 0.5, "exposure": 0.3}},
                                {"id": "relative_strength", "params": {"days": 126}}, {"id": "money_inflow"}, {"id": "strong_sector"},
                                {"id": "sector_inflow"}]}
    model = {**BASE, "exit": {"stop_loss": 0.25, "trailing_stop": 0.1}, "hold_buffer": 1.5}
    d = ap.apply(model, agent)
    assert d["exit"] == {"stop_loss": 0.1, "trailing_stop": 0.1}           # the stricter of agent and model, per rule
    assert d["hold_buffer"] == 2 and d["breadth_off"] == {"lookback": 200, "below": 0.5, "exposure": 0.3}
    assert {f["signal"] for f in d["filters"]} >= {"rel_strength", "money_flow", "sector_momentum", "sector_money_flow"}
    assert all(c["status"] == "pass" for c in ap.compliance(d, agent))
    raw = {c["rule"]: c["status"] for c in ap.compliance(model, agent)}
    assert raw["stop_loss"] == "fail" and raw["trailing_stop"] == "pass" and raw["fewer_trades"] == "fail"
    words = describe(d)
    assert "10%" in words["exit"] and "2" in words["hold"] and "50%" in words["breadth"]
    with pytest.raises(ValueError):
        ap.normalize_profile({**AGENT, "style": "value", "preset": "deep_value", "rules": [{"id": "relative_strength"}]})
