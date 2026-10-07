"""Chart patterns from closes: a range breakout, a volatility squeeze, rising highs and lows, a double bottom. Each is
decided from closes up to the decision day, combines with every other signal and rule, and leaves older designs as
they were."""
import numpy as np
import pytest

from xtxc_agent.core.i18n import tr
from xtxc_agent.core.strategy_design import describe
from xtxc_agent.research import agent_profile as ap
from xtxc_agent.research import strategy_lang as sl
from xtxc_agent.research.backtest import simulate
from xtxc_agent.research.evaluator import leakage_test
from xtxc_agent.research.strategies import normalize_spec, target_weights

from test_agent_profile import AGENT
from test_strategy_lang import DESIGN, _prices, spec

sv = sl._signal_values
BASE = {"score": [{"signal": "momentum", "lookback": 63, "weight": 1}], "filters": [], "top_n": 2, "weighting": "equal", "risk_off": None}


def col(*parts):
    return np.concatenate([np.asarray(p, float) for p in parts]).reshape(-1, 1)


def test_breakout_compares_with_the_previous_closes_only():
    box = col(np.full(60, 10.0), [10.5])
    assert sv({"signal": "breakout", "lookback": 20}, box)[0] == pytest.approx(0.05)
    inside = col(np.full(30, 10.0), [11.0], np.full(29, 10.0), [10.5])
    assert sv({"signal": "breakout", "lookback": 40}, inside)[0] == pytest.approx(10.5 / 11 - 1)   # still in the range
    assert np.isnan(sv({"signal": "breakout", "lookback": 80}, box)[0])                            # not enough history


def test_squeeze_leaves_out_the_breakout_day():
    rng = np.random.default_rng(0)
    moves = np.r_[rng.normal(0, 0.03, 60), rng.normal(0, 0.003, 10)]
    quiet = col(10 * np.exp(np.cumsum(np.r_[moves, 0.0])))
    jump = col(10 * np.exp(np.cumsum(np.r_[moves, 0.08])))
    a, b = sv({"signal": "squeeze", "lookback": 63}, quiet)[0], sv({"signal": "squeeze", "lookback": 63}, jump)[0]
    assert a < 0.3 and b < 0.3                       # a big move on the last day does not hide the quiet before it
    loud = col(10 * np.exp(np.cumsum(rng.normal(0, 0.02, 80))))
    assert 0.4 < sv({"signal": "squeeze", "lookback": 63}, loud)[0] < 2.5


def test_higher_lows_counts_rising_steps():
    zigzag = np.array([10 + 0.1 * i + (0.5 if i % 10 < 5 else 0) for i in range(70)])
    assert sv({"signal": "higher_lows", "lookback": 60}, col(zigzag))[0] == 1.0
    assert sv({"signal": "higher_lows", "lookback": 60}, col(zigzag[::-1]))[0] == 0.0
    flat = col(np.full(70, 10.0))
    assert sv({"signal": "higher_lows", "lookback": 60}, flat)[0] == 0.0     # equal steps are not higher


def test_double_bottom_needs_the_whole_shape_and_a_fresh_confirmation():
    down, up1, down2 = np.linspace(100, 90, 15), np.linspace(90, 99, 15), np.linspace(99, 90.5, 15)
    shape = col(down, up1, down2, np.linspace(90.5, 100, 15))
    assert sv({"signal": "double_bottom", "lookback": 59}, shape)[0] == pytest.approx(100 / 99 - 1)
    forming = col(down, up1, down2, np.linspace(90.5, 96, 15))
    assert sv({"signal": "double_bottom", "lookback": 59}, forming)[0] == pytest.approx(96 / 99 - 1)   # below 0: not yet
    v_shape = col(np.linspace(100, 90, 30), np.linspace(90, 100, 30))
    assert np.isnan(sv({"signal": "double_bottom", "lookback": 59}, v_shape)[0])                     # one low only
    uneven = col(down, up1, np.linspace(99, 85, 15), np.linspace(85, 100, 15))
    assert np.isnan(sv({"signal": "double_bottom", "lookback": 59}, uneven)[0])                     # lows 5% apart
    no_fall = col(np.linspace(91, 90, 15), up1, down2, np.linspace(90.5, 100, 15))
    assert np.isnan(sv({"signal": "double_bottom", "lookback": 59}, no_fall)[0])                    # nothing fell into it
    old = col(down, up1, down2, np.linspace(90.5, 104, 8), np.linspace(104, 106, 22))
    assert np.isnan(sv({"signal": "double_bottom", "lookback": 74}, old)[0])                        # broke out long ago


