"""Strategy templates.  Long/cash only: no shorting, no leverage, weights never exceed the caps.

Spec (a plain JSON dict; ``normalize_spec`` fills defaults, ``spec_hash`` hashes the normalized form)
----------------------------------------------------------------------------------------------
::

    {
      "template": "momentum" | "low_vol" | "equal_weight" | "custom",
      "params": {...},                  # template parameters, defaults below
      "universe": ["NVDA", "AMD", ...], # tickers; order does not matter (normalized: upper-case, sorted, unique)
      "max_weight": "0.25",             # per-name cap, decimal string (or number), 0 < x <= 1
      "min_cash": "0.20",               # cash always kept, 0 <= x < 1  ->  invested total <= 1 - min_cash
      "rebalance": "weekly" | "monthly",
      "exclude_leveraged": true,        # drop kind == "leveraged_etf" (from the universe mapping)
      "benchmark": "QQQ",               # optional, default "QQQ" (buy-and-hold comparison in the backtest)
      "period": {"years": 5}            # optional; or {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}
    }

Decimal fields are canonicalized as strings ("0.20" -> "0.2") so equivalent specs hash the same.

Template parameters
-------------------
momentum  ``{"lookback": 63, "skip": 0, "top_n": null, "weighting": "equal", "positive_only": false}``
    Score = trailing total return over ``lookback`` trading days ending ``skip`` days before the as-of
    day (adjusted close).  Pick the ``top_n`` highest scores (ties -> ticker order).  ``top_n=null``
    means N = ceil((1 - min_cash) / max_weight): the fewest names whose capped weights can fill the
    invested budget.  Choice documented here: **equal weight** within the pick by default (robust,
    easy to explain); ``"weighting": "proportional"`` weights by score instead (names with score <= 0
    get nothing, their share stays cash).  ``positive_only`` keeps only names with score > 0 (the rest
    stays cash).
low_vol   ``{"lookback": 63, "top_n": null}``
    Weight proportional to 1 / (std of the last ``lookback`` daily returns); every eligible name,
    or the ``top_n`` least volatile ones.
equal_weight ``{"min_history": 1}``
    Every eligible name gets the same weight.
custom    ``{"design": {...}}``
    An AI-designed strategy written in the building blocks of ``strategy_lang`` (never code); validated and
    canonicalised there, evaluated with the same caps, cash floor and no-look-ahead slicing as the templates.
all templates ``{"band": "0.02"}``
    Rebalance no-trade band (absolute weight, decimal string or number, 0 <= band < 1).  It does not
    change ``target_weights``; the backtest uses it to decide which names to trade at a rebalance
    (see ``backtest``).  ``"0"`` trades every name back to target at every rebalance.

Budget and caps
---------------
Raw scores are scaled to ``1 - min_cash`` and capped by iterative redistribution (water-filling):
a name above ``max_weight`` is fixed at the cap and the excess is re-spread over the uncapped names
in proportion to their scores; when every name is capped the remainder stays cash.  Weights are then
rounded *down* to 1e-12, and if the float sum still exceeds the budget by an ulp the largest weight is
lowered by ulps, so ``each <= max_weight`` and ``sum <= 1 - min_cash`` hold in float arithmetic.

Eligibility / no look-ahead
---------------------------
``target_weights(spec, prices, asof_index)`` slices ``prices.iloc[:asof_index + 1]`` first and uses
nothing else.  A ticker is eligible on a day only if it has a price on that day and the full window
its template needs (momentum: prices at t-skip and t-skip-lookback; low_vol: lookback+1 consecutive
prices).  Missing history is never back-filled.

The rebalance calendar (last trading day of each ISO week / month) is a function of the trading-day
index only, i.e. of the exchange calendar, not of prices.
"""
from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal, InvalidOperation

import numpy as np
import pandas as pd

__all__ = [
    "TEMPLATES",
    "DEFAULT_PARAMS",
    "normalize_spec",
    "spec_hash",
    "target_weights",
    "cap_weights",
    "rebalance_positions",
    "momentum_top_n",
    "DEFAULT_BAND",
]

