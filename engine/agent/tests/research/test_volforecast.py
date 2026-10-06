"""Volatility forecast: horizons, walk-forward calibration, execution-data models, costs. Synthetic test fixtures only
(random series generated here, never stored as market data)."""
import datetime as dt

import numpy as np
import pandas as pd
import pytest

from xtxc_agent.research import exectape as et
from xtxc_agent.research import volforecast as vf


def test_horizons():
    assert [vf.parse_horizon(c).days for c in ("1d", "1w", "1m", "3m", "6m", "1y", "3y")] == [1, 5, 21, 63, 126, 252, 756]
    assert vf.parse_horizon("1h").hours == 1 and vf.parse_horizon(" 18M ").code == "18m"
    for bad in ("0d", "25h", "4y", "37m", "year", "", None, "1.5y"):
        with pytest.raises(ValueError):
            vf.parse_horizon(bad)


def _daily(n_days=3200, tickers=("AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"), seed=7):
    """GARCH(1,1)-like returns: volatility clusters, so a model that reads recent swings should be calibrated."""
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2014-01-02", periods=n_days)
    adj = {}
    for t in tickers:
        var, r = 0.0002, np.empty(n_days)
        for i in range(n_days):
            r[i] = rng.standard_normal() * np.sqrt(var)
            var = 0.000004 + 0.08 * r[i] ** 2 + 0.9 * var
        adj[t] = 100 * np.exp(np.cumsum(r))
    A = pd.DataFrame(adj, index=idx)
    return vf.Daily(A, A.copy(), "rel-test", str(idx[-1].date()), {})


@pytest.fixture(scope="module")
def daily():
    return _daily()


@pytest.mark.parametrize("h", [1, 21, 126])
def test_price_model_is_calibrated_out_of_sample_and_picks_a_method(daily, h):
    pm = vf.price_model(daily, h)
    bt = pm["backtest"]
    assert bt["tests"] > 200 and pm["method"] in vf.PRICE_METHODS and bt["best"] == pm["method"]
    assert 0.70 <= bt["scores"][pm["method"]]["coverage"] <= 0.90          # target 0.80
    assert len(pm["live"]) == 8 and all(v["sigma"] > 0 for v in pm["live"].values())
    assert pm["dd10"] <= pm["dd50"] <= 0


def test_training_windows_end_before_each_test_year(daily):
    """A window whose outcome is still running on Jan 1 must not be used to fit that year (no look-ahead)."""
    P, _, _ = vf._price_panel(daily, 63)
    start = np.datetime64("2018-01-01")
    tr = (P["end"] < start) & P["sub"]
    assert tr.any() and P["end"][tr].max() < start and (P["origin"][tr] < start - np.timedelta64(63, "D")).all()


def test_a_recent_listing_still_gets_a_forecast():
    d = _daily(n_days=150, tickers=("NEW",))
    pm = vf.price_model(_daily(), 5)                                      # model fitted on long histories ...
    ts = vf._ticker_series(d.adj["NEW"])                                  # ... a 150-day listing still has usable features
    assert ts is not None and np.isfinite(ts[3][-1]).all() and ts[6][-1]
    assert pm["live"]