def test_pattern_designs_are_checked_and_old_designs_keep_their_hash():
    h = sl.design_hash(DESIGN)
    assert sl.normalize_design(DESIGN) == sl.normalize_design({**DESIGN})
    assert sl.design_hash(DESIGN) == h
    with pytest.raises(sl.DesignError, match="at least 30"):
        sl.normalize_design({**DESIGN, "score": [{"signal": "double_bottom", "lookback": 20, "weight": 1}]})
    with pytest.raises(sl.DesignError):
        sl.normalize_design({**DESIGN, "filters": [{"signal": "squeeze", "lookback": 63, "rule": "below", "value": 9}]})
    d = {**DESIGN, "filters": [{"signal": "breakout", "lookback": 12, "rule": "above", "value": 0},
                               {"signal": "squeeze", "lookback": 21, "rule": "below", "value": 0.7}]}
    small = sl.scaled(d, 0.5)
    assert {f["signal"]: f["lookback"] for f in small["filters"]} == {"breakout": 10, "squeeze": 20}   # never below the minimum
    assert sl.window(d) == 148


def test_pattern_designs_never_look_ahead():
    prices = _prices()
    design = {"score": [{"signal": "breakout", "lookback": 55, "weight": 1}, {"signal": "higher_lows", "lookback": 63, "weight": 0.5}],
              "filters": [{"signal": "squeeze", "lookback": 63, "rule": "below", "value": 1.5},
                          {"signal": "double_bottom", "lookback": 126, "rule": "below", "value": 1}],
              "top_n": None, "weighting": "equal", "risk_off": None}
    s = normalize_spec(spec(design))
    for i in range(200, 700, 41):
        target_weights(s, prices, i)
    lk = leakage_test(s, prices, n_dates=5, n_backtest_dates=1, seed=1)
    assert lk["passed"], lk["failures"]
    plain = normalize_spec(spec({**design, "filters": design["filters"][:1]}))
    lk = leakage_test(plain, prices, n_dates=5, n_backtest_dates=1, seed=2)
    assert lk["passed"], lk["failures"]


def test_pattern_rules_combine_with_the_other_rules():
    agent = {**AGENT, "rules": [{"id": "box_breakout", "params": {"days": 55}}, {"id": "quiet_before_move", "params": {"max": 0.7}},
                                {"id": "volume_confirmed", "params": {"min": 0.2}},
                                {"id": "higher_lows", "params": {"days": 63, "share": 0.75}}, {"id": "double_bottom", "params": {"days": 126}},
                                {"id": "trailing_stop", "params": {"drop": 0.1}}, {"id": "fewer_trades", "params": {"within": 2}}]}
    model = {**DESIGN, "risk_off": None}
    d = ap.apply(model, agent)
    got = {f["signal"]: (f["rule"], f["value"], f.get("entry")) for f in d["filters"]}
    assert got["breakout"] == ("above", 0, True) and got["squeeze"] == ("below", 0.7, True) and got["higher_lows"] == ("above", 0.75, True)
    assert got["double_bottom"] == ("above", 0, True) and got["volume_surge"] == ("above", 0.2, True) and got["trend"][2] is None
    assert d["exit"]["trailing_stop"] == 0.1 and d["hold_buffer"] == 2
    assert all(c["status"] == "pass" for c in ap.compliance(d, agent))
    assert {c["rule"]: c["status"] for c in ap.compliance(model, agent)}["box_breakout"] == "fail"
    words = describe(d)["filters"]
    assert "70%" in words and "75%" in words and words.count(tr("dz.filter.entry")) == 5
    preset = ap.catalog()["styles"]["technical"]["presets"]["pattern"]
    ap.enforced({**AGENT, "preset": "pattern", "rules": preset["rules"]})
    with pytest.raises(ValueError):
        ap.normalize_profile({**AGENT, "style": "value", "preset": "deep_value", "rules": [{"id": "double_bottom"}]})


