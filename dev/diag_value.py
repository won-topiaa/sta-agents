"""Dev diagnostic: how many stocks survive each step of a stored value design at the latest session."""
import json, sys
import numpy as np
from evaluate import load_prices
from design_bridge import with_fundamentals
from xtxc_agent.research import strategy_lang as sl, agent_profile as ap
from xtxc_agent.research.strategies import normalize_spec, target_weights

root, runfile = sys.argv[1], sys.argv[2]
run = json.load(open(runfile)); tick = run["instruments"]
prices, snap = load_prices(root, sorted(set(tick + ["QQQ", "SPY"]))); prices, snap = with_fundamentals(prices, snap, root, tick)
i = len(prices) - 1
print("fundamental tickers:", len(snap.get("fundamentals", {}).get("tickers", [])), "of", len(tick))
for c in run["candidates"]:
    d = sl.normalize_design(c["design"])
    print("==", c["name"], "| top_n", d["top_n"], d["weighting"], "| filters", [(f["signal"], f["rule"], f["value"]) for f in d["filters"]])
    left = [t for t in tick if t in prices.columns]
    for f in d["filters"]:
        if f["signal"] in sl.FUNDAMENTAL_SIGNALS:
            vals = {t: prices[f"{t}::{f['signal']}"].iloc[i] if f"{t}::{f['signal']}" in prices.columns else np.nan for t in left}
            fin = {t: v for t, v in vals.items() if np.isfinite(v)}
            if f["rule"] == "above": keep = [t for t, v in fin.items() if v > f["value"]]
            elif f["rule"] == "below": keep = [t for t, v in fin.items() if v < f["value"]]
            else:
                k = max(1, int(len(fin) * f["value"] + 1e-9)); order = sorted(fin, key=lambda t: -fin[t] if f["rule"] == "top_fraction" else fin[t]); keep = order[:k]
            print(f"   {f['signal']:15s} {f['rule']:14s} {f['value']:>6}: {len(left)} -> {len(keep)}   (finite {len(fin)})")
            left = keep
        else:
            print(f"   {f['signal']} (price filter) skipped in this view")
    spec = {"template": "custom", "params": {"design": d}, "universe": tick, "max_weight": str(run["goal"]["maxWeightBps"] / 10000),
            "min_cash": str(run["goal"]["minCashBps"] / 10000), "rebalance": "monthly"}
    print("   weights now:", {k: round(v, 3) for k, v in target_weights(normalize_spec(spec), prices, i).items()})
