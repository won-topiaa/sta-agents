"""Value signals from SEC filings: each number is usable only after it was filed, TTM sums are exact, and share counts
are put on one split basis; the strategy language uses them without looking ahead."""
import numpy as np
import pandas as pd
import pytest

from xtxc_agent.research import agent_profile as ap
from xtxc_agent.research import fundamentals as F
from xtxc_agent.research import strategy_lang as sl
from xtxc_agent.research.evaluator import leakage_test
from xtxc_agent.research.strategies import normalize_spec, target_weights

from test_agent_profile import AGENT
from test_strategy_lang import _prices


def q(start, end, val, filed):
    return {"start": start, "end": end, "val": val, "filed": filed, "form": "10-Q"}


def doc(shares_rows, ni=None, equity=None):
    ni = ni or [q("2021-01-01", "2021-03-31", 10, "2021-04-20"), q("2021-04-01", "2021-06-30", 20, "2021-07-20"),
                q("2021-07-01", "2021-09-30", 30, "2021-10-20"),
                {"start": "2021-01-01", "end": "2021-12-31", "val": 100, "filed": "2022-02-10", "form": "10-K"},   # Q4 = 40
                q("2022-01-01", "2022-03-31", 50, "2022-04-20")]
    return {"facts": {"us-gaap": {"NetIncomeLoss": {"units": {"USD": ni}},
                                  "StockholdersEquity": {"units": {"USD": equity or [{"end": "2021-12-31", "val": 1000, "filed": "2022-02-10"}]}}},
                      "dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": shares_rows}}}}}


SHARES = [{"end": e, "val": v, "filed": f} for e, v, f in
          [("2021-04-15", 10, "2021-04-20"), ("2021-07-15", 10, "2021-07-20"), ("2021-10-15", 10, "2021-10-20"), ("2022-02-01", 10, "2022-02-10")]]


def test_ttm_uses_derived_q4_and_only_published_numbers():
    rows = F.quarterly(doc(SHARES), "net_income")
    assert [r[2] for r in rows] == [10, 20, 30, 40, 50]
    assert rows[3][0] == "2022-02-10"                         # Q4 exists only once the 10-K is filed
    idx = pd.bdate_range("2021-01-01", "2022-06-30")
    p = F.ticker_panel(doc(SHARES), pd.Series(1.0, index=idx))   # price 1 x 10 shares = market value 10
    ey = pd.Series(p["earnings_yield"], index=idx)
    assert np.isnan(ey[:"2022-02-10"]).all()                   # four quarters first known after the 10-K
    assert ey["2022-02-11"] == pytest.approx(100 / 10)        # 10+20+30+40
    assert ey["2022-04-21"] == pytest.approx(140 / 10)        # 20+30+40+50, from the day after filing
    assert ey["2022-04-20"] == pytest.approx(100 / 10)
    assert pd.Series(p["roe"], index=idx)["2022-04-21"] == pytest.approx(140 / 1000)


def test_values_expire_and_splits_are_put_on_one_basis():
    split = SHARES[:2] + [{"end": "2021-10-15", "val": 40, "filed": "2021-10-20"}, {"end": "2022-02-01", "val": 40, "filed": "2022-02-10"}]
    assert [r[2] for r in F.shares(doc(split))] == [40, 40, 40, 40]   # 4:1 split: earlier counts scaled up
    idx = pd.bdate_range("2022-01-01", "2024-01-01")
    sh = F._asof(F.shares(doc(SHARES)), idx)
    s = pd.Series(sh, index=idx)
    assert s["2022-03-01"] == 10 and np.isnan(s["2023-06-01"])        # no filing for > MAX_AGE_DAYS -> unknown


def test_attach_adds_point_in_time_columns_for_companies_only():
    idx = pd.bdate_range("2021-01-01", "2022-06-30")
    prices = pd.DataFrame({"AAA": 1.0, "ETF": 1.0}, index=idx)
    out = F.attach(prices, prices, {"AAA": doc(SHARES), "ETF": doc(SHARES)}, companies={"AAA"})
    assert "AAA::earnings_yield" in out.columns and "ETF::earnings_yield" not in out.columns
    assert list(out.columns[:2]) == ["AAA", "ETF"]


def _with_fundamentals(prices):
    """Synthetic value signals as extra columns: AAA cheapest ... EEE most expensive, changing over time."""
    t = np.arange(len(prices)) / len(prices)
    cols = {f"{n}::earnings_yield": (0.10 - 0.02 * i) + 0.03 * np.sin(6 * t + i) for i, n in enumerate(["AAA", "BBB", "CCC", "DDD", "EEE"])}
    cols.update({f"{n}::debt_to_equity": np.full(len(prices), 0.5 + i) for i, n in enumerate(["AAA", "BBB", "CCC", "DDD", "EEE"])})
    return pd.concat([prices, pd.DataFrame(cols, index=prices.index)], axis=1)


VALUE = {"score": [{"signal": "earnings_yield", "lookback": 63, "weight": 1}],
         "filters": [{"signal": "debt_to_equity", "lookback": 5, "rule": "below", "value": 3.0}], "top_n": 2, "weighting": "equal", "risk_off": None}


def spec(design):
    return {"template": "custom", "params": {"design": design}, "universe": ["AAA", "BBB", "CCC", "DDD", "EEE"], "max_weight": "0.5",
            "min_cash": "0", "rebalance": "monthly"}


def test_value_designs_rank_by_point_in_time_fundamentals_without_lookahead():
    d = sl.normalize_design(VALUE)
    assert d["score"][0]["lookback"] == 5 and sl.fundamental_signals(d) == {"earnings_yield", "debt_to_equity"}
    prices = _with_fundamentals(_prices())
    i = 400
    w = target_weights(normalize_spec(spec(VALUE)), prices, i)
    ey = {n: prices[f"{n}::earnings_yield"].iloc[i] for n in ["AAA", "BBB", "CCC"]}       # D/E < 3 keeps AAA..CCC
    assert set(w) == set(sorted(ey, key=lambda n: -ey[n])[:2])
    lk = leakage_test(normalize_spec(spec(VALUE)), prices, n_dates=5, n_backtest_dates=1, seed=3)
    assert lk["passed"], lk["failures"]
    assert target_weights(normalize_spec(spec(VALUE)), _prices(), i) == {}                # no fundamentals -> no picks


def test_agents_keep_their_style():
    tech = AGENT
    value = {**AGENT, "style": "value", "preset": "deep_value", "rules": [{"id": "cheap_earnings"}, {"id": "cash_generating"}, {"id": "low_debt"}]}
    with pytest.raises(sl.DesignError, match="price behaviour only"):
        ap.apply(VALUE, tech)
    with pytest.raises(sl.DesignError, match="at least one company fundamental"):
        ap.apply({"score": [{"signal": "momentum", "lookback": 126, "weight": 1}], "weighting": "equal"}, value)
    d = ap.apply(VALUE, value)
    assert {"signal": "fcf_yield", "lookback": 5, "rule": "above", "value": 0.0} in d["filters"]
    assert all(c["status"] == "pass" for c in ap.compliance(d, value))
