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


def _rich(shares_val=10, ni_scale=1.0):
    """A company with income, cash flows, dividends, operating income, D&A, debt and cash."""
    d = doc([{**r, "val": shares_val} for r in SHARES], ni=[{**r, "val": r["val"] * ni_scale} for r in doc(SHARES)["facts"]["us-gaap"]["NetIncomeLoss"]["units"]["USD"]])
    g = d["facts"]["us-gaap"]
    quarters = [("2021-01-01", "2021-03-31", "2021-04-20"), ("2021-04-01", "2021-06-30", "2021-07-20"),
                ("2021-07-01", "2021-09-30", "2021-10-20"), ("2021-10-01", "2021-12-31", "2022-02-10")]
    for concept, v in (("PaymentsOfDividends", 2), ("OperatingIncomeLoss", 30), ("DepreciationDepletionAndAmortization", 5)):
        g[concept] = {"units": {"USD": [q(s, e, v, f) for s, e, f in quarters]}}
    g["LongTermDebt"] = {"units": {"USD": [{"end": "2021-12-31", "val": 50, "filed": "2022-02-10"}]}}
    g["CashAndCashEquivalentsAtCarryingValue"] = {"units": {"USD": [{"end": "2021-12-31", "val": 20, "filed": "2022-02-10"}]}}
    return d


def test_dividend_and_ebitda_yields_and_the_digest_gives_the_same_panel():
    idx = pd.bdate_range("2021-01-01", "2022-06-30")
    close = pd.Series(10.0, index=idx)                         # market value 100
    raw, dg = F.ticker_panel(_rich(), close), F.ticker_panel(F.digest(_rich()), close)
    for k in raw:
        np.testing.assert_array_equal(raw[k], dg[k])
    day = idx.get_loc(pd.Timestamp("2022-02-11"))
    assert raw["dividend_yield"][day] == pytest.approx(8 / 100)
    assert raw["ebitda_yield"][day] == pytest.approx((4 * 35) / (100 + 50 - 20))
    assert np.isnan(raw["dividend_yield"][idx.get_loc(pd.Timestamp("2022-02-10"))])   # not filed yet
    plain = F.ticker_panel(doc(SHARES), close)                                       # reports income, pays no dividend
    assert plain["dividend_yield"][day] == 0 and np.isnan(plain["ebitda_yield"][day])


def test_sector_relative_values_use_every_peer_but_only_add_columns_for_researched_companies():
    idx = pd.bdate_range("2021-01-01", "2022-06-30")
    closes = pd.DataFrame({t: 1.0 for t in ("AAA", "P1", "P2", "BBB")}, index=idx)
    docs = {"AAA": _rich(ni_scale=1), "P1": _rich(ni_scale=2), "P2": _rich(ni_scale=3), "BBB": _rich()}
    sectors = {"AAA": "technology", "P1": "technology", "P2": "technology", "BBB": "energy"}
    out = F.attach(closes[["AAA", "BBB"]], closes, docs, companies={"AAA", "BBB"}, sectors=sectors)
    assert "P1::earnings_yield" not in out.columns and "AAA::earnings_yield_vs_sector" in out.columns
    ey = {t: F.ticker_panel(docs[t], closes[t]) ["earnings_yield"] for t in ("AAA", "P1", "P2")}
    day = idx.get_loc(pd.Timestamp("2022-02-11"))
    assert out["AAA::earnings_yield_vs_sector"].iloc[day] == pytest.approx(ey["AAA"][day] - ey["P1"][day])   # median of 1x,2x,3x is 2x
    assert out["BBB::earnings_yield_vs_sector"].isna().all()          # a sector of one: no peer median
    assert F.sector_of("3674") == "technology" and F.sector_of("9999") is None and F.sector_of(None) is None
    assert F.sector_of("7389", "V") == "financials" and F.sector_of("6199", "MARA") == "digital_assets"


