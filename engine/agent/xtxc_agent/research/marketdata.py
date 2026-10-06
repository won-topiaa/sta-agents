"""Daily price data for the research engine: Yahoo chart v8 -> local cache -> immutable snapshots.

Source and rights
-----------------
Prices come from Yahoo's public chart endpoint (``query1.finance.yahoo.com/v8/finance/chart``).
It is an *unofficial* public endpoint, so every snapshot carries the rights record fixed by the
contract (``RIGHTS``): usable for a demo research run only, never redistributed, never sent to a
model.  Stooq is not used (it now serves a JavaScript proof-of-work challenge; we do not bypass it).

Politeness
----------
* at least ``MIN_REQUEST_INTERVAL_S`` (1 s) between any two HTTP requests made by this process;
* retries with exponential backoff (honours ``Retry-After``) on 429 / 5xx / network errors;
* cache first: a ticker is re-fetched only when its cache entry is older than ``max_age_hours``,
  and then incrementally (last cached date - 10 days .. now).  If the overlapping rows changed
  (a new dividend/split rescales Yahoo's adjusted close retroactively) the full history is
  re-fetched instead of splicing inconsistent series.

Storage (``$XTXC_DATA_DIR`` or ``agent/data``)
----------------------------------------------
* ``prices/<TICKER>.json``            cache pointer: object hash, fetch log, Yahoo meta, events.
* ``prices/objects/<sha256>.csv.gz``  content-addressed compact CSV ``date,close,adjclose,volume``.
  The sha256 is over the *uncompressed* canonical CSV bytes, so it is the per-ticker content hash.
* ``snapshots/<snapshot_id>.json``    immutable snapshot manifest.  Never rewritten.

Only complete sessions are stored: a bar dated today (exchange time) is dropped until
17:00 America/New_York, because during the session Yahoo returns a moving, partial bar.
Raw responses are not kept (size); their sha256, URL and fetch time are logged per ticker.

Snapshot id
-----------
``snapshot_id = sha256(canonical_json(manifest))`` where ``manifest`` holds the schema, source,
rights, fields, requested start, ``as_of`` and the per-ticker content hashes.  The same inputs give
the same id.  Coverage/meta are stored next to the manifest but are derived from it.

Numbers are float64 (adjusted closes are float32-precision upstream); prices are written with
10 significant digits.
"""
from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import io
import json
import os
import random
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from zoneinfo import ZoneInfo

import httpx
import pandas as pd

__all__ = [
    "DataSnapshot",
    "RIGHTS",
    "SOURCE",
    "build_snapshot",
    "load_prices",
    "load_snapshot",
    "latest_snapshot_id",
    "snapshot_record",
    "yahoo_symbol",
    "data_dir",
    "prune_price_objects",
    "quality_report",
]

SOURCE = "yahoo-chart-v8"
RIGHTS = {
    "ingestion": "unofficial-public",
    "research": "demo-only",
    "display": "demo-only",
    "redistribution": "no",
    "model_processing": "no",
}
SNAPSHOT_SCHEMA = "xtxc.research.snapshot/v1"
FIELDS = ("close", "adjclose", "volume")
USER_AGENT = "Mozilla/5.0 (compatible; xtxc-agent/0.1)"
HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
MIN_REQUEST_INTERVAL_S = 1.0
MAX_ATTEMPTS = 4
INCREMENTAL_OVERLAP_DAYS = 10
SESSION_FINAL_HOUR_NY = 17  # a bar dated D is treated as final after 17:00 New York time on D
NY = ZoneInfo("America/New_York")
_META_KEYS = (
    "symbol", "longName", "shortName", "instrumentType", "exchangeName", "fullExchangeName",
    "currency", "firstTradeDate", "exchangeTimezoneName", "regularMarketTime",
)


class MarketDataError(RuntimeError):
    pass


# --------------------------------------------------------------------------------------------
# paths / small helpers


