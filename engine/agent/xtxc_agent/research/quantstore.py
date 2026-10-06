"""Research prices from the XTXC quant store, verified before use.

The quant store (``/home/ubuntu/xtxc_ai_quant``, built outside this project and never modified here) holds
adjusted daily bars for 58 names collected with yfinance. Not every row in it is market data: when a download
fails, its collector fills the name with a seeded random walk (``generate_synthetic_token_series``) and stores it
next to real data without a flag. This module makes sure no such row reaches research:

1. Synthetic detection. Every symbol is re-generated with the collector's own seeds; a series that equals the
   generated one is quarantined (not used), whatever its name.
2. Verification. The remaining adjusted closes are compared with an independent reference (Yahoo chart v8,
   ``marketdata.refresh_ticker``) on overlapping dates, by daily return (scale-free) and by level on the last
   common date. Only names that agree are taken from the store.
3. Replacement. Quarantined names, names that failed verification and names the store does not have are taken
   from the reference only, from their real first trading day, and labelled so. A name with no real data stays
   empty -- it is never filled with generated prices.
4. The unadjusted session close (used to compare a token's price with the stock) comes from the reference; the
   store provides the adjusted history the backtests run on.

The result is an ordinary price release (content-addressed objects + ``prices/quant_release.json``) that
``marketdata.build_snapshot`` seals into snapshots when ``XTXC_PRICE_SOURCE=quant``.
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
from typing import Callable, Iterable

import numpy as np

from . import marketdata as md

SOURCE = "xtxc-quant-store/verified-v1"
RELEASE_FILE = "quant_release.json"
DEFAULT_STORE = Path("/home/ubuntu/xtxc_ai_quant")
DAILY_MASTER = "data/xtxc_58_master.csv"

# The collector's fallback generator (collect_man_group_58.py, generate_synthetic_token_series): same seeds.
SYNTHETIC_CONFIGS = {
    "SPCX": {"base_price": 50.0, "drift": 0.0007, "vol": 0.020, "seed": 42},
    "CRCL": {"base_price": 10.0, "drift": 0.0006, "vol": 0.018, "seed": 43},
    "STRC": {"base_price": 25.0, "drift": 0.0003, "vol": 0.014, "seed": 44},
    "DFDV": {"base_price": 5.0, "drift": 0.0002, "vol": 0.028, "seed": 45},
    "VIDA": {"base_price": 3.0, "drift": 0.0003, "vol": 0.024, "seed": 46},
    "AMBR": {"base_price": 15.0, "drift": 0.0004, "vol": 0.022, "seed": 47},
}
DEFAULT_SYNTHETIC = {"base_price": 20.0, "drift": 0.0003, "vol": 0.02, "seed": 99}

# Agreement needed to take a name from the store (store close = adjusted close; reference = Yahoo adjclose).
MAX_MEDIAN_RETURN_DIFF_BPS = 5.0
MAX_P99_RETURN_DIFF_BPS = 100.0
MAX_LAST_LEVEL_DIFF_BPS = 150.0     # dividends paid after the store was collected rescale adjusted history a little
MIN_OVERLAP_DAYS = 20


class QuantStoreError(RuntimeError):
    pass


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_daily_master(store_root: Path) -> dict[str, list[dict]]:
    """symbol -> rows sorted by date: {"date", "open", "high", "low", "close", "volume"} (strings -> numbers)."""
    path = store_root / DAILY_MASTER
    if not path.exists():
        raise QuantStoreError(f"quant store daily master not found: {path}")
    out: dict[str, list[dict]] = {}
    with path.open(newline="") as f:
        for r in csv.DictReader(f):
            def num(k):
                v = r.get(k)
                return float(v) if v not in (None, "", "nan", "NaN") else None
            out.setdefault(r["symbol"].strip().upper(), []).append({
                "date": r["date"][:10], "open": num("open"), "high": num("high"), "low": num("low"),
                "close": num("close"), "volume": num("volume")})
    for rows in out.values():
        rows.sort(key=lambda x: x["date"])
    return out


def regenerate_synthetic_close(cfg: dict, n: int) -> np.ndarray:
    """The collector's fallback close series for ``n`` dates (np.random.seed + normal == RandomState(seed).normal)."""
    rs = np.random.RandomState(cfg["seed"])
    returns = rs.normal(cfg["drift"], cfg["vol"], n)
    return np.round(cfg["base_price"] * np.cumprod(1 + returns), 4)