TEMPLATES = ("momentum", "low_vol", "equal_weight", "custom")
REBALANCE = ("weekly", "monthly")
DEFAULT_BAND = "0.02"
DEFAULT_PARAMS = {
    "momentum": {"lookback": 63, "skip": 0, "top_n": None, "weighting": "equal", "positive_only": False,
                 "band": DEFAULT_BAND},
    "low_vol": {"lookback": 63, "top_n": None, "band": DEFAULT_BAND},
    "equal_weight": {"min_history": 1, "band": DEFAULT_BAND},
    "custom": {"design": None, "band": DEFAULT_BAND},
}
DEFAULT_BENCHMARK = "QQQ"
DEFAULT_PERIOD = {"years": 5}
_ROUND = 1e12


def _dec(x, name: str) -> Decimal:
    try:
        d = Decimal(str(x))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{name} must be a decimal number, got {x!r}") from exc
    if not d.is_finite():
        raise ValueError(f"{name} must be finite")
    return d


def _dec_str(d: Decimal) -> str:
    s = format(d.normalize(), "f")
    return "0" if s in ("-0", "") else s


def _as_int(x, name: str, lo: int) -> int:
    if isinstance(x, bool) or int(x) != x or int(x) < lo:
        raise ValueError(f"{name} must be an integer >= {lo}")
    return int(x)


def normalize_spec(spec: dict) -> dict:
    """Validate and fill defaults.  Raises ValueError on a bad spec."""
    if not isinstance(spec, dict):
        raise ValueError("spec must be a dict")
    template = spec.get("template")
    if template not in TEMPLATES:
        raise ValueError(f"template must be one of {TEMPLATES}")
    universe = spec.get("universe")
    if not isinstance(universe, (list, tuple)) or not universe:
        raise ValueError("universe must be a non-empty list of tickers")
    uni = sorted({str(t).strip().upper() for t in universe if str(t).strip()})
    if not uni:
        raise ValueError("universe must be a non-empty list of tickers")
    max_w = _dec(spec.get("max_weight", "0.25"), "max_weight")
    min_cash = _dec(spec.get("min_cash", "0.20"), "min_cash")
    if not (Decimal(0) < max_w <= Decimal(1)):
        raise ValueError("max_weight must be in (0, 1]")
    if not (Decimal(0) <= min_cash < Decimal(1)):
        raise ValueError("min_cash must be in [0, 1)")
    rebalance = spec.get("rebalance", "weekly")
    if rebalance not in REBALANCE:
        raise ValueError(f"rebalance must be one of {REBALANCE}")
    exclude_lev = spec.get("exclude_leveraged", True)
    if not isinstance(exclude_lev, bool):
        raise ValueError("exclude_leveraged must be true/false")

    params_in = dict(spec.get("params") or {})
    unknown = set(params_in) - set(DEFAULT_PARAMS[template])
    if unknown:
        raise ValueError(f"unknown params for {template}: {sorted(unknown)}")
    params = {**DEFAULT_PARAMS[template], **params_in}
    if template == "momentum":
        params["lookback"] = _as_int(params["lookback"], "lookback", 2)
        params["skip"] = _as_int(params["skip"], "skip", 0)
        if params["top_n"] is not None:
            params["top_n"] = _as_int(params["top_n"], "top_n", 1)
        if params["weighting"] not in ("equal", "proportional"):
            raise ValueError("weighting must be 'equal' or 'proportional'")
        if not isinstance(params["positive_only"], bool):
            raise ValueError("positive_only must be true/false")
    elif template == "low_vol":
        params["lookback"] = _as_int(params["lookback"], "lookback", 5)
        if params["top_n"] is not None:
            params["top_n"] = _as_int(params["top_n"], "top_n", 1)
    elif template == "custom":
        from .strategy_lang import normalize_design
        params["design"] = normalize_design(params["design"])
    else:
        params["min_history"] = _as_int(params["min_history"], "min_history", 1)
    band = _dec(params["band"], "band")
    if not (Decimal(0) <= band < Decimal(1)):
        raise ValueError("band must be in [0, 1)")
    params["band"] = _dec_str(band)

    period = dict(spec.get("period") or DEFAULT_PERIOD)
    if set(period) - {"years", "start", "end"}:
        raise ValueError("period accepts years/start/end")
    if "years" in period and period["years"] is not None:
        period["years"] = _as_int(period["years"], "period.years", 1)
    for k in ("start", "end"):
        if period.get(k) is not None:
            pd.Timestamp(period[k])  # validates
            period[k] = str(pd.Timestamp(period[k]).date())
    period = {k: v for k, v in period.items() if v is not None}
    if not period:
        period = dict(DEFAULT_PERIOD)

    return {
        "template": template,
        "params": params,
        "universe": uni,
        "max_weight": _dec_str(max_w),
        "min_cash": _dec_str(min_cash),
        "rebalance": rebalance,
        "exclude_leveraged": exclude_lev,
        "benchmark": str(spec.get("benchmark") or DEFAULT_BENCHMARK).strip().upper(),
        "period": period,
    }


