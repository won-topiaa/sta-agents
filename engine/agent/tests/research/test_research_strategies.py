import numpy as np
import pandas as pd
import pytest
from research_testlib import synthetic_prices

from xtxc_agent.research import strategies as st


# an AI-style design (strategy_lang) so every template, "custom" included, runs through the same guarantees
CUSTOM_DESIGN = {"score": [{"signal": "momentum", "lookback": 40, "skip": 5, "weight": 1}, {"signal": "volatility", "lookback": 20, "weight": -0.5}],
                 "filters": [{"signal": "trend", "lookback": 30, "rule": "above", "value": -0.2}], "top_n": None, "weighting": "rank",
                 "risk_off": None}


def _spec(template, universe, max_weight="0.25", min_cash="0.20", **params):
    if template == "custom":
        params = {"design": CUSTOM_DESIGN, **params}
    return {"template": template, "params": params, "universe": list(universe), "max_weight": max_weight,
            "min_cash": min_cash, "rebalance": "weekly", "exclude_leveraged": True}


def test_cap_weights_water_filling_known_answer():
    w = st.cap_weights({"a": 10.0, "b": 1.0, "c": 1.0}, total=0.8, cap=0.5)
    assert w == pytest.approx({"a": 0.5, "b": 0.15, "c": 0.15}, abs=1e-11)
    # every name capped -> remainder stays cash
    w = st.cap_weights({"a": 1.0, "b": 1.0}, total=0.8, cap=0.25)
    assert w == {"a": 0.25, "b": 0.25}
    # cascade: capping a pushes b over the cap too
    w = st.cap_weights({"a": 100.0, "b": 10.0, "c": 1.0, "d": 1.0}, total=1.0, cap=0.3)
    assert w["a"] == 0.3 and w["b"] == 0.3
    assert w["c"] == pytest.approx(0.2, abs=1e-11) and w["d"] == pytest.approx(0.2, abs=1e-11)
    assert st.cap_weights({"a": 0.0, "b": -1.0}, 0.8, 0.25) == {}


def test_cap_weights_float_sum_never_exceeds_budget():
    total = 1.0 - float("0.157")
    w = st.cap_weights({f"T{i}": 1.0 for i in range(6)}, total=total, cap=0.1405)
    assert sum(w.values()) <= total and all(v <= 0.1405 for v in w.values())
    assert abs(sum(w.values()) - total) < 1e-12


def test_momentum_top_n_uses_exact_decimal():
    assert st.momentum_top_n("0.25", "0.2") == 4
    assert st.momentum_top_n("0.2", "0.2") == 4  # float division would give 4.000000000000001 -> 5
    assert st.momentum_top_n("0.1", "0.0") == 10
    assert st.momentum_top_n("1", "0.5") == 1


@pytest.mark.parametrize("template", st.TEMPLATES)
def test_weights_respect_caps_and_cash(template):
    prices = synthetic_prices(n_days=400, tickers=[f"T{i}" for i in range(12)], late={"T3": 200, "T7": 390})
    rng = np.random.default_rng(1)
    for _ in range(40):
        max_w = f"{rng.uniform(0.05, 0.6):.3f}"
        min_cash = f"{rng.uniform(0.0, 0.6):.3f}"
        spec = _spec(template, prices.columns, max_weight=max_w, min_cash=min_cash)
        i = int(rng.integers(0, len(prices)))
        w = st.target_weights(spec, prices, i)
        assert all(v > 0 for v in w.values())
        assert all(v <= float(max_w) for v in w.values())
        assert sum(w.values()) <= 1.0 - float(min_cash)
        # no weight on a name without a price that day (no back-filling)
        for t in w:
            assert np.isfinite(prices[t].iloc[i])


def test_momentum_picks_top_n_equal_weight_and_skips_short_history():
    idx = pd.bdate_range("2021-01-01", periods=100)
    growth = {"A": 0.010, "B": 0.008, "C": 0.006, "D": 0.004, "E": 0.002, "F": -0.001}
    df = pd.DataFrame({t: 100 * (1 + g) ** np.arange(100) for t, g in growth.items()}, index=idx)
    df.loc[: idx[60], "A"] = np.nan  # A (best) listed too recently for a 63-day lookback
    w = st.target_weights(_spec("momentum", df.columns), df, 99)
    assert w == {"B": 0.2, "C": 0.2, "D": 0.2, "E": 0.2}
    # before 63 rows of history nobody is eligible
    assert st.target_weights(_spec("momentum", df.columns), df, 50) == {}
    # positive_only drops F-like names when few are positive
    w = st.target_weights(_spec("momentum", ["E", "F"], positive_only=True), df, 99)
    assert w == {"E": 0.25}
    # proportional weighting stays within caps and favours stronger momentum
    w = st.target_weights(_spec("momentum", df.columns, max_weight="0.5", weighting="proportional", top_n=4), df, 99)
    assert w["B"] > w["C"] > w["D"] > w["E"] and sum(w.values()) <= 0.8 + 1e-12


