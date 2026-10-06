"""Independent, deterministic checks on a research result (idea-stage traffic lights).

Check ids (contract section 3): ``leakage, costs, holdout, survivorship, attempts``.
Each check is ``{"id", "label_ko", "status": pass|warn|fail, "detail_ko"}``; ``verdict`` is fail if
any check fails, else warn if any warns, else pass.  Korean text is written for ordinary investors.
Numbers inside ``detail_ko`` are formatted from computed results only.

* leakage - automated perturbation test.  For several as-of days inside the backtest period, every
  price AFTER the as-of day is overwritten (random-walk noise, and separately all-missing) and the
  target weights at the as-of day must be identical.  In addition the whole backtest is re-run on
  the noise-perturbed prices for a few days and the equity curve up to that day must be identical.
  Any difference -> fail.
* costs - fail if either result was produced with zero cost (all bps 0, or trades but nothing paid).
* holdout - warn if the strategy (both the underlying and the XTXC-cost run are compared) did worse
  than the benchmark over the last 252 trading days.
* survivorship - always warn: the universe is today's tokenized list; delisted names are absent.
* attempts - warn above 10 attempts for the same brief.

The return value also carries ``evidence`` (machine-readable numbers behind each check); this key
is an extension of the contract shape.
"""
from __future__ import annotations

import hashlib

import numpy as np
import pandas as pd

from .backtest import simulate
from ..core import i18n
from ..core.i18n import tr
from .strategies import normalize_spec, rebalance_positions, spec_hash, target_weights

__all__ = ["evaluate", "leakage_test", "MAX_ATTEMPTS_OK", "LABELS_KO"]

MAX_ATTEMPTS_OK = 10
LABELS_KO = i18n.Names("eval.label")   # check names in the current display language


def _check(cid: str, status: str, detail_ko: str) -> dict:
    return {"id": cid, "label_ko": LABELS_KO[cid], "status": status, "detail_ko": detail_ko}


def _pct(x: float | None) -> str:
    if x is None:
        return tr("eval.unknown")
    return f"{x * 100:+.1f}%"


def _seed(*parts: str) -> int:
    return int.from_bytes(hashlib.sha256("|".join(parts).encode()).digest()[:8], "big")


def _noise_future(prices: pd.DataFrame, i: int, rng: np.random.Generator) -> pd.DataFrame:
    """Copy of ``prices`` with every row after position i replaced by a random positive walk."""
    out = prices.copy()
    n_future = len(prices) - i - 1
    if n_future <= 0:
        return out
    base = prices.iloc[i].to_numpy(dtype="float64")
    base = np.where(np.isfinite(base) & (base > 0), base, rng.uniform(5, 500, size=base.shape))
    steps = rng.normal(0.0, 0.08, size=(n_future, prices.shape[1]))
    walk = base * np.exp(np.cumsum(steps, axis=0))
    out.iloc[i + 1:] = walk
    return out


def _nan_future(prices: pd.DataFrame, i: int) -> pd.DataFrame:
    out = prices.copy()
    out.iloc[i + 1:] = np.nan
    return out


def _same_weights(a: dict, b: dict) -> bool:
    return set(a) == set(b) and all(abs(a[t] - b[t]) <= 1e-12 for t in a)