def test_an_entry_filter_is_a_buying_condition_only():
    hist = np.column_stack([np.linspace(10, 10 * (1 + r), 80) for r in (0.30, 0.25, 0.20, 0.05)])   # AAA > BBB > CCC > DDD
    hist[-1, 1:] = hist[-2, 1:] * 0.99                                    # only AAA closes at a new high today
    names = ["AAA", "BBB", "CCC", "DDD"]
    entry = {**BASE, "filters": [{"signal": "breakout", "lookback": 20, "rule": "above", "value": 0, "entry": True}]}
    every = {**entry, "filters": [{**entry["filters"][0], "entry": False}]}
    assert sl.normalize_design(every) == sl.normalize_design({**BASE, "filters": [{"signal": "breakout", "lookback": 20, "rule": "above", "value": 0}]})
    assert sl.design_hash(every) != sl.design_hash(entry)
    assert set(sl.design_scores(entry, hist, names, {}, 2)[0]) == {"AAA"}                 # buying: the breakout is needed
    assert set(sl.design_scores(entry, hist, names, {}, 2, held={"BBB"})[0]) == {"AAA", "BBB"}   # holding: it is not
    assert set(sl.design_scores(every, hist, names, {}, 2, held={"BBB"})[0]) == {"AAA"}
    with pytest.raises(sl.DesignError):
        sl.normalize_design({**BASE, "filters": [{**entry["filters"][0], "entry": "yes"}]})


def test_entry_patterns_hold_until_the_exit_rules_sell():
    prices = _prices()
    design = {"score": [{"signal": "breakout", "lookback": 20, "weight": 1}], "top_n": 3, "weighting": "equal", "risk_off": None,
              "filters": [{"signal": "breakout", "lookback": 20, "rule": "above", "value": 0}]}
    held = {**design, "filters": [{**design["filters"][0], "entry": True}], "exit": {"trailing_stop": 0.1}}
    cost = {"default_bps": 10, "per_ticker_bps": {}}
    every = simulate(normalize_spec(spec(design, rebalance="weekly")), prices, cost, holdout_days=50)
    entry = simulate(normalize_spec(spec(held, rebalance="weekly")), prices, cost, holdout_days=50)
    assert entry["metrics"]["exposure"] > every["metrics"]["exposure"]
    assert entry["exits"]                                                  # holdings left through the trailing stop


def test_the_current_target_keeps_the_accounts_holdings_like_the_backtest():
    prices = _prices()
    plain = {"score": [{"signal": "momentum", "lookback": 63, "weight": 1}], "filters": [], "top_n": 2, "weighting": "equal", "risk_off": None}
    entry = {**plain, "filters": [{"signal": "breakout", "lookback": 55, "rule": "above", "value": 0, "entry": True}]}
    cost = {"default_bps": 10, "per_ticker_bps": {}}
    every = ["AAA", "BBB", "CCC", "DDD", "EEE"]
    new_money = simulate(normalize_spec(spec(entry)), prices, cost, holdout_days=50)
    holding_all = simulate(normalize_spec(spec(entry)), prices, cost, holdout_days=50, held=every)
    no_filter = simulate(normalize_spec(spec(plain)), prices, cost, holdout_days=50)
    assert holding_all["latest_target"]["weights"] == no_filter["latest_target"]["weights"]   # held: the entry filter is met
    last = len(prices) - 1
    breakout = sl._signal_values({"signal": "breakout", "lookback": 55}, prices[every].to_numpy()[: last + 1])
    assert set(new_money["latest_target"]["weights"]) <= {t for t, v in zip(every, breakout) if v > 0}
    assert holding_all["equity"] == new_money["equity"]                  # the backtest itself never sees the account
