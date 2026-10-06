"""daily_refresh.py -- refresh the XTXC quant store every day after the US close (run by xtxc-quant-refresh.timer).

1. Collect with the store's own collectors (collect_man_group_58, collect_multi_frequency), daily bars up to the last
   session that has CLOSED (never an unfinished day). The collectors never generate prices (2026-09-29 fix).
2. Guard: a symbol whose new version has fewer rows (below 98%) or ends earlier than before is rolled back to its previous
   version -- a flaky download never shortens history.
3. Rebuild the three master tables (parquet, csv, ArcticDB master symbol) from every symbol's latest version, so a symbol
   that failed today is not dropped from the masters.
4. Keep the last KEEP_VERSIONS versions per symbol (the store stops growing without bound).
5. Record the run in data/provenance_manifest.json ("refreshes").
The agent then rebuilds its verified release from the store (deploy/quant-refresh.sh).
"""
import datetime as dt
import json
import os
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import arcticdb as adb  # noqa: E402
import pandas as pd  # noqa: E402

NY = ZoneInfo("America/New_York")
KEEP_VERSIONS = 5
MASTERS = {  # library -> (master symbol, master file base, time column, csv too)
    "xtxc_58_universe": ("XTXC_58_UNIVERSE_MASTER", ROOT / "data" / "xtxc_58_master", "date", True),
    "xtxc_intraday_5m": ("TIER1_TIER2_5M_MASTER", ROOT / "data" / "xtxc_tier1_tier2_5m_master", "datetime", False),
    "xtxc_hourly_1h": ("TIER3_1H_MASTER", ROOT / "data" / "xtxc_tier3_1h_master", "datetime", False),
}


def last_closed_session(now: dt.datetime) -> dt.date:
    """The latest weekday whose regular session has ended (16:15 New York); exchange holidays simply have no bar."""
    t = now.astimezone(NY)
    d = t.date() if t.time() >= dt.time(16, 15) else t.date() - dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d


def state(arctic) -> dict:
    out = {}
    for lib_name, (master, _, tcol, _) in MASTERS.items():
        lib = arctic[lib_name]
        for sym in lib.list_symbols():
            if sym == master:
                continue
            item = lib.read(sym)
            out[(lib_name, sym)] = {"version": item.version, "rows": len(item.data), "last": str(pd.to_datetime(item.data[tcol]).max())}
    return out


def main():
    now = dt.datetime.now(dt.timezone.utc)
    session = last_closed_session(now)
    os.environ["XTXC_QUANT_END"] = (session + dt.timedelta(days=1)).isoformat()      # end is exclusive in yfinance
    arctic = adb.Arctic(f"lmdb://{(ROOT / 'arctic_store').as_posix()}")
    before = state(arctic)

    import collect_man_group_58
    import collect_multi_frequency
    errors = []
    for mod in (collect_man_group_58, collect_multi_frequency):
        try:
            mod.main()
        except Exception as exc:  # the guard and the masters below still run on whatever was written
            errors.append(f"{mod.__name__}: {type(exc).__name__}: {str(exc)[:200]}")

    after = state(arctic)
    rollbacks, updated = [], 0
    for key, b in before.items():
        a = after.get(key)
        if a is None or a["version"] == b["version"]:
            continue
        if a["rows"] < 0.98 * b["rows"] or a["last"] < b["last"]:
            lib = arctic[key[0]]
            lib.write(key[1], lib.read(key[1], as_of=b["version"]).data, prune_previous_versions=False)
            rollbacks.append({"library": key[0], "symbol": key[1], "rows_before": b["rows"], "rows_new": a["rows"],
                              "last_before": b["last"], "last_new": a["last"]})
        else:
            updated += 1

    masters = {}
    for lib_name, (master, base, tcol, csv) in MASTERS.items():
        lib = arctic[lib_name]
        frames = []
        for sym in sorted(s for s in lib.list_symbols() if s != master):
            df = lib.read(sym).data
            if "source" not in df.columns:
                df = df.assign(source="yfinance")
            frames.append(df)
        m = pd.concat(frames, ignore_index=True)
        lib.write(master, m, prune_previous_versions=False)
        m.to_parquet(base.with_suffix(".parquet"), index=False)
        if csv:
            m.to_csv(base.with_suffix(".csv"), index=False)
        masters[lib_name] = {"rows": int(len(m)), "symbols": int(m["symbol"].nunique()), "last": str(pd.to_datetime(m[tcol]).max())}
        for sym in lib.list_symbols():                                      # bounded history of versions
            versions = sorted(v.version for v in lib.list_versions(sym))
            old = versions[:-KEEP_VERSIONS]
            if old:
                lib.delete(sym, versions=old)

    path = ROOT / "data" / "provenance_manifest.json"
    manifest = json.loads(path.read_text()) if path.exists() else {}
    runs = manifest.setdefault("refreshes", [])
    runs.append({"at": now.isoformat(timespec="seconds"), "through_session": session.isoformat(), "updated_symbols": updated,
                 "rollbacks": rollbacks, "errors": errors, "masters": masters, "keep_versions": KEEP_VERSIONS})
    manifest["refreshes"] = runs[-60:]
    path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    print(json.dumps(runs[-1], indent=1, ensure_ascii=False))
    if errors or rollbacks:
        sys.exit(2)


if __name__ == "__main__":
    main()
