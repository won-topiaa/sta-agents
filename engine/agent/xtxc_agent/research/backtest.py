"""Daily long/cash backtest on a sealed price snapshot.

Timing (stated in every result's ``assumptions``)
--------------------------------------------------
* The signal is computed at the **close of rebalance day t** with ``target_weights(spec, prices, t)``
  (rows <= t only).  The first signal is taken on the first day of the period so the portfolio is
  invested from the next day; later signals on the last trading day of each week / month.
* Trades are **executed at the close of t+1** at that day's adjusted close.  A name with no price
  on t+1 is not traded that day (its current holding is kept).
* Every day the book is marked to market on adjusted close (dividends reinvested, splits adjusted).
  A missing price for a held name carries the previous price (no return that day).
* Costs: ``bps / 10_000 x |traded notional|`` per ticker, taken from cash at execution; target
  weights are applied to the post-cost equity, so cash never goes negative even with min_cash = 0.
  ``cost_model = {"default_bps": 5.0, "per_ticker_bps": {"NVDA": 38.0, ...}}``.  Buys and sells pay
  the same bps.  ``weights`` records the signal's target weights at each execution date;
  ``held_weights`` records the weights actually held after trading (they differ inside the band).
* No-trade band (``spec["params"]["band"]``, absolute weight, default 0.02).  At an execution, with
  ``w`` = current weight (before trading) and ``w*`` = target, a tradable name is traded to ``w*`` if
  (a) it enters or leaves the target set (held with ``w* = 0``, or not held with ``w* > 0``), or
  (b) ``|w* - w| > band``, or (c) ``w > max_weight + band``; otherwise it is left as is.  Cash floor:
  if the untouched names would leave the invested fraction above ``min(1, 1 - min_cash + band)``,
  the untouched overweight names are traded too (largest overweight first) until it fits.  So after
  every rebalance each held name is within ``band`` of its target (hence <= max_weight + band) and
  cash >= min_cash - band (never negative).  ``band = 0`` trades every name to target every time.
* Benchmark: buy-and-hold of ``spec["benchmark"]`` (default QQQ) on adjusted close from the close of
  the first day of the period, no costs.
* Period: default the last 5 calendar years ending at the snapshot's last date
  (``spec["period"] = {"years": 5}``), or explicit ``{"start", "end"}`` clipped to the data.
* Holdout: the last 252 trading days of the period (``holdout_start`` = first of them); metrics are
  recomputed on that window with the previous close as base.

Metrics (float64; tolerance ~1e-12 relative from float rounding)
----------------------------------------------------------------
total_return = E_end / E_start - 1;  cagr = (E_end / E_start) ** (252 / n_days) - 1;
max_drawdown = min(E / running_max(E) - 1)  (a negative number or 0);
volatility = std(daily returns, ddof=1) * sqrt(252);
sharpe = mean(daily) / std(daily) * sqrt(252) with a **risk-free rate of 0** (cash earns nothing);
turnover = sum over executions of sum_i |w_target_i - w_before_i| / 2, divided by years (n_days/252);
exposure = average end-of-day invested fraction (positions / equity);  trades = ticker-level fills.
"""
from __future__ import annotations

import math
from decimal import Decimal

import numpy as np
import pandas as pd

from .strategies import normalize_spec, rebalance_positions, spec_hash, target_weights

__all__ = ["run_backtest", "simulate", "compute_metrics", "normalize_cost_model", "report_curve",
           "TRADING_DAYS", "HOLDOUT_DAYS"]

TRADING_DAYS = 252
HOLDOUT_DAYS = 252
_TRADE_EPS = 1e-9  # |delta| below this fraction of equity is not a trade


def normalize_cost_model(cost_model: dict | None) -> dict:
    cm = dict(cost_model or {})
    default = float(cm.get("default_bps", 5.0))
    per = {str(k).strip().upper(): float(v) for k, v in (cm.get("per_ticker_bps") or {}).items()}
    for name, v in [("default_bps", default), *per.items()]:
        if not math.isfinite(v) or v < 0:
            raise ValueError(f"cost bps must be finite and >= 0 ({name}={v})")
    return {"default_bps": default, "per_ticker_bps": dict(sorted(per.items()))}


