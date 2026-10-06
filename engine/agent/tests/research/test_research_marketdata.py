import datetime as dt
import json
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import httpx
import numpy as np
import pytest

from xtxc_agent.research import marketdata as md
from xtxc_agent.research.universe import load_universe

NY = ZoneInfo("America/New_York")


def _chart(rows, symbol="AAA", instrument_type="EQUITY"):
    """Yahoo-shaped payload; rows = [(date, close, adjclose, volume)] (dates are NY sessions)."""
    ts = [int(dt.datetime.combine(dt.date.fromisoformat(d), dt.time(9, 30), NY).timestamp()) for d, *_ in rows]
    return {"chart": {"error": None, "result": [{
        "meta": {"symbol": symbol, "instrumentType": instrument_type, "longName": f"{symbol} Inc.",
                 "exchangeTimezoneName": "America/New_York", "currency": "USD"},
        "timestamp": ts,
        "indicators": {"quote": [{"close": [r[1] for r in rows], "volume": [r[3] for r in rows]}],
                       "adjclose": [{"adjclose": [r[2] for r in rows]}]},
        "events": {"dividends": {str(ts[-1]): {"amount": 0.1, "date": ts[-1]}}} if rows else {},
    }]}}


def _series(start="2026-01-05", n=30, base=10.0, adj_scale=1.0):
    days = []
    d = dt.date.fromisoformat(start)
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d.isoformat())
        d += dt.timedelta(days=1)
    return [(x, base + i, (base + i) * adj_scale, 1000 + i) for i, x in enumerate(days)]


class FakeYahoo:
    def __init__(self, data):
        self.data = data  # symbol -> rows
        self.calls = []

    def __call__(self, request: httpx.Request):
        sym = request.url.path.rsplit("/", 1)[-1]
        q = parse_qs(urlparse(str(request.url)).query)
        self.calls.append((sym, int(q["period1"][0])))
        assert request.headers["user-agent"] == md.USER_AGENT
        if sym not in self.data:
            return httpx.Response(404, json={"chart": {"result": None, "error": {"code": "Not Found"}}})
        p1 = dt.datetime.fromtimestamp(int(q["period1"][0]), dt.timezone.utc).date().isoformat()
        rows = [r for r in self.data[sym] if r[0] >= p1]
        return httpx.Response(200, json=_chart(rows, sym))


@pytest.fixture
def fake(monkeypatch, tmp_path):
    monkeypatch.setattr(md, "MIN_REQUEST_INTERVAL_S", 0.0)
    monkeypatch.setattr(md.time, "sleep", lambda s: None)
    y = FakeYahoo({"AAA": _series(), "BRK-B": _series(base=300.0)})
    client = httpx.Client(transport=httpx.MockTransport(y), headers={"User-Agent": md.USER_AGENT})
    return y, client, tmp_path


NOW = dt.datetime(2026, 3, 1, 12, 0, tzinfo=dt.timezone.utc)


def test_yahoo_symbol():
    assert md.yahoo_symbol("BRK.B") == "BRK-B"
    assert md.yahoo_symbol("nvda") == "NVDA"


def test_parse_drops_partial_session_null_and_duplicates():
    rows = [("2026-09-24", 10.0, 9.9, 1), ("2026-09-25", 11.0, None, 2), ("2026-09-25", 11.0, 10.9, 3),
            ("2026-09-28", 12.0, 12.0, 4)]
    payload = _chart(rows)
    now = dt.datetime(2026, 9, 28, 18, 12, tzinfo=dt.timezone.utc)  # 14:12 New York, market open
    out, meta, events, dropped = md._parse_chart(payload, now)
    assert [r[0] for r in out] == ["2026-09-24", "2026-09-25"]
    assert out[1][2] == 10.9  # duplicate date -> last row kept
    assert dropped == 2  # the null row and the in-progress 9/28 bar
    assert meta["instrumentType"] == "EQUITY"
    later = dt.datetime(2026, 9, 28, 21, 30, tzinfo=dt.timezone.utc)  # 17:30 New York
    assert [r[0] for r in md._parse_chart(payload, later)[0]][-1] == "2026-09-28"


def test_snapshot_id_is_deterministic_and_immutable(fake):
    y, client, root = fake
    for t in ("AAA", "BRK.B"):
        md.refresh_ticker(t, "2026-01-01", root=root, client=client, now=NOW)
    s1 = md.build_snapshot(["BRK.B", "AAA"], start="2026-01-01", refresh="never", root=root)
    path = root / "snapshots" / f"{s1.snapshot_id}.json"
    mtime = path.stat().st_mtime_ns
    s2 = md.build_snapshot(["AAA", "BRK.B", "aaa"], start="2026-01-01", refresh="never", root=root)
    assert s1.snapshot_id == s2.snapshot_id
    assert path.stat().st_mtime_ns == mtime  # never rewritten
    assert s1.tickers == ("AAA", "BRK.B")
    assert s1.source == "yahoo-chart-v8"
    assert s1.rights == {"ingestion": "unofficial-public", "research": "demo-only", "display": "demo-only",
                         "redistribution": "no", "model_processing": "no"}
    assert s1.coverage["AAA"] == {"first": "2026-01-05", "last": s1.as_of, "rows": 30, "missing": []}
    df = md.load_prices(s1.snapshot_id, root=root)
    assert list(df.columns) == ["AAA", "BRK.B"] and len(df) == 30
    assert df["AAA"].iloc[0] == 10.0
    # different as_of -> different id; the first snapshot still loads unchanged
    s3 = md.build_snapshot(["AAA", "BRK.B"], start="2026-01-01", refresh="never", as_of="2026-02-06", root=root)
    assert s3.snapshot_id != s1.snapshot_id and s3.as_of == "2026-02-06"
    assert md.load_prices(s1.snapshot_id, root=root).equals(df)
    # changed content -> different id
    y.data["AAA"] = _series(adj_scale=0.99)
    md.refresh_ticker("AAA", "2026-01-01", refresh="always", root=root, client=client, now=NOW)
    s4 = md.build_snapshot(["AAA", "BRK.B"], start="2026-01-01", refresh="never", root=root)
    assert s4.snapshot_id != s1.snapshot_id
    small = md.build_snapshot(["AAA"], start="2026-01-01", refresh="never", root=root)
    assert md.latest_snapshot_id(root=root, tickers=["AAA", "BRK.B"]) in (s1.snapshot_id, s3.snapshot_id, s4.snapshot_id)
    assert md.latest_snapshot_id(root=root, tickers=["ZZZ"]) is None
    assert small.tickers == ("AAA",)
    # manifest hash is verified on load
    rec = json.loads(path.read_text())
    rec["manifest"]["as_of"] = "2030-01-01"
    path.write_text(json.dumps(rec))
    md._frame_cache.clear()
    with pytest.raises(md.MarketDataError):
        md.load_prices(s1.snapshot_id, root=root)


