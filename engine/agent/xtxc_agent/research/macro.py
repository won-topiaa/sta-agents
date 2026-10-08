"""Official macro and industry statistics as point-in-time series (FRED / ALFRED).

A FRED observation is dated by the period it measures, not by when it was published: the August semiconductor
production index is released in mid-September and revised for months after. Backtests therefore use ALFRED vintages
(``realtime_start`` / ``realtime_end``): on decision day t a strategy sees only values published before t (the day
before, since some series are published after the US close), as they stood then.

    release.json   {"schema", "release_id", "fetched_at", "series": {id: {"object", "last_updated", "rows", ...}}}
    objects/<sha256>.json   [[observation_date, realtime_start, realtime_end, value], ...]  (missing values dropped)

Data from the FRED® API (Federal Reserve Bank of St. Louis); every series used here is public-domain US government
data, and a series whose notes say "Copyright" is refused. Products showing these signals carry the notice:
"This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis."
"""

from __future__ import annotations

import bisect
import datetime as dt
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

from . import marketdata as md

SCHEMA = "xtxc.macro-release/v1"
API = "https://api.stlouisfed.org/fred"
NOTICE = "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis."
# series -> (frequency, scope). A scope names the stocks a guard on that series applies to (see in_scope).
SERIES = {
    "IPG3344S": ("monthly", "semiconductors"),     # industrial production: semiconductors and electronic components
    "RSAFS": ("monthly", "consumer"),              # advance retail sales: retail and food services
    "DCOILWTICO": ("daily", "energy"),             # WTI crude oil spot price
    "DTWEXBGS": ("daily", "market"),               # nominal broad US dollar index
}
CHANGE_RANGE = {"monthly": (1, 12), "daily": (5, 252)}
# A release older than this is not used: a guard would otherwise act on a stale reading.
MAX_AGE_DAYS = 14
# Funds have no SIC code; these track one of the scoped industries. Inverse funds (SOXS) gain when the industry falls,
# so a guard must never scale them down.
FUNDS = {
    "semiconductors": {"SMH", "SOXX", "SOXQ", "PSI", "XSD", "SOXL", "USD"},
    "consumer": {"XLY", "XLP", "XRT", "VCR", "VDC", "RTH", "FDIS", "FSTA"},
    "energy": {"XLE", "XOP", "OIH", "VDE", "IYE", "FENY", "AMLP"},
}
SEMIS_EXTRA = {"QCOM", "ARM"}   # filed under other SIC codes (radio telephone, foreign filer) but semiconductor makers


def in_scope(scope: str, ticker: str, sic, sector) -> bool:
    if scope == "market":
        return True
    if ticker in FUNDS.get(scope, ()):
        return True
    if scope == "semiconductors":
        try:
            s = int(sic)
        except (TypeError, ValueError):
            s = None
        return ticker in SEMIS_EXTRA or (s is not None and (3670 <= s <= 3679 or s == 3559))
    if scope == "consumer":
        return sector in ("consumer_discretionary", "consumer_staples")
    if scope == "energy":
        return sector == "energy"
    return False


# ------------------------------------------------------------------ fetch (refresh only; research never calls out)
def _get(path: str, params: dict, api_key: str, tries: int = 3) -> dict:
    url = f"{API}/{path}?" + urllib.parse.urlencode({**params, "api_key": api_key, "file_type": "json"})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "xtxc-research/1"}), timeout=60) as r:
                return json.loads(r.read(20_000_000))
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def fetch_series(series_id: str, api_key: str, start: str = "2010-01-01") -> dict:
    """Every vintage of one series since ``start`` (ALFRED), refusing copyrighted series."""
    if series_id not in SERIES:
        raise ValueError(f"unknown series {series_id}")
    meta = (_get("series", {"series_id": series_id}, api_key).get("seriess") or [{}])[0]
    if "copyright" in str(meta.get("notes", "")).lower():
        raise ValueError(f"{series_id} is copyrighted; it is not used")
    rows, offset = [], 0
    while True:
        page = _get("series/observations", {"series_id": series_id, "realtime_start": "1776-07-04", "realtime_end": "9999-12-31",
                                            "observation_start": start, "limit": 100000, "offset": offset}, api_key)
        obs = page.get("observations") or []
        for o in obs:
            try:
                v = float(o["value"])
            except (TypeError, ValueError):
                continue                                   # "." = no value for that day
            rows.append([o["date"], o["realtime_start"], o["realtime_end"], v])
        offset += len(obs)
        if not obs or offset >= int(page.get("count", 0)):
            break
    if not rows:
        raise ValueError(f"{series_id} returned no observations")
    rows.sort()
    return {"rows": rows, "last_updated": meta.get("last_updated"), "observation_end": meta.get("observation_end"),
            "frequency": meta.get("frequency_short"), "title": meta.get("title")}


def _dir(root) -> Path:
    return Path(root) / "macro"