def compute_metrics(equity: np.ndarray, *, turnover: float = 0.0, exposure: float = 0.0,
                    trades: int = 0) -> dict:
    """Metrics of an equity curve whose first value is the base (e.g. 100)."""
    e = np.asarray(equity, dtype="float64")
    n = len(e) - 1
    out = {"total_return": None, "cagr": None, "max_drawdown": None, "volatility": None,
           "sharpe": None, "turnover": float(turnover), "exposure": float(exposure), "trades": int(trades)}
    if n < 1 or not np.all(np.isfinite(e)) or e[0] <= 0:
        return out
    r = e[1:] / e[:-1] - 1.0
    total = e[-1] / e[0] - 1.0
    out["total_return"] = float(total)
    out["cagr"] = float((e[-1] / e[0]) ** (TRADING_DAYS / n) - 1.0) if e[-1] > 0 else -1.0
    out["max_drawdown"] = float(np.min(e / np.maximum.accumulate(e) - 1.0))
    if n >= 2:
        sd = float(np.std(r, ddof=1))
        out["volatility"] = sd * math.sqrt(TRADING_DAYS)
        out["sharpe"] = float(np.mean(r) / sd * math.sqrt(TRADING_DAYS)) if sd > 0 else None
    return out


def _execute(mask: np.ndarray, target: np.ndarray, pos: np.ndarray, E: float, bps: np.ndarray):
    """Positions after trading the ``mask`` names to ``target`` x post-cost equity, and their fees.

    Fixed point e = E - fee(e) (converges since bps << 10_000), so cash stays >= 0.
    """
    e_net = E
    for _ in range(60):
        new_pos = np.where(mask, target * e_net, pos)
        fee = np.abs(new_pos - pos) * bps / 1e4
        nxt = E - float(fee.sum())
        if abs(nxt - e_net) <= 1e-14 * max(E, 1.0):
            e_net = nxt
            break
        e_net = nxt
    new_pos = np.where(mask, target * e_net, pos)
    fee = np.abs(new_pos - pos) * bps / 1e4
    return new_pos, fee


def _resolve_period(index: pd.DatetimeIndex, period: dict) -> tuple[int, int]:
    end_ts = pd.Timestamp(period["end"]) if period.get("end") else index[-1]
    i1 = int(index.searchsorted(end_ts, side="right")) - 1
    if i1 < 0:
        raise ValueError("period end is before the first price")
    if period.get("start"):
        start_ts = pd.Timestamp(period["start"])
    else:
        start_ts = index[i1] - pd.DateOffset(years=int(period.get("years", 5)))
    i0 = int(index.searchsorted(start_ts, side="left"))
    if i0 >= i1:
        raise ValueError("period has fewer than two trading days")
    return i0, i1