def is_synthetic(symbol: str, rows: list[dict]) -> bool:
    """True when the stored closes are exactly the collector's generated series (its own seed or the default)."""
    closes = np.array([r["close"] if r["close"] is not None else np.nan for r in rows], dtype="float64")
    if len(closes) == 0 or np.isnan(closes).any():
        return False
    for cfg in (SYNTHETIC_CONFIGS.get(symbol), DEFAULT_SYNTHETIC):
        if cfg and np.allclose(closes, regenerate_synthetic_close(cfg, len(closes)), rtol=0, atol=1e-4):
            return True
    return False


def invalid_ohlc_rows(rows: list[dict]) -> int:
    bad = 0
    for r in rows:
        o, h, lo, c = r["open"], r["high"], r["low"], r["close"]
        if None in (o, h, lo, c):
            continue
        if h < max(o, c) or lo > min(o, c) or lo <= 0:
            bad += 1
    return bad


def _returns(pairs: list[tuple[str, float]]) -> dict[str, float]:
    out = {}
    for (d0, a), (d1, b) in zip(pairs, pairs[1:]):
        if a and b and a > 0 and b > 0:
            out[d1] = math.log(b / a)
    return out


def compare(store_rows: list[dict], ref_rows: list[tuple]) -> dict:
    """Store adjusted close vs reference adjclose on common dates."""
    ref = {r[0]: r[2] for r in ref_rows if r[2] is not None}
    common = [(r["date"], r["close"], ref[r["date"]]) for r in store_rows if r["close"] is not None and r["date"] in ref]
    if len(common) < MIN_OVERLAP_DAYS:
        return {"ok": False, "overlap": len(common), "reason": "too little overlap with the reference"}
    rs = _returns([(d, s) for d, s, _ in common])
    rr = _returns([(d, x) for d, _, x in common])
    diffs = sorted(abs(rs[d] - rr[d]) * 10_000 for d in rs if d in rr)
    med = diffs[len(diffs) // 2] if diffs else float("inf")
    p99 = diffs[min(len(diffs) - 1, int(len(diffs) * 0.99))] if diffs else float("inf")
    d_last, s_last, x_last = common[-1]
    lvl = abs(s_last / x_last - 1) * 10_000
    med, p99, lvl = float(med), float(p99), float(lvl)
    ok = bool(med <= MAX_MEDIAN_RETURN_DIFF_BPS and p99 <= MAX_P99_RETURN_DIFF_BPS and lvl <= MAX_LAST_LEVEL_DIFF_BPS)
    return {"ok": ok, "overlap": len(common), "median_return_diff_bps": round(med, 2), "p99_return_diff_bps": round(p99, 2),
            "last_level_diff_bps": round(lvl, 1), "last_common_date": d_last,
            **({} if ok else {"reason": "store and reference disagree"})}


def _reference_rows(ticker: str, root: Path, start: str) -> list[tuple]:
    entry = md.refresh_ticker(ticker, start, root=root)
    return md._csv_to_rows(md._read_object(root, entry["object"]))


def build_release(tickers: Iterable[str], *, store_root: Path = DEFAULT_STORE, root: Path | None = None,
                  start: str = "2010-01-01",
                  reference: Callable[[str], list[tuple]] | None = None) -> dict:
    """Verify the quant store against the reference and write the price release used by research."""
    root = root or md.data_dir()
    reference = reference or (lambda t: _reference_rows(t, root, start))
    store = read_daily_master(store_root)
    master = store_root / DAILY_MASTER
    per: dict[str, dict] = {}
    for t in sorted({x.strip().upper() for x in tickers}):
        info: dict = {"ticker": t}
        srows = store.get(t)
        try:
            ref_rows = reference(t)
        except Exception as exc:  # the reference is only needed for verification/replacement; record why it failed
            ref_rows, info["reference_error"] = [], str(exc)[:200]
        ref_by_date = {r[0]: r for r in ref_rows}
        rows: list[tuple] = []
        if srows is None:
            info["provenance"] = "reference: not in the quant store"
            rows = [r for r in ref_rows if r[0] >= start]
        elif is_synthetic(t, srows):
            info["provenance"] = "reference: quant store rows are generated (quarantined, not used)"
            info["quarantined_rows"] = len(srows)
            rows = [r for r in ref_rows if r[0] >= start]
        else:
            info["invalid_ohlc_rows"] = invalid_ohlc_rows(srows)
            check = compare(srows, ref_rows)
            info["verification"] = check
            if check["ok"]:
                info["provenance"] = "quant store (adjusted history) + reference (unadjusted session close)"
                for r in srows:
                    if r["date"] < start or r["close"] is None:
                        continue
                    ref_r = ref_by_date.get(r["date"])
                    vol = int(r["volume"]) if r["volume"] is not None else (ref_r[3] if ref_r else None)
                    raw = ref_r[1] if ref_r else None
                    rows.append((r["date"], None if raw is None else float(raw), float(r["close"]), None if vol is None else int(vol)))
            else:
                info["provenance"] = "reference: quant store failed verification (not used)"
                rows = [r for r in ref_rows if r[0] >= start]
        if not rows:
            info["provenance"] = info.get("provenance", "") + " -- no real data, left empty"
        info.update(rows=len(rows), first=rows[0][0] if rows else None, last=rows[-1][0] if rows else None,
                    object=md._write_object(root, md._rows_to_csv(rows)) if rows else None)
        per[t] = info
    release = {
        "schema": "xtxc.research.quant-release/v1",
        "source": SOURCE,
        "store": {"root": str(store_root), "daily_master": DAILY_MASTER, "sha256": _file_sha256(master),
                  "rows": sum(len(v) for v in store.values()), "symbols": len(store)},
        "reference": md.SOURCE,
        "rules": {"max_median_return_diff_bps": MAX_MEDIAN_RETURN_DIFF_BPS, "max_p99_return_diff_bps": MAX_P99_RETURN_DIFF_BPS,
                  "max_last_level_diff_bps": MAX_LAST_LEVEL_DIFF_BPS, "min_overlap_days": MIN_OVERLAP_DAYS,
                  "synthetic": "exact match with the collector's seeded generator (own seed or default seed 99)"},
        "start": start,
        "tickers": per,
        "created_at": md._iso(md._utcnow()),
    }
    release["release_id"] = md._sha256(md._canonical_json({k: release[k] for k in ("schema", "store", "start")}
                                                           | {"content": {t: v["object"] for t, v in per.items()}}))
    md._atomic_write(md._prices_dir(root) / RELEASE_FILE, json.dumps(release, indent=1, sort_keys=True).encode())
    return release


def load_release(root: Path | None = None) -> dict:
    path = md._prices_dir(root or md.data_dir()) / RELEASE_FILE
    if not path.exists():
        raise md.MarketDataError(f"no verified quant price release at {path}; build it with scripts/build_quant_release.py")
    return json.loads(path.read_text())


def build_snapshot(tickers: list[str], start: str = "2010-01-01", *, as_of: str | None = None,
                   root: Path | None = None) -> "md.DataSnapshot":
    """Seal a snapshot from the verified release (no network)."""
    root = root or md.data_dir()
    rel = load_release(root)
    tickers = sorted({t.strip().upper() for t in tickers})
    if not tickers:
        raise ValueError("no tickers")
    all_rows = {t: md._csv_to_rows(md._read_object(root, rel["tickers"][t]["object"]))
                for t in tickers if rel["tickers"].get(t, {}).get("object")}
    if as_of is None:
        lasts = [r[-1][0] for r in all_rows.values() if r]
        if not lasts:
            raise md.MarketDataError("no verified price data for any requested ticker")
        as_of = max(lasts)
    sliced = {t: [r for r in all_rows.get(t, []) if start <= r[0] <= as_of] for t in tickers}
    content = {t: (md._write_object(root, md._rows_to_csv(sliced[t])) if t in all_rows else None) for t in tickers}
    rights = {**md.RIGHTS, "note": "Adjusted history from the XTXC quant store (collected with yfinance), verified against "
                                   "Yahoo chart v8; licence of the store not established -- demo research only."}
    manifest = {"schema": md.SNAPSHOT_SCHEMA, "source": SOURCE, "rights": rights, "fields": list(md.FIELDS),
                "start": start, "as_of": as_of, "tickers": tickers, "content": content, "release_id": rel["release_id"]}
    snapshot_id = md._sha256(md._canonical_json(manifest))
    coverage = md._coverage(sliced, as_of)
    for t in tickers:
        if t not in all_rows:
            coverage[t] = {"first": None, "last": None, "rows": 0, "missing": []}
    path = md._snapshots_dir(root) / f"{snapshot_id}.json"
    if not path.exists():
        record = {
            "snapshot_id": snapshot_id, "manifest": manifest, "coverage": coverage,
            "errors": {t: rel["tickers"].get(t, {}).get("provenance", "not in release") for t in tickers if t not in all_rows},
            "provenance": {t: {k: rel["tickers"][t].get(k) for k in ("provenance", "verification", "quarantined_rows",
                                                                     "invalid_ohlc_rows")} for t in tickers if t in rel["tickers"]},
            "yahoo_meta": {}, "events": {},
            "created_at": md._iso(md._utcnow()),
            "notes": ["Generated (synthetic) rows in the quant store are quarantined; names without real data stay empty.",
                      "The universe is today's tokenized list; delisted companies are absent (survivorship)."],
        }
        md._atomic_write(path, json.dumps(record, indent=1, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    return md.load_snapshot(snapshot_id, root=root)