def test_incremental_refresh_and_full_refetch_on_adjustment(fake):
    y, client, root = fake
    y.data["AAA"] = _series(n=20)
    e1 = md.refresh_ticker("AAA", "2026-01-01", root=root, client=client, now=NOW)
    assert e1["fetch_log"][-1]["mode"] == "full" and e1["rows"] == 20
    # cache is fresh -> no request
    n_calls = len(y.calls)
    md.refresh_ticker("AAA", "2026-01-01", root=root, client=client, now=NOW + dt.timedelta(hours=1))
    assert len(y.calls) == n_calls
    # new rows, unchanged history -> incremental request starting ~10 days before the last cached date
    y.data["AAA"] = _series(n=25)
    e2 = md.refresh_ticker("AAA", "2026-01-01", root=root, client=client, now=NOW + dt.timedelta(hours=7))
    assert e2["fetch_log"][-1]["mode"] == "incremental" and e2["rows"] == 25
    p1 = dt.datetime.fromtimestamp(y.calls[-1][1], dt.timezone.utc).date()
    assert p1 == dt.date.fromisoformat(e1["last"]) - dt.timedelta(days=10)
    # a dividend rescales the adjusted history -> overlap differs -> full refetch
    y.data["AAA"] = _series(n=26, adj_scale=0.98)
    e3 = md.refresh_ticker("AAA", "2026-01-01", root=root, client=client, now=NOW + dt.timedelta(hours=14))
    assert [x["mode"] for x in e3["fetch_log"]] == ["full", "incremental", "full"]
    rows = md._csv_to_rows(md._read_object(root, e3["object"]))
    assert rows[0][2] == pytest.approx(10.0 * 0.98)


def test_failed_ticker_is_reported_not_dropped(fake, monkeypatch):
    y, client, root = fake
    md.refresh_ticker("AAA", "2026-01-01", root=root, client=client, now=NOW)
    monkeypatch.setattr(md.httpx, "Client", lambda *a, **k: client)
    snap = md.build_snapshot(["AAA", "ZZZZ"], start="2026-01-01", refresh="auto", max_age_hours=1e9, root=root)
    assert snap.tickers == ("AAA", "ZZZZ")
    assert snap.coverage["ZZZZ"]["rows"] == 0
    assert "404" in md.snapshot_record(snap.snapshot_id, root=root)["errors"]["ZZZZ"]


def test_object_integrity_is_checked(fake):
    _, client, root = fake
    e = md.refresh_ticker("AAA", "2026-01-01", root=root, client=client, now=NOW)
    p = root / "prices" / "objects" / f"{e['object']}.csv.gz"
    import gzip
    p.write_bytes(gzip.compress(b"date,close,adjclose,volume\n2026-01-05,1,1,1\n"))
    with pytest.raises(md.MarketDataError):
        md._read_object(root, e["object"])


def test_real_snapshot_covers_all_50_tickers(real_snapshot_id):
    snap = md.load_snapshot(real_snapshot_id)
    universe = {i.ticker for i in load_universe()}
    assert universe <= set(snap.tickers)
    assert snap.source == "yahoo-chart-v8" and snap.rights == md.RIGHTS
    for t in universe:
        c = snap.coverage[t]
        assert c["rows"] > 0 and c["last"] == snap.as_of, t
    df = md.load_prices(real_snapshot_id)
    assert df.index.is_monotonic_increasing and df.index[-1].strftime("%Y-%m-%d") == snap.as_of
    vals = df.to_numpy()
    assert (vals[np.isfinite(vals)] > 0).all()
    # the market-data cache only (the same folder also holds the database and UI screenshots)
    total = sum(f.stat().st_size for sub in ("prices", "snapshots") for f in (md.data_dir() / sub).rglob("*") if f.is_file())
    assert total < 20 * 1024 * 1024  # keep the cache to a few MB


def test_quality_report_flags_large_moves_without_changing_data(real_snapshot_id):
    rep = md.quality_report(real_snapshot_id)
    assert "GME" in rep["large_moves"]  # January 2021 squeeze is in the data
    assert all(abs(v) > 0.4 for moves in rep["large_moves"].values() for _, v in moves)