def simulate(spec: dict, prices: pd.DataFrame, cost_model: dict | None, *, snapshot_id: str | None = None,
             holdout_days: int = HOLDOUT_DAYS, held: list[str] | None = None) -> dict:
    """Run the backtest on an in-memory price frame (index=date, columns=ticker, adjusted close). ``held``: the
    account's current holdings, if known; the latest target then treats them as the backtest treats its own."""
    s = normalize_spec(spec)
    cm = normalize_cost_model(cost_model)
    prices = prices.sort_index()
    index = pd.DatetimeIndex(prices.index)
    i0, i1 = _resolve_period(index, s["period"])
    tickers = [t for t in s["universe"] if t in prices.columns]
    missing = [t for t in s["universe"] if t not in prices.columns]
    raw = prices[tickers].to_numpy(dtype="float64") if tickers else np.zeros((len(index), 0))
    mark = prices[tickers].ffill().to_numpy(dtype="float64") if tickers else raw
    bps = np.array([cm["per_ticker_bps"].get(t, cm["default_bps"]) for t in tickers], dtype="float64")
    col = {t: j for j, t in enumerate(tickers)}

    signal_days = {i0} | {p for p in rebalance_positions(index, s["rebalance"]) if i0 < p < i1}
    dates = [d.strftime("%Y-%m-%d") for d in index[i0:i1 + 1]]
    n_days = i1 - i0 + 1

    pos = np.zeros(len(tickers))  # position values
    cash = 100.0
    equity = np.empty(n_days)
    invested = np.empty(n_days)
    equity[0] = 100.0
    invested[0] = 0.0
    weights_log: list = []
    held_log: list = []
    exec_log: list[dict] = []  # per execution: date index, turnover, trades, cost
    band = float(Decimal(s["params"]["band"]))
    max_w = float(Decimal(s["max_weight"]))
    invest_limit = min(1.0, 1.0 - float(Decimal(s["min_cash"])) + band)
    band_skipped = 0
    pending: dict[str, float] | None = target_weights(s, prices, i0) if i0 in signal_days else None
    costs_paid = 0.0
    # Exit rules of a custom design: checked on each close, sold at the next close (like any signal).
    ex = (s["params"].get("design") or {}).get("exit") if s["template"] == "custom" else None
    entry = np.full(len(tickers), np.nan)       # close at which the current holding was bought
    peak = np.full(len(tickers), np.nan)        # highest close since then
    exit_due = np.zeros(len(tickers), dtype=bool)
    exits: list[list] = []

    for k in range(1, n_days):
        i = i0 + k
        prev, cur = mark[i - 1], mark[i]
        with np.errstate(divide="ignore", invalid="ignore"):
            growth = np.where((pos != 0) & np.isfinite(prev) & np.isfinite(cur) & (prev > 0), cur / prev, 1.0)
        pos = pos * growth
        E = cash + float(pos.sum())
        just_exited = np.zeros(len(tickers), dtype=bool)
        if exit_due.any():
            mask = exit_due & np.isfinite(raw[i]) & (pos > 0)
            if mask.any():
                new_pos, fee = _execute(mask, np.zeros(len(tickers)), pos, E, bps)
                delta, cost = new_pos - pos, float(fee.sum())
                cash -= float(delta.sum()) + cost
                pos, costs_paid = new_pos, costs_paid + cost
                exec_log.append({"k": k, "turnover": float(np.abs(delta).sum() / E / 2.0) if E > 0 else 0.0,
                                 "trades": int(mask.sum()), "cost": cost})
                exits.extend([dates[k], tickers[j]] for j in np.flatnonzero(mask))
                E = cash + float(pos.sum())
                entry[mask] = np.nan
                peak[mask] = np.nan
                just_exited = mask
            exit_due[:] = False
        if pending is not None:
            # a name sold by an exit rule today stays out of a rebalance that executes on the same day
            target = np.array([0.0 if just_exited[j] else pending.get(t, 0.0) for j, t in enumerate(tickers)], dtype="float64")
            tradable = np.isfinite(raw[i])
            if band > 0 and E > 0:
                w_cur = pos / E
                enter_leave = (target > 0) != (pos > 0)
                trade = tradable & (enter_leave | (np.abs(target - w_cur) > band) | (w_cur > max_w + band))
                new_pos, fee = _execute(trade, target, pos, E, bps)
                # cash floor within the band: trim untouched overweight names, largest first
                while float(new_pos.sum()) > invest_limit * (E - float(fee.sum())) * (1 + 1e-12):
                    over = tradable & ~trade & (w_cur > target)
                    if not over.any():
                        break
                    trade[int(np.argmax(np.where(over, w_cur - target, -np.inf)))] = True
                    new_pos, fee = _execute(trade, target, pos, E, bps)
                band_skipped += int(np.sum(tradable & ~trade & (pos > 0) & (np.abs(target * E - pos) > _TRADE_EPS * E)))
            else:
                new_pos, fee = _execute(tradable, target, pos, E, bps)
            delta = new_pos - pos
            n_tr = int(np.sum(np.abs(delta) > _TRADE_EPS * E))
            cost = float(fee.sum())
            cash -= float(delta.sum()) + cost
            pos = new_pos
            costs_paid += cost
            exec_log.append({"k": k, "turnover": float(np.abs(delta).sum() / E / 2.0) if E > 0 else 0.0,
                             "trades": n_tr, "cost": cost})
            weights_log.append([dates[k], {t: float(pending[t]) for t in sorted(pending) if t in col}])
            pending = None
            E = cash + float(pos.sum())
            held_log.append([dates[k], {t: float(pos[j] / E) for j, t in enumerate(tickers) if pos[j] > 0},
                             float(cash / E)])
        if ex:
            held_now = pos > 0
            fresh = held_now & ~np.isfinite(entry)
            entry = np.where(fresh, cur, np.where(held_now, entry, np.nan))
            peak = np.where(held_now, np.fmax(np.where(fresh, cur, peak), cur), np.nan)
            with np.errstate(invalid="ignore"):
                if ex.get("stop_loss") is not None:
                    exit_due |= held_now & (cur <= entry * (1 - ex["stop_loss"]))
                if ex.get("trailing_stop") is not None:
                    exit_due |= held_now & (cur <= peak * (1 - ex["trailing_stop"]))
        if i in signal_days:
            pending = target_weights(s, prices, i, held=frozenset(t for j, t in enumerate(tickers) if pos[j] > 0))
        equity[k] = E
        invested[k] = float(pos.sum()) / E if E > 0 else 0.0

    years = (n_days - 1) / TRADING_DAYS
    turnover = sum(x["turnover"] for x in exec_log) / years if years > 0 else 0.0
    trades = sum(x["trades"] for x in exec_log)
    metrics = compute_metrics(equity, turnover=turnover, exposure=float(invested.mean()), trades=trades)

    bench_t = s["benchmark"]
    bench_curve = None
    bench_metrics = None
    if bench_t in prices.columns:
        b = prices[bench_t].to_numpy(dtype="float64")[i0:i1 + 1]
        if np.isfinite(b[0]) and b[0] > 0:
            b = pd.Series(b).ffill().to_numpy()
            bench_curve = 100.0 * b / b[0]
            bench_metrics = compute_metrics(bench_curve, exposure=1.0)

    holdout = None
    if n_days - 1 >= holdout_days + 1:
        h0 = n_days - holdout_days  # first holdout day (position in the period)
        base = h0 - 1
        h_exec = [x for x in exec_log if x["k"] >= h0]
        h_years = holdout_days / TRADING_DAYS
        holdout = {
            "start": dates[h0],
            "strategy": compute_metrics(equity[base:], turnover=sum(x["turnover"] for x in h_exec) / h_years,
                                        exposure=float(invested[h0:].mean()),
                                        trades=sum(x["trades"] for x in h_exec)),
            "benchmark": compute_metrics(bench_curve[base:], exposure=1.0) if bench_curve is not None else None,
        }

    # The allocation recommended now. Without the account's holdings it is for new money (no hold buffer, every entry
    # filter applies); with them, a holding keeps its place exactly as one would in the backtest.
    latest = target_weights(s, prices, i1, held=frozenset(held) if held else None)
    return {
        "equity": [[d, round(float(v), 6)] for d, v in zip(dates, equity)],
        "benchmark": [[d, round(float(v), 6)] for d, v in zip(dates, bench_curve)] if bench_curve is not None else [],
        "weights": weights_log,
        "trades": trades,
        "turnover": turnover,
        "metrics": metrics,
        "holdout_start": holdout["start"] if holdout else None,
        # --- extensions (not in contract section 2, used by the evaluator / report) ---
        "holdout_metrics": holdout["strategy"] if holdout else None,
        "benchmark_ticker": bench_t,
        "benchmark_metrics": bench_metrics,
        "benchmark_holdout_metrics": holdout["benchmark"] if holdout else None,
        "period": {"start": dates[0], "end": dates[-1], "holdout_start": holdout["start"] if holdout else None,
                   "trading_days": n_days},
        "cost_model": cm,
        "costs_paid": costs_paid,  # in equity units (start = 100), i.e. percent of starting capital
        "held_weights": [[d, w] for d, w, _ in held_log],  # actual post-trade weights per execution
        "held_cash": [[d, c] for d, _, c in held_log],
        "band": s["params"]["band"],
        "band_skipped": band_skipped,  # (execution, name) pairs left untraded because inside the band
        "exits": exits,  # [date, ticker] sold by the design's exit rules between rebalances
        "spec_hash": spec_hash(s),
        "snapshot_id": snapshot_id,
        "universe_used": tickers,
        "universe_missing": missing,
        "latest_target": {"date": str(index[i1].date()), "weights": latest,
                          "cash": float(Decimal(1) - sum(Decimal(repr(w)) for w in latest.values()))},
        "assumptions": [
            "signal at close of rebalance day t using data up to t; trades at close of t+1",
            "first signal on the first day of the period; later signals on the last trading day of each "
            + ("ISO week" if s["rebalance"] == "weekly" else "month"),
            "daily mark-to-market on adjusted close (dividends reinvested); cash earns 0",
            "costs = bps x |traded notional|, same for buys and sells",
            (f"no-trade band {s['params']['band']}: a held name is traded only when it enters/leaves the "
             f"target set, drifts more than the band from target, or exceeds max_weight + band; cash is "
             f"kept >= min_cash - band" if band > 0 else "no band: every name is traded to target at each rebalance"),
            f"benchmark = {bench_t} buy-and-hold on adjusted close from the first day's close, no costs",
            "sharpe annualised with sqrt(252), risk-free rate 0",
            f"holdout = last {holdout_days} trading days of the period",
            "long/cash only: no shorting, no leverage",
            *([f"exit rules: a holding is sold at the next close once its close is "
               + " or ".join(x for x in (f"{ex['stop_loss']:.0%} below its entry close" if ex.get("stop_loss") else "",
                                         f"{ex['trailing_stop']:.0%} below its highest close since entry" if ex.get("trailing_stop") else "") if x)
               + "; it stays out until the next rebalance"] if ex else []),
        ],
    }


def run_backtest(spec: dict, snapshot_id: str, cost_model: dict) -> dict:
    """Backtest ``spec`` on snapshot ``snapshot_id`` (see module docstring for the rules)."""
    from .marketdata import load_prices

    return simulate(spec, load_prices(snapshot_id), cost_model, snapshot_id=snapshot_id)


def report_curve(result: dict, max_points: int = 260) -> dict:
    """Down-sample strategy/benchmark curves to <= max_points (first and last kept), start = 100."""
    eq = result["equity"]
    n = len(eq)
    if n <= max_points:
        idx = list(range(n))
    else:
        idx = sorted({round(i * (n - 1) / (max_points - 1)) for i in range(max_points)})
    bench = {d: v for d, v in result.get("benchmark") or []}
    return {
        "dates": [eq[i][0] for i in idx],
        "strategy": [eq[i][1] for i in idx],
        "benchmark": [bench.get(eq[i][0]) for i in idx] if bench else [],
    }
