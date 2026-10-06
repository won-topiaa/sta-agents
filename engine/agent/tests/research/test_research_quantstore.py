"""Verified quant-store release: generated rows never reach research; real rows are verified; gaps use the reference."""
import datetime as dt

import numpy as np
import pytest

from xtxc_agent.research import marketdata as md
from xtxc_agent.research import quantstore as qs


def _dates(n):
    d, out = dt.date(2026, 1, 5), []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


def _walk(seed, n, base):
    r = np.random.RandomState(seed).normal(0.0005, 0.01, n)
    return list(np.round(base * np.cumprod(1 + r), 4))


@pytest.fixture
def store(tmp_path):
    n = 60
    dates = _dates(n)
    series = {
        "SPY": _walk(1, n, 500.0),
        "AAA": _walk(2, n, 100.0),                                                     # real, agrees with the reference
        "SPCX": list(qs.regenerate_synthetic_close(qs.SYNTHETIC_CONFIGS["SPCX"], n)),  # the collector's fallback
        "BBB": list(qs.regenerate_synthetic_close(qs.DEFAULT_SYNTHETIC, n)),           # fallback with the default seed
        "CCC": _walk(3, n, 50.0),                                                      # real-looking, but not what the market did
    }
    root = tmp_path / "store"
    (root / "data").mkdir(parents=True)
    lines = ["date,open,high,low,close,volume,symbol"]
    for sym, closes in series.items():
        for d, c in zip(dates, closes):
            hi = c * 1.01 if sym != "AAA" or d != dates[5] else c * 0.99                 # one broken OHLC row in AAA
            lines.append(f"{d},{c},{hi},{c*0.99},{c},1000,{sym}")
    (root / qs.DAILY_MASTER).write_text("\n".join(lines) + "\n")
    ref = {
        "SPY": [(d, c * 1.002, c, 5000) for d, c in zip(dates, series["SPY"])],
        "AAA": [(d, c * 1.01, c, 900) for d, c in zip(dates, series["AAA"])],           # raw close differs (dividends)
        "SPCX": [(d, 120.0 + i, 120.0 + i, 7000) for i, d in enumerate(dates[40:])],     # real listing starts later
        "CCC": [(d, c, c, 800) for d, c in zip(dates, _walk(4, n, 50.0))],
        "MSFT": [(d, 400.0 + i, 400.0 + i, 9000) for i, d in enumerate(dates)],          # not in the store
    }
    return root, dates, series, ref


def test_generated_rows_are_quarantined_and_real_rows_verified(tmp_path, store):
    root, dates, series, ref = store
    data = tmp_path / "data"

    def reference(t):
        if t not in ref:
            raise md.MarketDataError(f"{t}: no reference")
        return ref[t]
    rel = qs.build_release(["AAA", "SPCX", "BBB", "CCC", "MSFT", "SPY"], store_root=root, root=data, start=dates[0], reference=reference)
    t = rel["tickers"]
    assert t["AAA"]["provenance"].startswith("quant store") and t["AAA"]["verification"]["ok"] and t["AAA"]["invalid_ohlc_rows"] == 1
    rows = md._csv_to_rows(md._read_object(data, t["AAA"]["object"]))
    assert rows[0][2] == pytest.approx(series["AAA"][0]) and rows[0][1] == pytest.approx(series["AAA"][0] * 1.01)  # adj from store, raw from ref
    assert "generated" in t["SPCX"]["provenance"] and t["SPCX"]["quarantined_rows"] == 60
    assert t["SPCX"]["rows"] == 20 and t["SPCX"]["first"] == dates[40]                 # only the real listing period
    assert "generated" in t["BBB"]["provenance"] and t["BBB"]["rows"] == 0 and t["BBB"]["object"] is None  # never filled
    assert "failed verification" in t["CCC"]["provenance"] and not t["CCC"]["verification"]["ok"]
    assert t["MSFT"]["provenance"] == "reference: not in the quant store" and t["MSFT"]["rows"] == 60
    assert (data / "prices" / qs.RELEASE_FILE).exists() and rel["store"]["symbols"] == 5


def test_research_snapshots_read_the_release_without_network(tmp_path, store, monkeypatch):
    root, dates, series, ref = store
    data = tmp_path / "data"
    qs.build_release(["AAA", "SPCX", "BBB"], store_root=root, root=data, start=dates[0], reference=lambda t: ref.get(t, []))
    monkeypatch.setenv("XTXC_PRICE_SOURCE", "quant")
    monkeypatch.setattr(md, "refresh_ticker", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no network in quant mode")))
    snap = md.build_snapshot(["AAA", "SPCX", "BBB"], start=dates[0], root=data)
    assert snap.source == qs.SOURCE and snap.coverage["BBB"]["rows"] == 0 and snap.coverage["SPCX"]["first"] == dates[40]
    px = md.load_prices(snap.snapshot_id, root=data)
    assert px["AAA"].iloc[-1] == pytest.approx(series["AAA"][-1]) and px["SPCX"].first_valid_index().date().isoformat() == dates[40]
    rec = md.snapshot_record(snap.snapshot_id, root=data)
    assert "generated" in rec["provenance"]["SPCX"]["provenance"] and rec["manifest"]["release_id"]