def leakage_test(spec: dict, prices: pd.DataFrame, *, n_dates: int = 6, n_backtest_dates: int = 2,
                 period: dict | None = None, seed: int | None = None) -> dict:
    """Perturb the future and confirm past decisions do not move.  Returns evidence dict."""
    s = normalize_spec(spec)
    index = pd.DatetimeIndex(prices.index)
    if period and period.get("start") and period.get("end"):
        lo = int(index.searchsorted(pd.Timestamp(period["start"])))
        hi = int(index.searchsorted(pd.Timestamp(period["end"]), side="right")) - 1
    else:
        hi = len(index) - 1
        lo = max(0, int(index.searchsorted(index[hi] - pd.DateOffset(years=5))))
    candidates = [p for p in rebalance_positions(index, s["rebalance"]) if lo <= p < hi]
    if not candidates:
        candidates = list(range(lo, hi))
    picks = sorted({candidates[round(j * (len(candidates) - 1) / max(n_dates - 1, 1))] for j in range(n_dates)})
    rng = np.random.default_rng(seed if seed is not None else _seed(spec_hash(s), str(index[-1])))
    tested, failures = [], []
    for i in picks:
        base = target_weights(s, prices, i)
        for kind, perturbed in (("noise", _noise_future(prices, i, rng)), ("missing", _nan_future(prices, i))):
            w = target_weights(s, perturbed, i)
            ok = _same_weights(base, w)
            tested.append({"date": str(index[i].date()), "perturbation": kind, "same": ok, "weights": base})
            if not ok:
                failures.append({"date": str(index[i].date()), "perturbation": kind, "before": base, "after": w})
    # whole-backtest check: equity up to the as-of day must not depend on later prices
    bt_dates = []
    if n_backtest_dates > 0 and len(picks) >= 2:
        ref = simulate(s, prices, {"default_bps": 5.0})
        for i in [picks[len(picks) // 3], picks[(2 * len(picks)) // 3]][:n_backtest_dates]:
            d = str(index[i].date())
            pert = simulate(s, _noise_future(prices, i, rng), {"default_bps": 5.0})
            a = [v for dd, v in ref["equity"] if dd <= d]
            b = [v for dd, v in pert["equity"] if dd <= d]
            ok = a == b
            bt_dates.append({"date": d, "same_equity_through_date": ok, "points": len(a)})
            if not ok:
                failures.append({"date": d, "perturbation": "backtest-noise", "detail": "equity changed"})
    return {"dates_tested": tested, "backtest_dates_tested": bt_dates, "failures": failures,
            "passed": not failures}


def _zero_cost(result: dict) -> bool:
    cm = result.get("cost_model") or {}
    bps = [float(cm.get("default_bps", 0.0))] + [float(v) for v in (cm.get("per_ticker_bps") or {}).values()]
    traded = set()
    for _, w in result.get("weights") or []:
        traded.update(w)
    per = cm.get("per_ticker_bps") or {}
    traded_bps = [float(per.get(t, cm.get("default_bps", 0.0))) for t in traded]
    if max(bps, default=0.0) <= 0.0:
        return True
    if traded_bps and min(traded_bps) <= 0.0:
        return True
    if int(result.get("trades") or 0) > 0 and float(result.get("costs_paid") or 0.0) <= 0.0:
        return True
    return False


def evaluate(spec, snapshot, result_underlying, result_xtxc, attempts: int, *, leakage: dict | None = None) -> dict:
    """Run the five idea checks.  ``snapshot`` may be a DataSnapshot or a snapshot id.  ``leakage``: the evidence of a
    leakage test already run elsewhere (the isolated runner, for AI-designed strategies)."""
    from .marketdata import load_prices, load_snapshot
    from .universe import get_instrument

    s = normalize_spec(spec)
    snap = load_snapshot(snapshot) if isinstance(snapshot, str) else snapshot
    prices = load_prices(snap.snapshot_id)
    checks, evidence = [], {}

    # 1. leakage
    lk = leakage if leakage is not None else leakage_test(s, prices, period=result_underlying.get("period"))
    evidence["leakage"] = {k: lk[k] for k in ("backtest_dates_tested", "failures", "passed")} | {
        "dates": sorted({x["date"] for x in lk["dates_tested"]}),
        "cases": len(lk["dates_tested"]),
    }
    n_dates = len(evidence["leakage"]["dates"])
    if lk["passed"]:
        checks.append(_check("leakage", "pass", tr("eval.leakage.pass", n=n_dates)))
    else:
        checks.append(_check("leakage", "fail", tr("eval.leakage.fail")))

    # 2. costs
    zu, zx = _zero_cost(result_underlying), _zero_cost(result_xtxc)
    cu = float(result_underlying.get("costs_paid") or 0.0)
    cx = float(result_xtxc.get("costs_paid") or 0.0)
    ru = (result_underlying.get("metrics") or {}).get("total_return")
    rx = (result_xtxc.get("metrics") or {}).get("total_return")
    evidence["costs"] = {"underlying_zero_cost": zu, "xtxc_zero_cost": zx,
                         "underlying_costs_pct_of_start": cu, "xtxc_costs_pct_of_start": cx,
                         "underlying_default_bps": result_underlying.get("cost_model", {}).get("default_bps"),
                         "xtxc_default_bps": result_xtxc.get("cost_model", {}).get("default_bps")}
    if zu or zx:
        checks.append(_check("costs", "fail", tr("eval.costs.fail")))
    else:
        checks.append(_check("costs", "pass", tr("eval.costs.pass", ru=_pct(ru), rx=_pct(rx), cu=f"{cu:.1f}", cx=f"{cx:.1f}")))

    # 3. holdout
    bench_t = s["benchmark"]
    inst = get_instrument(bench_t)
    bench_name = i18n.stock_name(inst, bench_t)
    hu = (result_underlying.get("holdout_metrics") or {}).get("total_return")
    hx = (result_xtxc.get("holdout_metrics") or {}).get("total_return")
    hb = (result_xtxc.get("benchmark_holdout_metrics") or result_underlying.get("benchmark_holdout_metrics")
          or {}).get("total_return")
    evidence["holdout"] = {"holdout_start": result_xtxc.get("holdout_start"), "strategy_underlying": hu,
                           "strategy_xtxc": hx, "benchmark": hb, "benchmark_ticker": bench_t}
    if hu is None or hx is None or hb is None:
        checks.append(_check("holdout", "warn", tr("eval.holdout.none")))
    elif min(hu, hx) < hb:
        checks.append(_check("holdout", "warn", tr("eval.holdout.warn", hx=_pct(hx), hb=_pct(hb), bench=bench_name)))
    else:
        checks.append(_check("holdout", "pass", tr("eval.holdout.pass", hx=_pct(hx), hb=_pct(hb), bench=bench_name)))

    # 4. survivorship (always a warning)
    period_start = (result_underlying.get("period") or {}).get("start")
    late = sorted(t for t in s["universe"]
                  if t in snap.coverage and snap.coverage[t].get("first")
                  and period_start and snap.coverage[t]["first"] > period_start)
    evidence["survivorship"] = {"universe_source": "today's XTXC tokenized list", "late_listed": late,
                                "period_start": period_start}
    detail = tr("eval.surv")
    if late:
        names = i18n.join(i18n.stock_name(get_instrument(t), t) for t in late)
        detail += tr("eval.surv.late", names=i18n.topic(names))
    checks.append(_check("survivorship", "warn", detail))

    # 5. attempts
    n = int(attempts)
    evidence["attempts"] = {"attempts": n, "warn_above": MAX_ATTEMPTS_OK}
    if n > MAX_ATTEMPTS_OK:
        checks.append(_check("attempts", "warn", tr("eval.attempts.warn", n=n)))
    else:
        checks.append(_check("attempts", "pass", tr("eval.attempts.first") if n <= 1 else tr("eval.attempts.nth", n=n)))

    statuses = {c["status"] for c in checks}
    verdict = "fail" if "fail" in statuses else ("warn" if "warn" in statuses else "pass")
    return {"checks": checks, "verdict": verdict, "evidence": evidence,
            "spec_hash": spec_hash(s), "snapshot_id": snap.snapshot_id}