# ------------------------------------------------------------------ execution tape fixtures
def _tape(tmp_path, daily, tickers=("AAA", "BBB"), seed=3, quotes=True):
    """Hourly token bars that follow the synthetic stock and keep trading overnight (next day's gap shows up early)."""
    tape = et.Tape(tmp_path / "tape.sqlite")
    tape.sync_products([et.Product(f"mint{t}", t, "xStocks", f"{t}x") for t in tickers])
    rng = np.random.default_rng(seed)
    days = daily.adj.index[-170:]
    for t in tickers:
        tape.execute("UPDATE products SET decimals = 8 WHERE mint = ?", (f"mint{t}",))
        bars = []
        closes = daily.raw[t]
        for d0, d1 in zip(days, days[1:]):
            c0, c1 = closes[d0], closes[d1]
            start = pd.Timestamp(vf.session_close(d0.date())).tz_convert("UTC")
            stop = pd.Timestamp(vf.session_close(d1.date())).tz_convert("UTC")
            hours = int((stop - start).total_seconds() // 3600)
            path = c0 * np.exp(np.linspace(0, np.log(c1 / c0), hours) + rng.normal(0, 0.0005, hours))
            for k in range(hours):
                ts = int((start + pd.Timedelta(hours=k)).timestamp())
                bars.append([ts, path[k], path[k], path[k], path[k], 5000.0])
        last = pd.Timestamp(vf.session_close(days[-1].date())).tz_convert("UTC")      # the token keeps trading after the last close
        for k in range(10):
            px = float(closes[days[-1]]) * (1 + 0.001 * k)
            bars.append([int((last + pd.Timedelta(hours=k)).timestamp()), px, px, px, px, 3000.0])
        tape.save_bars(f"mint{t}", "pool1", "hour", bars)
        if quotes:
            now = dt.datetime(2026, 9, 29, 3, 0, tzinfo=dt.timezone.utc)
            rows = []
            for j in range(12):
                ts = (now - dt.timedelta(hours=3 * j)).isoformat().replace("+00:00", "Z")
                px = float(closes.iloc[-1])
                for side, usd, slip in (("BUY", 100, 1.0005), ("BUY", 1000, 1.001), ("BUY", 10000, 1.004), ("BUY", 100000, 1.02),
                                        ("SELL", 100, 0.9995), ("SELL", 1000, 0.999), ("SELL", 10000, 0.996)):
                    tok = usd / (px * slip) if side == "BUY" else usd / px
                    usdc_out = usd * (slip if side == "SELL" else 1)
                    rows.append({"set_id": f"{t}-{j}", "ts": ts, "ticker": t, "mint": f"mint{t}", "side": side, "usd": float(usd),
                                 "in_atoms": int(usd * 1e6) if side == "BUY" else int(tok * 1e8),
                                 "out_atoms": int(tok * 1e8) if side == "BUY" else int(usdc_out * 1e6),
                                 "impact_pct": 0.0, "route": "test", "network": "test", "source": "test", "error": None})
            tape.executemany("INSERT INTO quotes(set_id, ts, ticker, mint, side, usd, in_atoms, out_atoms, impact_pct, route, network, source, error) "
                             "VALUES(:set_id,:ts,:ticker,:mint,:side,:usd,:in_atoms,:out_atoms,:impact_pct,:route,:network,:source,:error)", rows)
    return vf.TapeReader(tmp_path / "tape.sqlite")


def test_offhours_model_uses_the_token_move_since_the_close(tmp_path, daily):
    reader = _tape(tmp_path, daily)
    pm = vf.price_model(daily, 1)
    om = vf.offhours_model(daily, pm, reader, 1, now=dt.datetime.combine(daily.adj.index[-1].date() + dt.timedelta(days=1),
                                                                          dt.time(4, 0), vf.NY))
    bt = om["backtest"]
    assert om["rows"] > 200 and bt["tests"] > 50
    # the synthetic token already moves toward the next close overnight: the execution model must win clearly
    assert om["use"] and bt["exec"]["width"] < bt["price"]["width"] and om["beta"] > 0.3
    live = om["live"]["AAA"]
    assert live["in_window"] and live["sigma"] > 0 and "center" in live


def test_token_model_backtests_hourly_ranges(tmp_path, daily):
    reader = _tape(tmp_path, daily, quotes=False)
    sessions = {d.date() for d in daily.adj.index}
    tm = vf.token_model(reader, sessions, 4)
    assert tm["backtest"]["tests"] > 100 and 0.5 < tm["backtest"]["model"]["coverage"] < 1.0
    assert set(tm["live"]) == {"AAA", "BBB"} and tm["live"]["AAA"]["price"] > 0


def test_cost_profile_interpolates_by_size_and_flags_beyond_the_largest_quote(tmp_path, daily):
    reader = _tape(tmp_path, daily)
    sessions = {d.date() for d in daily.adj.index}
    now = dt.datetime(2026, 9, 29, 4, 0, tzinfo=dt.timezone.utc)
    c = vf.cost_profile(reader, "AAA", 1000, sessions, now=now)
    assert c["samples"] == 12 and 4 < c["now"]["buy_bps"] < 16 and not c["now"]["extrapolated"]
    big = vf.cost_profile(reader, "AAA", 300_000, sessions, now=now)
    assert big["now"]["extrapolated"] and big["now"]["buy_bps"] > 200
    assert vf.cost_profile(reader, "ZZZ", 1000, sessions, now=now)["samples"] == 0
    # another product of the same stock (e.g. Ondo vs xStocks) is not mixed into the followed product's quotes
    assert vf.cost_profile(reader, "AAA", 1000, sessions, now=now, mint="mintBBB")["samples"] == 0


def test_premium_is_hidden_when_the_token_unit_is_not_one_share(tmp_path, daily):
    reader = _tape(tmp_path, daily, quotes=False)
    p = vf.premium_profile(daily, reader, "AAA")
    assert p["n"] > 100 and abs(p["p50"]) < 0.01
    scaled = vf.Daily(daily.adj, daily.raw * 10, daily.release_id, daily.as_of, {})     # e.g. after a 10:1 split
    assert vf.premium_profile(scaled, reader, "AAA").get("scaled")


def test_the_daily_history_continues_with_the_tokens_closing_trades(tmp_path, daily):
    reader = _tape(tmp_path, daily, quotes=False)
    cut = vf.Daily(daily.adj.iloc[:-5], daily.raw.iloc[:-5], "rel-test", str(daily.adj.index[-6].date()), {})
    now = dt.datetime.combine(daily.adj.index[-1].date() + dt.timedelta(days=1), dt.time(2, 0), dt.timezone.utc)
    ext = vf.extend_with_tape(cut, reader, now=now)
    new_days = ext.adj.index[len(cut.adj):]
    # exchange holidays are skipped (the synthetic calendar has none), every real session after the cut is continued
    assert ext.provenance["_extension"]["sessions"] == len(new_days) >= 4 and ext.as_of == str(daily.adj.index[-1].date())
    # the synthetic token ends each session at the stock's close, so the continued prices match the real ones
    assert np.allclose(ext.adj.loc[new_days, "AAA"].to_numpy(), daily.adj.loc[new_days, "AAA"].to_numpy(), rtol=0.003)
    assert "_extension" not in vf.extend_with_tape(daily, reader, now=now).provenance      # nothing to add


def test_forecasts_are_scored_when_their_horizon_is_over(tmp_path, daily):
    from types import SimpleNamespace
    from xtxc_agent.core.claims import Claims
    from xtxc_agent.core.db import Database
    from xtxc_agent.core.forecasts import Forecaster
    from xtxc_agent.core.ledger import Ledger
    reader = _tape(tmp_path, daily, quotes=False)
    db = Database(tmp_path / "a.db")
    claims = Claims(db)
    fc = Forecaster(SimpleNamespace(data_dir=tmp_path, mode="demo"), db, Ledger(db), lambda: {}, claims=claims, tape_path=tmp_path / "tape.sqlite")
    fc.models.daily = lambda: daily
    day = daily.adj.index[-3].date()
    close = float(daily.raw["AAA"].loc[daily.adj.index[-3]])
    import json as _j
    inside = claims.add(wallet="W", plan_id="fc_1", subject="AAA", metric="forecast_range", predicted=close, tolerance=close * 0.05, unit="USD",
                        statement_ko="s", ref=_j.dumps({"due": day.isoformat(), "hours": 0, "days": 5}))
    outside = claims.add(wallet="W", plan_id="fc_1", subject="AAA", metric="forecast_range", predicted=close * 2, tolerance=1, unit="USD",
                         statement_ko="s", ref=_j.dumps({"due": day.isoformat(), "hours": 0, "days": 5}))
    later = claims.add(wallet="W", plan_id="fc_2", subject="AAA", metric="forecast_range", predicted=close, tolerance=1, unit="USD",
                       statement_ko="s", ref=_j.dumps({"due": "2099-01-01", "hours": 0, "days": 5}))
    now = dt.datetime.combine(daily.adj.index[-1].date(), dt.time(23, 0), dt.timezone.utc)
    assert fc.score_due(now) == {"scored": 2, "void": 0, "waiting": 1}
    got = {r["claim_id"]: r["verdict"] for r in db.all("SELECT claim_id, verdict FROM claims")}
    assert got == {inside["claim_id"]: "hit", outside["claim_id"]: "miss", later["claim_id"]: None}