def refresh_release(root, api_key: str, now=None) -> dict:
    """Fetch every series, store each as a content-addressed object and replace the release in one step. A series that
    fails keeps its previous object (and its error is recorded); nothing is replaced if every series fails."""
    d = _dir(root)
    (d / "objects").mkdir(parents=True, exist_ok=True)
    old = load_release_meta(root) or {}
    at = (now or dt.datetime.now(dt.timezone.utc)).isoformat(timespec="seconds")
    series, errors = {}, {}
    for sid in SERIES:
        try:
            got = fetch_series(sid, api_key)
            body = md._canonical_json(got["rows"])
            sha = md._sha256(body)
            obj = d / "objects" / f"{sha}.json"
            if not obj.exists():
                md._atomic_write(obj, body)
            series[sid] = {"object": sha, "rows": len(got["rows"]), "last_updated": got["last_updated"], "fetched_at": at,
                           "observation_end": got["observation_end"], "frequency": got["frequency"], "title": got["title"]}
        except Exception as exc:  # keep going: one series must not block the others
            errors[sid] = f"{type(exc).__name__}: {exc}"[:200]
            if sid in old.get("series", {}):   # it keeps its own fetch time, so its age keeps counting
                prev = old["series"][sid]
                series[sid] = {**prev, "fetched_at": prev.get("fetched_at") or old.get("fetched_at"), "kept_from_previous_release": True}
    if not any(not v.get("kept_from_previous_release") for v in series.values()):
        raise RuntimeError(f"no macro series could be fetched: {errors}")
    rel = {"schema": SCHEMA, "fetched_at": at,
           "series": series, "errors": errors, "source": "FRED/ALFRED (Federal Reserve Bank of St. Louis)", "notice": NOTICE}
    rel["release_id"] = md._sha256(md._canonical_json({k: v["object"] for k, v in series.items()}))
    md._atomic_write(d / "release.json", json.dumps(rel, indent=1, sort_keys=True).encode())
    return rel


# ------------------------------------------------------------------ read (research)
def load_release_meta(root):
    p = _dir(root) / "release.json"
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


def load_rows(root, series_id: str):
    meta = load_release_meta(root)
    entry = (meta or {}).get("series", {}).get(series_id)
    if not entry:
        return None
    body = (_dir(root) / "objects" / f"{entry['object']}.json").read_bytes()
    if md._sha256(body) != entry["object"]:
        raise ValueError(f"macro object for {series_id} does not match its hash")
    return json.loads(body)


def release_age_days(root, now=None) -> float | None:
    meta = load_release_meta(root)
    if not meta:
        return None
    at = dt.datetime.fromisoformat(meta["fetched_at"])
    return ((now or dt.datetime.now(dt.timezone.utc)) - at).total_seconds() / 86400


def series_age_days(meta, series_id: str, now=None) -> float | None:
    """Days since this series was last fetched. A series kept from an earlier release without its own fetch time has an
    unknown age (None), so it is never mistaken for fresh."""
    entry = (meta or {}).get("series", {}).get(series_id)
    if not entry:
        return None
    at = entry.get("fetched_at") or (None if entry.get("kept_from_previous_release") else meta.get("fetched_at"))
    if not at:
        return None
    return ((now or dt.datetime.now(dt.timezone.utc)) - dt.datetime.fromisoformat(at)).total_seconds() / 86400


class Vintages:
    """The value of each observation as it stood on a given day."""

    def __init__(self, rows):
        by_date: dict[str, list] = {}
        for date, start, end, value in rows:
            by_date.setdefault(date, []).append((start, end, float(value)))
        self.dates = sorted(by_date)
        self.versions = [sorted(by_date[d]) for d in self.dates]
        first = [v[0][0] for v in self.versions]
        # Observations count as known in date order: the first n dates whose first releases all happened by day a.
        self.known_by, top = [], ""
        for f in first:
            top = max(top, f)
            self.known_by.append(top)

    def known(self, a: str) -> int:
        return bisect.bisect_right(self.known_by, a)

    def value(self, i: int, a: str):
        vs = self.versions[i]
        k = bisect.bisect_right([s for s, _, _ in vs], a) - 1
        if k < 0:
            return None
        start, end, v = vs[k]
        return v if end >= a else None

    def change(self, a: str, periods: int):
        """Fractional change between the newest observation known on day ``a`` and the one ``periods`` earlier, both
        as published by then; None when not enough was published."""
        n = self.known(a)
        if n <= periods:
            return None
        new, old = self.value(n - 1, a), self.value(n - 1 - periods, a)
        if new is None or old is None or old == 0:
            return None
        return new / old - 1.0


def change_column(rows, index: pd.DatetimeIndex, periods: int, lag_days: int = 1) -> np.ndarray:
    """Per trading day t: the series' change over ``periods`` observations as known at the end of day t - lag_days."""
    v = Vintages(rows)
    out = np.full(len(index), np.nan)
    for i, t in enumerate(pd.DatetimeIndex(index)):
        c = v.change((t - pd.Timedelta(days=lag_days)).strftime("%Y-%m-%d"), periods)
        if c is not None:
            out[i] = c
    return out


if __name__ == "__main__":  # pragma: no cover - operator entry point
    import argparse
    import os
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--fred-env", required=True, help="file with FRED_API_KEY=...")
    args = ap.parse_args()
    key = dict(line.split("=", 1) for line in Path(args.fred_env).read_text().splitlines() if "=" in line).get("FRED_API_KEY", "").strip()
    rel = refresh_release(args.root, key or os.environ.get("FRED_API_KEY", ""))
    print(json.dumps({k: (v["rows"], v.get("observation_end")) for k, v in rel["series"].items()}), rel["errors"])