def data_dir() -> Path:
    env = os.environ.get("XTXC_DATA_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[2] / "data"


def _prices_dir(root: Path) -> Path:
    return root / "prices"


def _objects_dir(root: Path) -> Path:
    return root / "prices" / "objects"


def _snapshots_dir(root: Path) -> Path:
    return root / "snapshots"


def yahoo_symbol(ticker: str) -> str:
    """Yahoo uses '-' for share classes: BRK.B -> BRK-B."""
    return ticker.strip().upper().replace(".", "-")


def _canonical_json(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _fmt_float(x) -> str:
    if x is None:
        return ""
    return format(float(x), ".10g")


# --------------------------------------------------------------------------------------------
# canonical CSV rows: (date 'YYYY-MM-DD', close float|None, adjclose float, volume int|None)


def _rows_to_csv(rows: list[tuple]) -> bytes:
    out = ["date,close,adjclose,volume"]
    for d, c, a, v in rows:
        out.append(f"{d},{_fmt_float(c)},{_fmt_float(a)},{'' if v is None else int(v)}")
    return ("\n".join(out) + "\n").encode("ascii")


def _csv_to_rows(data: bytes) -> list[tuple]:
    rows = []
    lines = data.decode("ascii").splitlines()
    for line in lines[1:]:
        if not line:
            continue
        d, c, a, v = line.split(",")
        rows.append((d, float(c) if c else None, float(a), int(v) if v else None))
    return rows


def _write_object(root: Path, csv_bytes: bytes) -> str:
    h = _sha256(csv_bytes)
    path = _objects_dir(root) / f"{h}.csv.gz"
    if not path.exists():
        _atomic_write(path, gzip.compress(csv_bytes, compresslevel=9, mtime=0))
    return h


def _read_object(root: Path, h: str, verify: bool = True) -> bytes:
    path = _objects_dir(root) / f"{h}.csv.gz"
    if not path.exists():
        raise MarketDataError(f"price object missing: {path}")
    data = gzip.decompress(path.read_bytes())
    if verify and _sha256(data) != h:
        raise MarketDataError(f"price object corrupted (hash mismatch): {path}")
    return data


# --------------------------------------------------------------------------------------------
# HTTP (polite, rate limited, retried)

_rate_lock = threading.Lock()
_last_request_at = 0.0


def _throttle() -> None:
    global _last_request_at
    with _rate_lock:
        wait = MIN_REQUEST_INTERVAL_S - (time.monotonic() - _last_request_at)
        if wait > 0:
            time.sleep(wait)
        _last_request_at = time.monotonic()


def _http_get_chart(symbol: str, period1: int, period2: int, client: httpx.Client) -> tuple[dict, bytes, str]:
    params = {
        "period1": str(period1),
        "period2": str(period2),
        "interval": "1d",
        "events": "div,splits",
        "includeAdjustedClose": "true",
    }
    last_err: Exception | None = None
    for attempt in range(MAX_ATTEMPTS):
        host = HOSTS[attempt % len(HOSTS)]
        url = f"https://{host}/v8/finance/chart/{symbol}"
        _throttle()
        try:
            resp = client.get(url, params=params)
        except httpx.HTTPError as exc:  # network / timeout
            last_err = exc
        else:
            if resp.status_code == 200:
                raw = resp.content
                try:
                    payload = json.loads(raw)
                except ValueError as exc:
                    last_err = exc
                else:
                    return payload, raw, str(resp.request.url)
            elif resp.status_code == 404:
                # Yahoo answers 404 with a JSON error body for unknown symbols: do not retry.
                raise MarketDataError(f"{symbol}: HTTP 404 {resp.text[:200]}")
            else:
                last_err = MarketDataError(f"{symbol}: HTTP {resp.status_code}")
                ra = resp.headers.get("Retry-After")
                if ra and ra.isdigit():
                    time.sleep(min(int(ra), 60))
        time.sleep(min(2 ** (attempt + 1), 30) + random.uniform(0, 0.5))
    raise MarketDataError(f"{symbol}: failed after {MAX_ATTEMPTS} attempts: {last_err}")


def _parse_chart(payload: dict, now_utc: dt.datetime) -> tuple[list[tuple], dict, list[dict], int]:
    """Return (final rows, meta subset, events, dropped_rows)."""
    chart = payload.get("chart") or {}
    if chart.get("error"):
        raise MarketDataError(f"yahoo error: {chart['error']}")
    results = chart.get("result") or []
    if not results:
        raise MarketDataError("yahoo returned no result")
    r = results[0]
    meta_full = r.get("meta") or {}
    meta = {k: meta_full.get(k) for k in _META_KEYS if k in meta_full}
    tz = ZoneInfo(meta_full.get("exchangeTimezoneName") or "America/New_York")
    ts_list = r.get("timestamp") or []
    ind = r.get("indicators") or {}
    quote = (ind.get("quote") or [{}])[0]
    closes = quote.get("close") or [None] * len(ts_list)
    vols = quote.get("volume") or [None] * len(ts_list)
    adj = ((ind.get("adjclose") or [{}])[0]).get("adjclose") or [None] * len(ts_list)
    now_local = now_utc.astimezone(NY)
    by_date: dict[str, tuple] = {}
    dropped = 0
    for i, ts in enumerate(ts_list):
        local = dt.datetime.fromtimestamp(ts, tz)
        d = local.date()
        final_at = dt.datetime.combine(d, dt.time(SESSION_FINAL_HOUR_NY, 0), NY)
        if now_local < final_at:
            dropped += 1  # partial (in-progress) session
            continue
        a = adj[i] if i < len(adj) else None
        if a is None or not (a > 0):
            dropped += 1
            continue
        c = closes[i] if i < len(closes) else None
        v = vols[i] if i < len(vols) else None
        by_date[d.isoformat()] = (d.isoformat(), c, a, v)  # duplicate dates: keep the last
    rows = [by_date[k] for k in sorted(by_date)]
    events = []
    ev = r.get("events") or {}
    for kind in ("dividends", "splits"):
        for item in (ev.get(kind) or {}).values():
            d = dt.datetime.fromtimestamp(int(item["date"]), tz).date().isoformat()
            if kind == "dividends":
                events.append({"date": d, "type": "dividend", "amount": item.get("amount")})
            else:
                events.append({
                    "date": d, "type": "split",
                    "ratio": f"{item.get('numerator')}:{item.get('denominator')}",
                })
    events.sort(key=lambda e: (e["date"], e["type"]))
    return rows, meta, events, dropped


def _unix(d: dt.date) -> int:
    return int(dt.datetime.combine(d, dt.time(0, 0), dt.timezone.utc).timestamp())


def _fetch(symbol: str, start: dt.date, now_utc: dt.datetime, client: httpx.Client) -> dict:
    period2 = int(now_utc.timestamp()) + 86400
    payload, raw, url = _http_get_chart(symbol, _unix(start), period2, client)
    rows, meta, events, dropped = _parse_chart(payload, now_utc)
    return {
        "rows": rows, "meta": meta, "events": events, "dropped": dropped,
        "log": {"at": _iso(now_utc), "url": url, "raw_sha256": _sha256(raw), "bytes": len(raw)},
    }


# --------------------------------------------------------------------------------------------
# per-ticker cache


def _entry_path(root: Path, ticker: str) -> Path:
    return _prices_dir(root) / f"{ticker}.json"


def _read_entry(root: Path, ticker: str) -> dict | None:
    p = _entry_path(root, ticker)
    if not p.exists():
        return None
    return json.loads(p.read_text())


def _rows_equal(a: tuple, b: tuple) -> bool:
    def close(x, y):
        if x is None or y is None:
            return x is None and y is None
        return abs(x - y) <= 1e-6 * max(abs(x), abs(y), 1e-12)
    return close(a[1], b[1]) and close(a[2], b[2])


def _store_entry(root: Path, ticker: str, start: str, rows: list[tuple], fetched: dict,
                 mode: str, prev: dict | None) -> dict:
    csv_bytes = _rows_to_csv(rows)
    obj = _write_object(root, csv_bytes)
    log = list((prev or {}).get("fetch_log", []))[-9:]
    log.append({**fetched["log"], "mode": mode, "rows": len(rows), "object": obj})
    entry = {
        "ticker": ticker,
        "yahoo_symbol": yahoo_symbol(ticker),
        "requested_start": start,
        "object": obj,
        "rows": len(rows),
        "first": rows[0][0] if rows else None,
        "last": rows[-1][0] if rows else None,
        "fetched_at": fetched["log"]["at"],
        "meta": fetched["meta"],
        "events": fetched["events"],
        "fetch_log": log,
    }
    _atomic_write(_entry_path(root, ticker), json.dumps(entry, indent=1, sort_keys=True).encode())
    return entry


def refresh_ticker(ticker: str, start: str = "2010-01-01", *, refresh: str = "auto",
                   max_age_hours: float = 6.0, root: Path | None = None,
                   client: httpx.Client | None = None, now: dt.datetime | None = None) -> dict:
    """Make sure the cache holds ``ticker`` from ``start``; return the cache entry.

    refresh: "auto" (fetch when older than max_age_hours), "never" (cache only), "always".
    """
    root = root or data_dir()
    now = now or _utcnow()
    prev = _read_entry(root, ticker)
    covers_start = prev is not None and prev.get("requested_start", "9999") <= start
    if refresh == "never":
        if prev is None:
            raise MarketDataError(f"{ticker}: not cached and refresh='never'")
        return prev
    if prev is not None and covers_start and refresh == "auto":
        age_h = (now - dt.datetime.fromisoformat(prev["fetched_at"].replace("Z", "+00:00"))).total_seconds() / 3600
        if age_h < max_age_hours:
            return prev
    own_client = client is None
    client = client or httpx.Client(headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                                    timeout=30.0, follow_redirects=True)
    try:
        sym = yahoo_symbol(ticker)
        if prev is not None and covers_start and prev.get("last") and refresh != "always":
            old_rows = _csv_to_rows(_read_object(root, prev["object"]))
            inc_start = dt.date.fromisoformat(prev["last"]) - dt.timedelta(days=INCREMENTAL_OVERLAP_DAYS)
            fetched = _fetch(sym, inc_start, now, client)
            new_by_date = {r[0]: r for r in fetched["rows"]}
            overlap = [r for r in old_rows if r[0] in new_by_date]
            consistent = bool(overlap) and all(_rows_equal(r, new_by_date[r[0]]) for r in overlap)
            if consistent:
                cutoff = fetched["rows"][0][0]
                merged = [r for r in old_rows if r[0] < cutoff] + fetched["rows"]
                fetched["events"] = sorted(
                    {json.dumps(e, sort_keys=True) for e in (prev.get("events") or []) + fetched["events"]})
                fetched["events"] = [json.loads(e) for e in fetched["events"]]
                return _store_entry(root, ticker, prev["requested_start"], merged, fetched, "incremental", prev)
            # adjusted history moved (dividend/split) or no overlap: fall through to a full refetch
        fetched = _fetch(sym, dt.date.fromisoformat(start), now, client)
        return _store_entry(root, ticker, start, fetched["rows"], fetched, "full", prev)
    finally:
        if own_client:
            client.close()


# --------------------------------------------------------------------------------------------
# snapshots


@dataclass(frozen=True)
class DataSnapshot:
    snapshot_id: str
    source: str
    rights: dict
    as_of: str
    tickers: tuple[str, ...]
    coverage: dict


def _coverage(per_ticker_rows: dict[str, list[tuple]], as_of: str) -> dict:
    calendar = sorted({r[0] for rows in per_ticker_rows.values() for r in rows})
    cov = {}
    for t, rows in per_ticker_rows.items():
        if not rows:
            cov[t] = {"first": None, "last": None, "rows": 0, "missing": []}
            continue
        have = {r[0] for r in rows}
        first = rows[0][0]
        missing = [d for d in calendar if first <= d <= as_of and d not in have]
        cov[t] = {"first": first, "last": rows[-1][0], "rows": len(rows), "missing": missing}
    return cov


def build_snapshot(tickers: list[str], start: str = "2010-01-01", *, refresh: str = "auto",
                   max_age_hours: float = 6.0, as_of: str | None = None,
                   root: Path | None = None) -> DataSnapshot:
    """Fetch/refresh (cache first, >=1 s between requests) and seal an immutable snapshot.

    ``as_of`` defaults to the latest complete session found in the data; pass a date to cap it.
    Tickers whose fetch fails are kept in ``tickers`` with ``rows: 0`` in coverage (and the
    error in the manifest's ``errors``) so a missing name is visible, never silently dropped.
    """
    if os.environ.get("XTXC_PRICE_SOURCE", "yahoo") == "quant":
        # research runs on the verified XTXC quant-store release (no network); see quantstore.py
        from . import quantstore
        return quantstore.build_snapshot(tickers, start, as_of=as_of, root=root)
    root = root or data_dir()
    tickers = sorted({t.strip().upper() for t in tickers})
    if not tickers:
        raise ValueError("no tickers")
    dt.date.fromisoformat(start)
    entries: dict[str, dict] = {}
    errors: dict[str, str] = {}
    client = httpx.Client(headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                          timeout=30.0, follow_redirects=True)
    try:
        for t in tickers:
            try:
                entries[t] = refresh_ticker(t, start, refresh=refresh, max_age_hours=max_age_hours,
                                            root=root, client=client)
            except MarketDataError as exc:
                prev = _read_entry(root, t)
                if prev is not None and prev.get("requested_start", "9999") <= start:
                    entries[t] = prev  # stale but real data beats nothing; staleness shows in coverage
                    errors[t] = f"refresh failed, using cache from {prev['fetched_at']}: {exc}"
                else:
                    errors[t] = str(exc)
    finally:
        client.close()

    all_rows = {t: _csv_to_rows(_read_object(root, e["object"])) for t, e in entries.items()}
    if as_of is None:
        lasts = [rows[-1][0] for rows in all_rows.values() if rows]
        if not lasts:
            raise MarketDataError("no price data for any ticker")
        as_of = max(lasts)
    dt.date.fromisoformat(as_of)
    sliced: dict[str, list[tuple]] = {}
    content: dict[str, str | None] = {}
    for t in tickers:
        rows = [r for r in all_rows.get(t, []) if start <= r[0] <= as_of]
        sliced[t] = rows
        content[t] = _write_object(root, _rows_to_csv(rows)) if t in all_rows else None
    manifest = {
        "schema": SNAPSHOT_SCHEMA,
        "source": SOURCE,
        "rights": RIGHTS,
        "fields": list(FIELDS),
        "start": start,
        "as_of": as_of,
        "tickers": tickers,
        "content": content,
    }
    snapshot_id = _sha256(_canonical_json(manifest))
    coverage = _coverage(sliced, as_of)
    for t in tickers:
        if t not in all_rows:
            coverage[t] = {"first": None, "last": None, "rows": 0, "missing": []}
    path = _snapshots_dir(root) / f"{snapshot_id}.json"
    if not path.exists():
        record = {
            "snapshot_id": snapshot_id,
            "manifest": manifest,
            "coverage": coverage,
            "errors": errors,
            "yahoo_meta": {t: e.get("meta") for t, e in entries.items()},
            "events": {t: [ev for ev in (e.get("events") or []) if start <= ev["date"] <= as_of]
                       for t, e in entries.items()},
            "fetched_at": {t: e.get("fetched_at") for t, e in entries.items()},
            "created_at": _iso(_utcnow()),
            "notes": [
                "Prices are Yahoo adjusted closes (splits and dividends) from an unofficial public endpoint.",
                "Coverage 'missing' lists exchange dates (union calendar of the snapshot) after the ticker's "
                "first row with no row for that ticker.",
                "The universe is today's tokenized list; delisted companies are absent (survivorship).",
            ],
        }
        _atomic_write(path, json.dumps(record, indent=1, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    return load_snapshot(snapshot_id, root=root)


def snapshot_record(snapshot_id: str, root: Path | None = None) -> dict:
    """The full stored snapshot record (manifest, coverage, Yahoo meta, events, errors)."""
    root = root or data_dir()
    path = _snapshots_dir(root) / f"{snapshot_id}.json"
    if not path.exists():
        raise MarketDataError(f"unknown snapshot {snapshot_id}")
    rec = json.loads(path.read_text())
    if _sha256(_canonical_json(rec["manifest"])) != snapshot_id:
        raise MarketDataError(f"snapshot {snapshot_id}: manifest hash mismatch")
    return rec


def load_snapshot(snapshot_id: str, root: Path | None = None) -> DataSnapshot:
    rec = snapshot_record(snapshot_id, root)
    m = rec["manifest"]
    return DataSnapshot(
        snapshot_id=snapshot_id,
        source=m["source"],
        rights=dict(m["rights"]),
        as_of=m["as_of"],
        tickers=tuple(m["tickers"]),
        coverage=rec["coverage"],
    )


def latest_snapshot_id(root: Path | None = None, tickers: Iterable[str] | None = None) -> str | None:
    """Most recently created snapshot (by created_at), or None.

    With ``tickers``, only snapshots containing all of them (with data) are considered: other
    callers build small per-brief snapshots, so "latest" alone may not cover what you need.
    """
    root = root or data_dir()
    want = {t.strip().upper() for t in tickers} if tickers is not None else set()
    best = None
    for p in _snapshots_dir(root).glob("*.json"):
        try:
            rec = json.loads(p.read_text())
        except ValueError:
            continue
        have = {t for t, h in rec["manifest"]["content"].items() if h}
        if not want <= have:
            continue
        key = (rec.get("created_at", ""), rec["manifest"]["as_of"], len(rec["manifest"]["tickers"]))
        if best is None or key > best[0]:
            best = (key, rec["snapshot_id"])
    return best[1] if best else None


_frame_cache: dict[tuple[str, str, str], pd.DataFrame] = {}
_FRAME_CACHE_MAX = 8


def load_prices(snapshot_id: str, field: str = "adjclose", root: Path | None = None) -> pd.DataFrame:
    """index = trading date (DatetimeIndex), columns = ticker, values = ``field`` (default adjclose).

    Dates are the union over the snapshot's tickers; a ticker has NaN before its first row and on
    any date it has no row (no filling).  Returns a fresh copy (callers may mutate it).
    """
    if field not in FIELDS:
        raise ValueError(f"field must be one of {FIELDS}")
    root = root or data_dir()
    key = (str(root), snapshot_id, field)
    if key not in _frame_cache:
        rec = snapshot_record(snapshot_id, root)
        m = rec["manifest"]
        cols = {}
        idx = {"close": 1, "adjclose": 2, "volume": 3}[field]
        for t in m["tickers"]:
            h = m["content"].get(t)
            if not h:
                cols[t] = pd.Series(dtype="float64")
                continue
            rows = _csv_to_rows(_read_object(root, h))
            cols[t] = pd.Series(
                [float("nan") if r[idx] is None else float(r[idx]) for r in rows],
                index=pd.DatetimeIndex([r[0] for r in rows]), dtype="float64")
        df = pd.DataFrame(cols).sort_index()
        df = df.reindex(columns=list(m["tickers"]))
        df.index.name = "date"
        while len(_frame_cache) >= _FRAME_CACHE_MAX:
            _frame_cache.pop(next(iter(_frame_cache)))
        _frame_cache[key] = df
    return _frame_cache[key].copy()


def quality_report(snapshot_id: str, threshold: float = 0.4, root: Path | None = None) -> dict:
    """Days whose adjusted-close move exceeds ``threshold`` (default 40%), per ticker, for review.

    Nothing is altered: large moves are usually real (GME 2021, DFDV/BMNR 2025 treasury pivots) but
    a bad split adjustment would also show up here.
    """
    px = load_prices(snapshot_id, root=root)
    r = px.pct_change(fill_method=None)
    out: dict[str, list] = {}
    for t in px.columns:
        col = r[t]
        hits = col[col.abs() > threshold]
        if len(hits):
            out[t] = [[str(d.date()), round(float(v), 4)] for d, v in hits.items()]
    return {"snapshot_id": snapshot_id, "threshold": threshold, "large_moves": out}


def prune_price_objects(root: Path | None = None, dry_run: bool = True) -> list[str]:
    """Delete price objects referenced by neither a snapshot nor a cache pointer."""
    root = root or data_dir()
    keep: set[str] = set()
    for p in _snapshots_dir(root).glob("*.json"):
        keep.update(h for h in json.loads(p.read_text())["manifest"]["content"].values() if h)
    for p in _prices_dir(root).glob("*.json"):
        keep.add(json.loads(p.read_text())["object"])
    removed = []
    for p in _objects_dir(root).glob("*.csv.gz"):
        h = p.name.split(".")[0]
        if h not in keep:
            removed.append(h)
            if not dry_run:
                p.unlink()
    return removed


def _main(argv: Iterable[str] | None = None) -> None:  # pragma: no cover - CLI helper
    import argparse

    from .universe import load_universe

    ap = argparse.ArgumentParser(description="build a price snapshot for the XTXC universe")
    ap.add_argument("--start", default="2010-01-01")
    ap.add_argument("--refresh", default="auto", choices=("auto", "never", "always"))
    ap.add_argument("--max-age-hours", type=float, default=6.0)
    args = ap.parse_args(list(argv) if argv is not None else None)
    tickers = [i.ticker for i in load_universe()]
    snap = build_snapshot(tickers, args.start, refresh=args.refresh, max_age_hours=args.max_age_hours)
    print(json.dumps({"snapshot_id": snap.snapshot_id, "as_of": snap.as_of, "tickers": len(snap.tickers),
                      "coverage": {t: {k: v for k, v in c.items() if k != "missing"} | {"missing_n": len(c["missing"])}
                                   for t, c in snap.coverage.items()}}, indent=1))


if __name__ == "__main__":  # pragma: no cover
    _main()
