#!/usr/bin/env python3
"""Live check of a design's exit rules, with the same definition the backtest uses (research/backtest.py).

    exit_check.py <data root>   < {"positions": [{"ticker": "AMD", "since": "2026-10-08", "stop_loss": 0.1,
                                                   "trailing_stop": null}, ...]}

For each position: entry = the first adjusted close on or after ``since`` (the session the buy was confirmed),
peak = the highest close from entry to the last session of the verified price release, and ``triggered`` names the
rule whose threshold the last close has reached ("stop_loss" before "trailing_stop"), or null. Like the backtest, a
triggered holding is sold at the next close, and it may come back at the next rebalance. Nothing is traded here.
"""

from __future__ import annotations

import json
import math
import sys

from evaluate import load_prices

MAX_POSITIONS = 64


def check(root, positions: list[dict]) -> dict:
    if not isinstance(positions, list) or len(positions) > MAX_POSITIONS:
        raise ValueError(f"positions must be a list of at most {MAX_POSITIONS}")
    tickers = sorted({p["ticker"] for p in positions})
    prices, snapshot = load_prices(root, tickers, column="adjclose", common=False) if tickers else (None, {"asOf": None})
    out = []
    for p in positions:
        sl, ts = p.get("stop_loss"), p.get("trailing_stop")
        for v in (sl, ts):
            if v is not None and not (isinstance(v, (int, float)) and 0.02 <= v <= 0.5):
                raise ValueError("stop_loss / trailing_stop must be null or 0.02..0.5")
        col = prices[p["ticker"]].dropna()
        after = col[col.index >= str(p["since"])]
        row = {"ticker": p["ticker"], "entryClose": None, "peakClose": None, "lastClose": None, "lastDate": None, "triggered": None}
        if len(after):
            entry, peak, last = float(after.iloc[0]), float(after.max()), float(after.iloc[-1])
            row.update(entryClose=entry, peakClose=peak, lastClose=last, lastDate=str(after.index[-1].date()))
            if sl is not None and last <= entry * (1 - sl):
                row["triggered"] = "stop_loss"
            elif ts is not None and last <= peak * (1 - ts):
                row["triggered"] = "trailing_stop"
        out.append({k: (round(v, 6) if isinstance(v, float) and math.isfinite(v) else v) for k, v in row.items()})
    return {"asOf": snapshot.get("asOf"), "positions": out}


if __name__ == "__main__":  # pragma: no cover - called by the research worker
    body = json.loads(sys.stdin.read(200_000) or "{}")
    try:
        print(json.dumps(check(sys.argv[1], body.get("positions", []))))
    except (ValueError, KeyError) as exc:
        print(json.dumps({"error": str(exc)[:200]}))
        sys.exit(2)
