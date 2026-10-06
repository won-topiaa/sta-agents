"""Build the verified price release from the XTXC quant store (run as an operator, not by the service).

    XTXC_DATA_DIR=<service data dir> python scripts/build_quant_release.py [--store /home/ubuntu/xtxc_ai_quant]

Reads the store read-only, fetches the Yahoo reference for verification (cached in the data dir), and writes
prices/quant_release.json + price objects. Prints what was taken from where and why.
"""
import argparse
import csv
import json
from pathlib import Path

from xtxc_agent.research import quantstore, universe

ap = argparse.ArgumentParser()
ap.add_argument("--store", default=str(quantstore.DEFAULT_STORE))
ap.add_argument("--start", default="2010-01-01")
args = ap.parse_args()
# Research history is not a liquidity admission list. The execution catalog
# used to omit already-collected names (ASML) from every published release.
# Keep every collected ticker; route eligibility is checked at execution time.
with (Path(args.store) / quantstore.DAILY_MASTER).open(newline="") as f:
    collected = {r["symbol"].strip().upper() for r in csv.DictReader(f)}
tickers = sorted(collected | {i.ticker for i in universe.load_universe()} | {"QQQ", "SPY"})
rel = quantstore.build_release(tickers, store_root=Path(args.store), start=args.start)
print(json.dumps({k: rel[k] for k in ("release_id", "source", "store", "created_at")}, indent=1))
groups: dict[str, list[str]] = {}
for t, v in rel["tickers"].items():
    groups.setdefault(v["provenance"], []).append(f"{t}({v['rows']})")
for prov, names in groups.items():
    print(f"\n{prov}: {len(names)}\n  " + " ".join(names))
bad = {t: v["verification"] for t, v in rel["tickers"].items() if v.get("verification") and not v["verification"]["ok"]}
if bad:
    print("\nverification failures:", json.dumps(bad, indent=1))