def test_release_stores_digests_and_rejects_tampering(tmp_path):
    import gzip
    import json as _json
    tickers = {"0": {"ticker": "AAA", "cik_str": 1}, "1": {"ticker": "BRK-B", "cik_str": 2}}

    def fetcher(url):
        if url.endswith("company_tickers.json"):
            return _json.dumps(tickers).encode()
        if "/submissions/" in url:
            return _json.dumps({"sic": "3674"}).encode()
        return _json.dumps({**_rich(), "entityName": "Aaa Inc"}).encode()
    rel = F.fetch_release(["AAA", "BRK.B", "NOPE"], tmp_path, fetcher=fetcher)
    assert rel["missing"] == ["NOPE"] and rel["tickers"]["AAA"]["sector"] == "technology"
    docs, meta = F.load_release(tmp_path)
    assert docs["AAA"]["version"] == F.DIGEST_VERSION and meta["sectors"]["AAA"] == "technology"
    assert F.derive_release(tmp_path)["release_id"] == rel["release_id"]                 # same digests from the raw facts
    obj = tmp_path / "fundamentals" / "objects" / f"{rel['tickers']['AAA']['digest']}.digest.json.gz"
    obj.write_bytes(gzip.compress(b'{"version": 1}'))
    with pytest.raises(ValueError, match="hash mismatch"):
        F.load_release(tmp_path)


def test_volume_signals_are_trailing_and_technical():
    from xtxc_agent.research import volume as V
    prices = _prices()
    vol = pd.DataFrame({c: np.where(np.arange(len(prices)) % 50 < 25, 1e6, 3e6) for c in prices.columns}, index=prices.index)
    framed = V.attach(prices, prices, vol)
    v = V.ticker_panel(prices["AAA"], vol["AAA"])
    assert np.isnan(v["volume_surge"][:119]).all() and np.isfinite(v["volume_surge"][119:]).all()
    assert v["dollar_volume"][30] == pytest.approx(np.log10((prices["AAA"] * vol["AAA"]).iloc[11:31].mean()))
    design = {"score": [{"signal": "volume_surge", "lookback": 5, "weight": 1}, {"signal": "momentum", "lookback": 63, "weight": 1}],
              "filters": [{"signal": "dollar_volume", "lookback": 5, "rule": "above", "value": 6}], "top_n": 2, "weighting": "equal", "risk_off": None}
    lk = leakage_test(normalize_spec(spec(design)), framed, n_dates=5, n_backtest_dates=1, seed=4)
    assert lk["passed"], lk["failures"]
    assert target_weights(normalize_spec(spec(design)), framed, 400)
    assert sl.fundamental_signals(design) == set()
    ap.apply(design, AGENT)                                                              # technical agents may use volume


def test_a_predecessor_registrant_keeps_the_history(tmp_path, monkeypatch):
    import json as _json
    old, new = _rich(), _rich()
    new["facts"]["us-gaap"]["NetIncomeLoss"]["units"]["USD"] = [q("2022-01-01", "2022-03-31", 50, "2022-04-20")]
    monkeypatch.setitem(F.PREDECESSORS, "AAA", [7])

    def fetcher(url):
        if url.endswith("company_tickers.json"):
            return _json.dumps({"0": {"ticker": "AAA", "cik_str": 9}}).encode()
        if "/submissions/" in url:
            return b'{"sic": "2911"}'
        return _json.dumps(old if "CIK0000000007" in url else new).encode()
    rel = F.fetch_release(["AAA"], tmp_path, fetcher=fetcher)
    assert rel["tickers"]["AAA"]["predecessors"][0]["cik"] == 7
    docs, _ = F.load_release(tmp_path)
    assert [r[2] for r in docs["AAA"]["flows"]["net_income"]][-1] == 140      # 20+30+40 from the old registrant + 50
    assert F.derive_release(tmp_path)["release_id"] == rel["release_id"]
