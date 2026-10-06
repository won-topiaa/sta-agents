"""End-to-end research run: snapshot -> two backtests (underlying / XTXC cost) -> evaluator.

``research_bundle`` returns the research-engine part of a ResearchReport (contract section 3);
the core service adds run/brief ids, progress, summaries and the KRW drawdown.

    python -m xtxc_agent.research.example        # writes agent/data/example-research.json
"""
from __future__ import annotations

import datetime as dt
import json

from .backtest import report_curve, run_backtest
from .evaluator import evaluate
from .execution_costs import token_cost_model, xtxc_cost_model
from .marketdata import build_snapshot, data_dir, load_snapshot
from .strategies import normalize_spec, spec_hash
from .universe import load_universe, universe_version

UNDERLYING_COST = {"default_bps": 5.0, "per_ticker_bps": {}}

EXAMPLE_SPEC = {
    "template": "momentum",
    "params": {},
    "universe": ["NVDA", "AMD", "AVGO", "TSM", "MU", "MRVL", "INTC"],
    "max_weight": "0.25",
    "min_cash": "0.20",
    "rebalance": "weekly",
    "exclude_leveraged": True,
}
# contract section 3 Brief example: 2,158,273,381 USDC atoms budget x 0.25 max weight per order
EXAMPLE_ORDER_USDC_ATOMS = 539_568_345


def _metrics_block(r: dict) -> dict:
    return {"metrics": r["metrics"], "holdout_metrics": r["holdout_metrics"], "costs_paid_pct_of_start": r["costs_paid"],
            "cost_model": r["cost_model"]}


def research_bundle(spec: dict, snapshot_id: str, *, order_usdc: int, quotes: dict | None = None,
                    attempts: int = 1) -> dict:
    s = normalize_spec(spec)
    snap = load_snapshot(snapshot_id)
    underlying = run_backtest(s, snapshot_id, UNDERLYING_COST)
    token_costs = token_cost_model(s["universe"], order_usdc, quotes or {}, snapshot_id=snapshot_id)
    xtxc = run_backtest(s, snapshot_id, xtxc_cost_model(token_costs))
    ev = evaluate(s, snap, underlying, xtxc, attempts)
    lt = xtxc["latest_target"]
    return {
        "spec_hash": spec_hash(s),
        "spec": s,
        "snapshot_id": snapshot_id,
        "universe_version": universe_version(),
        "period": xtxc["period"],
        "underlying": _metrics_block(underlying),
        "xtxc": _metrics_block(xtxc),
        "benchmark": {"ticker": xtxc["benchmark_ticker"], "metrics": xtxc["benchmark_metrics"],
                      "holdout_metrics": xtxc["benchmark_holdout_metrics"]},
        "holdout": {"strategy": (xtxc["holdout_metrics"] or {}).get("total_return"),
                    "strategy_underlying": (underlying["holdout_metrics"] or {}).get("total_return"),
                    "benchmark": (xtxc["benchmark_holdout_metrics"] or {}).get("total_return")},
        "curve": report_curve(xtxc),
        "token_costs": token_costs,
        "checks": ev["checks"],
        "verdict": ev["verdict"],
        "evidence": ev["evidence"],
        "target": {"weights": lt["weights"], "cash": lt["cash"], "as_of": lt["date"]},
        "assumptions": xtxc["assumptions"],
    }


def main() -> None:  # pragma: no cover - CLI
    tickers = [i.ticker for i in load_universe()]
    snap = build_snapshot(tickers)  # cache first: no request when the cache is fresh
    bundle = research_bundle(EXAMPLE_SPEC, snap.snapshot_id, order_usdc=EXAMPLE_ORDER_USDC_ATOMS,
                             quotes={}, attempts=1)
    short = {t: {"first": c["first"], "rows": c["rows"]} for t, c in snap.coverage.items()
             if c["first"] is None or c["first"] > "2010-01-04"}
    out = {
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "input_spec": EXAMPLE_SPEC,
        "order_usdc_atoms": EXAMPLE_ORDER_USDC_ATOMS,
        "quotes": "none supplied -> every ticker uses the conservative 100 bps default",
        "snapshot": {"snapshot_id": snap.snapshot_id, "as_of": snap.as_of, "source": snap.source,
                     "rights": snap.rights, "tickers": len(snap.tickers),
                     "coverage_starting_after_2010_01_04": short,
                     "tickers_with_missing_dates": {t: c["missing"] for t, c in snap.coverage.items() if c["missing"]}},
        **bundle,
    }
    path = data_dir() / "example-research.json"
    path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps({k: out[k] for k in ("snapshot", "period", "underlying", "xtxc", "benchmark", "holdout",
                                          "checks", "verdict", "target")}, indent=1, ensure_ascii=False))
    print(f"written {path}")


if __name__ == "__main__":  # pragma: no cover
    main()