def test_low_vol_prefers_calm_names():
    rng = np.random.default_rng(3)
    idx = pd.bdate_range("2021-01-01", periods=120)
    df = pd.DataFrame({
        "CALM": 100 * np.exp(np.cumsum(rng.normal(0, 0.005, 120))),
        "MID": 100 * np.exp(np.cumsum(rng.normal(0, 0.015, 120))),
        "WILD": 100 * np.exp(np.cumsum(rng.normal(0, 0.05, 120))),
    }, index=idx)
    w = st.target_weights(_spec("low_vol", df.columns, max_weight="0.6", min_cash="0.2"), df, 119)
    assert w["CALM"] > w["MID"] > w["WILD"]
    assert w["CALM"] <= 0.6 and sum(w.values()) == pytest.approx(0.8, abs=1e-9)


def test_exclude_leveraged_uses_universe_kind():
    idx = pd.bdate_range("2021-01-01", periods=10)
    df = pd.DataFrame({"QQQ": np.linspace(100, 110, 10), "TQQQ": np.linspace(50, 70, 10)}, index=idx)
    spec = _spec("equal_weight", ["QQQ", "TQQQ"], max_weight="0.5", min_cash="0")
    assert st.target_weights(spec, df, 9) == {"QQQ": 0.5}
    spec["exclude_leveraged"] = False
    assert st.target_weights(spec, df, 9) == {"QQQ": 0.5, "TQQQ": 0.5}


def test_target_weights_ignores_the_future_on_synthetic_data():
    prices = synthetic_prices(n_days=300)
    for template in st.TEMPLATES:
        spec = _spec(template, prices.columns)
        for i in (70, 150, 250):
            before = st.target_weights(spec, prices, i)
            fut = prices.copy()
            fut.iloc[i + 1:] = fut.iloc[i + 1:] * np.random.default_rng(i).uniform(0.1, 10, size=fut.iloc[i + 1:].shape)
            assert st.target_weights(spec, fut, i) == before
            assert st.target_weights(spec, prices.iloc[: i + 1], i) == before


def test_spec_hash_is_canonical():
    a = _spec("momentum", ["NVDA", "AMD"], max_weight="0.25", min_cash="0.20")
    b = {**a, "universe": ["amd", "NVDA", "AMD"], "max_weight": 0.25, "min_cash": "0.2",
         "params": {"lookback": 63}, "period": {"years": 5}, "benchmark": "QQQ"}
    assert st.spec_hash(a) == st.spec_hash(b)
    c = {**a, "params": {"lookback": 126}}
    assert st.spec_hash(a) != st.spec_hash(c)
    with pytest.raises(ValueError):
        st.normalize_spec({**a, "template": "magic"})
    with pytest.raises(ValueError):
        st.normalize_spec({**a, "max_weight": "1.5"})
    with pytest.raises(ValueError):
        st.normalize_spec({**a, "params": {"leverage": 2}})


def test_rebalance_positions():
    idx = pd.DatetimeIndex(["2026-09-21", "2026-09-22", "2026-09-25", "2026-09-28", "2026-09-30", "2026-10-01"])
    assert st.rebalance_positions(idx, "weekly") == [2, 5]  # Fri 9/25, and the last row
    assert st.rebalance_positions(idx, "monthly") == [4, 5]  # 9/30 and the last row


def test_band_param_is_normalized_and_hashed():
    a = _spec("momentum", ["NVDA", "AMD"])
    assert st.normalize_spec(a)["params"]["band"] == "0.02"
    for tpl in st.TEMPLATES:
        assert st.normalize_spec(_spec(tpl, ["NVDA"]))["params"]["band"] == "0.02"
    same = [a, {**a, "params": {"band": "0.020"}}, {**a, "params": {"band": 0.02}}]
    assert len({st.spec_hash(x) for x in same}) == 1
    assert st.spec_hash({**a, "params": {"band": 0}}) != st.spec_hash(a)
    assert st.normalize_spec({**a, "params": {"band": "0.00"}})["params"]["band"] == "0"
    for bad in (-0.01, 1, "x"):
        with pytest.raises(ValueError):
            st.normalize_spec({**a, "params": {"band": bad}})
    # the band is a trading rule: it never changes the target weights themselves
    prices = synthetic_prices(n_days=200)
    s0 = _spec("momentum", prices.columns, band=0)
    s5 = _spec("momentum", prices.columns, band="0.05")
    assert st.target_weights(s0, prices, 150) == st.target_weights(s5, prices, 150)
