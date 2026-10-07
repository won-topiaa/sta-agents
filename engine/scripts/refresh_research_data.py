#!/usr/bin/env python3
"""Scheduled refresh of the research data: the verified price release and the SEC fundamentals release.

    refresh_research_data.py <data root> [--prices] [--fundamentals] [--store <quant store root>]

With neither flag, both parts run. Each part replaces its release in one step, so a research run never reads a
half-written release; a part that fails leaves the previous release in place, and research keeps using it until it
expires (prices: 7 days; a filing value: 400 days). Every run appends one line to <data root>/refresh.log.jsonl and
writes the latest outcome to <data root>/refresh-status.json. A second run while one is going exits at once.

Prices: every ticker of the current price release is refreshed (cached history plus the newest sessions).
Fundamentals: one SEC submissions request per company, companyfacts only for companies with a newer filing, and the
FRED exchange rates for non-USD reporters (fundamentals.refresh_release)."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from xtxc_agent.research import fundamentals, quantstore  # noqa: E402
from xtxc_agent.research import marketdata as md  # noqa: E402

DEFAULT_STORE = Path("/home/ubuntu/xtxc_ai_quant")


def refresh_prices(root: Path, store: Path) -> dict:
    current = json.loads((root / "prices" / "quant_release.json").read_text())
    before = {t for t, r in current["tickers"].items() if r.get("rows")}
    new = quantstore.build_release(sorted(current["tickers"]), store_root=store, root=root, start=current.get("start", "2010-01-01"))
    rows = new["tickers"]
    lost = sorted(before - {t for t, r in rows.items() if r.get("rows")})
    if lost:
        # A reference outage must not empty a ticker that had history: keep its previous row (objects are never
        # deleted) and publish again in one step.
        for t in lost:
            rows[t] = {**current["tickers"][t], "kept_from_previous_release": True}
        new["release_id"] = md._sha256(md._canonical_json({k: new[k] for k in ("schema", "store", "start")}
                                                          | {"content": {t: v["object"] for t, v in rows.items()}}))
        md._atomic_write(md._prices_dir(root) / quantstore.RELEASE_FILE, json.dumps(new, indent=1, sort_keys=True).encode())
    return {"release": new["release_id"], "tickers": len(rows), "lost": lost,
            "errors": {t: r["reference_error"][:120] for t, r in rows.items() if r.get("reference_error")},
            "through": max((r.get("last") or "" for r in rows.values()), default=None)}


def refresh_fundamentals(root: Path) -> dict:
    rel = fundamentals.refresh_release(root)
    return {"release": rel["release_id"], "tickers": len(rel["tickers"]), "updated": rel.get("updated", []), "errors": rel.get("errors", {}),
            "fx": {c: row["through"] for c, row in rel.get("fx", {}).items()}, "fx_error": rel.get("fx_error")}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=Path)
    ap.add_argument("--prices", action="store_true")
    ap.add_argument("--fundamentals", action="store_true")
    ap.add_argument("--store", type=Path, default=DEFAULT_STORE)
    args = ap.parse_args()
    parts = [p for p, on in (("prices", args.prices), ("fundamentals", args.fundamentals)) if on] or ["prices", "fundamentals"]
    root = args.root.resolve()
    lock = open(root / ".refresh.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another refresh is running", file=sys.stderr)
        return 0
    run = {"started": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "parts": {}}
    for part in parts:
        t0 = time.time()
        try:
            out = refresh_prices(root, args.store) if part == "prices" else refresh_fundamentals(root)
            run["parts"][part] = {"ok": True, **out}
        except Exception as exc:  # keep going: one part failing must not block the other
            run["parts"][part] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300],
                                  "trace": traceback.format_exc(limit=3)[-600:]}
        run["parts"][part]["seconds"] = round(time.time() - t0)
    run["finished"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    with open(root / "refresh.log.jsonl", "a") as log:
        log.write(json.dumps(run, sort_keys=True) + "\n")
    tmp = root / f".refresh-status.{os.getpid()}.tmp"
    tmp.write_text(json.dumps(run, indent=1, sort_keys=True))
    os.replace(tmp, root / "refresh-status.json")
    print(json.dumps({p: {k: v for k, v in r.items() if k != "trace"} for p, r in run["parts"].items()}, sort_keys=True)[:2000])
    return 0 if all(r["ok"] for r in run["parts"].values()) else 1


if __name__ == "__main__":
    sys.exit(main())