def spec_hash(spec: dict) -> str:
    """sha256 of the canonical JSON of the normalized spec."""
    norm = normalize_spec(spec)
    blob = json.dumps(norm, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def momentum_top_n(max_weight: str, min_cash: str) -> int:
    """N = ceil((1 - min_cash) / max_weight), computed in Decimal (0.8 / 0.2 is exactly 4)."""
    q = (Decimal(1) - Decimal(min_cash)) / Decimal(max_weight)
    return max(1, int(q.to_integral_value(rounding="ROUND_CEILING")))


def cap_weights(scores: dict[str, float], total: float, cap: float) -> dict[str, float]:
    """Scale positive scores to ``total`` with a per-name ``cap`` (iterative redistribution)."""
    free = {t: float(s) for t, s in sorted(scores.items()) if s is not None and np.isfinite(s) and s > 0}
    out: dict[str, float] = {}
    remaining = float(total)
    while free and remaining > 0:
        ssum = sum(free.values())
        alloc = {t: remaining * s / ssum for t, s in free.items()}
        over = [t for t, w in alloc.items() if w > cap]
        if not over:
            out.update(alloc)
            break
        for t in over:
            out[t] = cap
            remaining -= cap
            del free[t]
    # round down so the caps hold exactly despite float error
    res = {t: math.floor(w * _ROUND) / _ROUND for t, w in sorted(out.items())}
    res = {t: min(w, cap) for t, w in res.items() if w > 0}
    # the float sum of exactly-capped weights can still exceed ``total`` by an ulp
    # (6 x 0.1405 -> 0.8430000000000001 > 1 - 0.157): shave ulps off the largest weight until
    # both the plain left-to-right sum and the correctly rounded fsum fit.
    for _ in range(64):
        vals = list(res.values())
        if not vals or (sum(vals) <= total and math.fsum(vals) <= total):
            break
        t_max = max(res, key=lambda t: (res[t], t))
        res[t_max] = math.nextafter(res[t_max], 0.0)
    return res


def _leveraged_tickers() -> frozenset[str]:
    from .universe import load_universe

    return frozenset(i.ticker for i in load_universe() if i.kind == "leveraged_etf")


def target_weights(spec: dict, prices: pd.DataFrame, asof_index: int) -> dict[str, float]:
    """Target weights at the close of row ``asof_index`` using rows <= asof_index only.

    Returns {ticker: weight} for names with weight > 0 (sorted by ticker).  Cash = 1 - sum.
    """
    s = normalize_spec(spec)
    n_rows = len(prices.index)
    if not isinstance(asof_index, (int, np.integer)) or not (0 <= asof_index < n_rows):
        raise IndexError(f"asof_index {asof_index} outside 0..{n_rows - 1}")
    hist = prices.iloc[: int(asof_index) + 1]  # <- the only data used below
    tickers = [t for t in s["universe"] if t in hist.columns]
    if s["exclude_leveraged"]:
        lev = _leveraged_tickers()
        tickers = [t for t in tickers if t not in lev]
    if not tickers:
        return {}
    arr = hist[tickers].to_numpy(dtype="float64")
    last = arr[-1]
    p = s["params"]
    total = 1.0 - float(Decimal(s["min_cash"]))
    cap = float(Decimal(s["max_weight"]))
    scores: dict[str, float] = {}

    if s["template"] == "momentum":
        L, k = p["lookback"], p["skip"]
        i_end, i_start = len(arr) - 1 - k, len(arr) - 1 - k - L
        if i_start < 0:
            return {}
        raw = {}
        for j, t in enumerate(tickers):
            a, b, now = arr[i_start, j], arr[i_end, j], last[j]
            if np.isfinite(a) and np.isfinite(b) and np.isfinite(now) and a > 0:
                raw[t] = b / a - 1.0
        ranked = sorted(raw.items(), key=lambda kv: (-kv[1], kv[0]))
        if p["positive_only"]:
            ranked = [(t, r) for t, r in ranked if r > 0]
        n = p["top_n"] or momentum_top_n(s["max_weight"], s["min_cash"])
        pick = ranked[:n]
        if p["weighting"] == "equal":
            scores = {t: 1.0 for t, _ in pick}
        else:
            scores = {t: r for t, r in pick if r > 0}
            if pick and not scores:
                return {}
            # names with non-positive momentum keep their slot as cash: scale total down accordingly
            total = total * len(scores) / len(pick) if pick else total

    elif s["template"] == "low_vol":
        L = p["lookback"]
        if len(arr) < L + 1:
            return {}
        win = arr[-(L + 1):]
        vols = {}
        for j, t in enumerate(tickers):
            col = win[:, j]
            if np.all(np.isfinite(col)) and np.all(col > 0):
                r = np.diff(np.log(col))
                v = float(np.std(r, ddof=1))
                if v > 0:
                    vols[t] = v
        ranked = sorted(vols.items(), key=lambda kv: (kv[1], kv[0]))
        if p["top_n"]:
            ranked = ranked[: p["top_n"]]
        scores = {t: 1.0 / v for t, v in ranked}

    elif s["template"] == "custom":
        from .strategy_lang import design_scores, fundamental_signals, market_tickers
        market = {m: hist[m].to_numpy(dtype="float64") for m in market_tickers(p["design"]) if m in hist.columns}
        # Point-in-time fundamentals travel as "<TICKER>::<signal>" columns of the same frame (rows <= t only).
        fund = {sig: np.column_stack([hist[f"{t}::{sig}"].to_numpy(dtype="float64") if f"{t}::{sig}" in hist.columns
                                      else np.full(len(hist), np.nan) for t in tickers])
                for sig in fundamental_signals(p["design"])}
        scores, exposure = design_scores(p["design"], arr, tickers, market, momentum_top_n(s["max_weight"], s["min_cash"]), fund)
        total *= exposure

    else:  # equal_weight
        mh = p["min_history"]
        if len(arr) < mh:
            return {}
        for j, t in enumerate(tickers):
            col = arr[-mh:, j]
            if np.all(np.isfinite(col)):
                scores[t] = 1.0

    return cap_weights(scores, total, cap)


def rebalance_positions(index: pd.DatetimeIndex, freq: str) -> list[int]:
    """Row positions that are the last trading day of each ISO week ('weekly') or month ('monthly')."""
    if freq not in REBALANCE:
        raise ValueError(f"rebalance must be one of {REBALANCE}")
    idx = pd.DatetimeIndex(index)
    if freq == "weekly":
        iso = idx.isocalendar()
        keys = list(zip(iso["year"].to_numpy(), iso["week"].to_numpy()))
    else:
        keys = list(zip(idx.year, idx.month))
    out = []
    for i in range(len(keys)):
        if i == len(keys) - 1 or keys[i + 1] != keys[i]:
            out.append(i)
    return out
