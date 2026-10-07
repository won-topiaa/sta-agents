"""Strategy language for AI-designed strategies: typed building blocks instead of code.

The AI (Quant Builder role) never writes program code. It writes a *design*: a small JSON object made only of the
blocks below. Code validates it (unknown keys, ranges, sizes), canonicalises it (so equal designs hash equally) and
turns it into target weights with the same guarantees as the built-in templates: long/cash only, per-name cap,
cash floor, and only prices up to the decision day (``hist`` is sliced before anything is computed).

Design
------
::

    {
      "score":   [{"signal": "momentum", "lookback": 126, "skip": 21, "weight": 1.0}, ...],   # 1..4 terms
      "filters": [{"signal": "trend", "lookback": 200, "rule": "above", "value": 0.0}, ...],    # 0..3 filters
      "top_n": 5,                           # or null: the fewest names whose capped weights fill the budget
      "weighting": "equal" | "rank" | "inverse_volatility",
      "risk_off": {"ticker": "QQQ", "signal": "trend", "lookback": 200, "below": 0.0, "exposure": 0.5}   # or null
    }

Signals (per stock, from adjusted closes up to the decision day; a stock without the full window is skipped)
  momentum(lookback, skip)   return over ``lookback`` days ending ``skip`` days ago
  volatility(lookback)       standard deviation of daily log returns
  trend(lookback)            price / average price of the window - 1
  drawdown(lookback)         price / highest price of the window - 1   (0 or negative)
  sharpe(lookback)           mean / standard deviation of daily log returns (return per unit of risk)
  rsi(lookback)              relative strength index, 0..100: 100 x average gain / (average gain + average loss) over
                             ``lookback`` daily moves (simple averages, so the value depends only on the window)
  zscore(lookback)           (price - average) / standard deviation over the window: the position in a Bollinger band
                             (-2 is the lower band of a 2-standard-deviation band)
  ma_cross(fast, lookback)   ``fast``-day average / ``lookback``-day average - 1 (above 0: the short average is on top,
                             i.e. a "golden cross" state)
  rel_strength(lookback)     return over ``lookback`` days minus the Nasdaq-100 (QQQ) return over the same days
  volume_surge               20-day average volume / 120-day average volume - 1 (trading activity picking up)
  dollar_volume              log10 of the 20-day average traded value in dollars (7 = $10M a day)
  money_flow                 20-day money flow: (dollars traded on up days - on down days) / all dollars traded, -1..1
  sector_momentum            median three-month return of the company's sector (every released company of it)
  sector_money_flow          20-day money flow of the whole sector: money moving into (>0) or out of (<0) it
Company fundamentals (research/fundamentals.py, as filed by the decision day): earnings_yield, book_to_price, fcf_yield,
  roe, debt_to_equity, revenue_growth, dividend_yield, ebitda_yield (EBITDA / enterprise value), and
  earnings_yield_vs_sector / book_to_price_vs_sector (the company's value minus its sector's median that day).
Score   sum of weight x cross-sectional z-score of each signal (among the stocks that passed the filters).
Filters ``rule``: "above" / "below" a ``value`` of the raw signal, or "top_fraction" / "bottom_fraction" (keep that
        share of the stocks, by the signal; at least one stock). ``value`` is -1..1 except rsi (0..100) and zscore (-5..5).
        A model writes at most ``MAX_FILTERS``; an agent profile may add its own enforced filters on top
        (``MAX_TOTAL_FILTERS`` in all, see ``research/agent_profile``).
Weighting  equal; rank (best-ranked gets the most, linear in rank); inverse_volatility (1 / volatility over 63 days).
hold_buffer  (optional, 1..4) a stock already held stays while it ranks within ``hold_buffer`` x the number of holdings
           and still passes the filters, so fewer trades are made for small changes in rank
exit       (optional) {"stop_loss": x, "trailing_stop": y}: between rebalances a holding is sold once its close is x
           below its entry close, or y below its highest close since entry; it stays out until the next rebalance
breadth_off  (optional) {"lookback": L, "below": b, "exposure": e}: when fewer than b of the stocks trade above their
           L-day average, the invested budget is multiplied by e (with risk_off, the smaller exposure applies)
risk_off   when the market ticker's signal is below ``below``, the invested budget is multiplied by ``exposure``
           (the rest stays cash). The ticker is only read, never bought unless it is also one of the stocks.
"""

from __future__ import annotations

import hashlib
import json
import math

import numpy as np

PRICE_SIGNALS = ("momentum", "volatility", "trend", "drawdown", "sharpe", "rsi", "zscore", "ma_cross", "rel_strength")
# Trading activity, precomputed per day from rows <= t (research/volume.py).
VOLUME_SIGNALS = ("volume_surge", "dollar_volume", "money_flow", "sector_momentum", "sector_money_flow")
# Company fundamentals as of the decision day (research/fundamentals.py).
FUNDAMENTAL_SIGNALS = ("earnings_yield", "book_to_price", "fcf_yield", "roe", "debt_to_equity", "revenue_growth",
                       "dividend_yield", "ebitda_yield", "earnings_yield_vs_sector", "book_to_price_vs_sector")
# Read from "<TICKER>::<signal>" columns of the price frame; ``lookback`` does not apply (stored as 5).
COLUMN_SIGNALS = VOLUME_SIGNALS + FUNDAMENTAL_SIGNALS
SIGNALS = PRICE_SIGNALS + COLUMN_SIGNALS
RULES = ("above", "below", "top_fraction", "bottom_fraction")
WEIGHTINGS = ("equal", "rank", "inverse_volatility")
MARKET_TICKERS = ("QQQ", "SPY")
LOOKBACK = (5, 252)
SKIP = (0, 63)
MAX_TERMS, MAX_FILTERS, MAX_TOP_N = 4, 3, 20
MAX_TOTAL_FILTERS = 9
HOLD_BUFFER = (1.0, 4.0)
EXIT_RANGE = (0.02, 0.5)
BENCHMARK = "QQQ"   # rel_strength compares with it
# raw-value range a filter may compare against; every other signal is a fraction (-1..1)
FILTER_VALUE = {"rsi": (0.0, 100.0), "zscore": (-5.0, 5.0), "book_to_price": (0.0, 10.0), "roe": (-2.0, 2.0),
                "debt_to_equity": (0.0, 20.0), "revenue_growth": (-1.0, 5.0), "volume_surge": (-1.0, 5.0),
                "dollar_volume": (3.0, 12.0)}
INV_VOL_LOOKBACK = 63


class DesignError(ValueError):
    pass


def _int(x, name, lo, hi) -> int:
    try:
        ok = not isinstance(x, bool) and isinstance(x, (int, float)) and math.isfinite(float(x)) and int(x) == x and lo <= int(x) <= hi
    except (OverflowError, ValueError):
        ok = False
    if not ok:
        raise DesignError(f"{name} must be an integer from {lo} to {hi}")
    return int(x)


def _num(x, name, lo, hi) -> float:
    try:
        ok = not isinstance(x, bool) and isinstance(x, (int, float)) and math.isfinite(float(x)) and lo <= float(x) <= hi
    except (OverflowError, ValueError):
        ok = False
    if not ok:
        raise DesignError(f"{name} must be a number from {lo} to {hi}")
    return round(float(x), 6)


def _keys(d, allowed: set, required: set, name: str) -> None:
    if not isinstance(d, dict):
        raise DesignError(f"{name} must be an object")
    extra, missing = set(d) - allowed, required - set(d)
    if extra:
        raise DesignError(f"{name}: unknown keys {sorted(extra)}")
    if missing:
        raise DesignError(f"{name}: missing keys {sorted(missing)}")


def _signal(d, name) -> dict:
    if d.get("signal") not in SIGNALS:
        raise DesignError(f"{name}.signal must be one of {list(SIGNALS)}")
    out = {"signal": d["signal"], "lookback": _int(d.get("lookback", 5), f"{name}.lookback", *LOOKBACK)}
    if d["signal"] in COLUMN_SIGNALS:
        if d.get("skip") not in (0, None) or "fast" in d:
            raise DesignError(f"{name}: {d['signal']} takes no skip or fast")
        return {"signal": d["signal"], "lookback": 5}
    if d["signal"] == "momentum":
        out["skip"] = _int(d.get("skip", 0), f"{name}.skip", *SKIP)
    elif "skip" in d and d["skip"] not in (0, None):
        raise DesignError(f"{name}.skip is only for momentum")
    if d["signal"] == "ma_cross":
        if out["lookback"] < 3:
            raise DesignError(f"{name}.lookback must be at least 3 for ma_cross")
        out["fast"] = _int(d.get("fast"), f"{name}.fast", 2, out["lookback"] - 1)
    elif "fast" in d:
        raise DesignError(f"{name}.fast is only for ma_cross")
    return out


def normalize_design(design) -> dict:
    """Validate and canonicalise. Raises DesignError with a message the model can act on."""
    _keys(design, {"score", "filters", "top_n", "weighting", "risk_off", "hold_buffer", "exit", "breadth_off"}, {"score", "weighting"}, "design")
    terms = design["score"]
    if not isinstance(terms, list) or not 1 <= len(terms) <= MAX_TERMS:
        raise DesignError(f"score must be a list of 1 to {MAX_TERMS} terms")
    score = []
    for i, t in enumerate(terms):
        _keys(t, {"signal", "lookback", "skip", "fast", "weight"}, {"signal", "lookback", "weight"}, f"score[{i}]")
        term = {**_signal(t, f"score[{i}]"), "weight": _num(t["weight"], f"score[{i}].weight", -3, 3)}
        if term["weight"] == 0:
            raise DesignError(f"score[{i}].weight must not be 0")
        score.append(term)
    filters = []
    if not isinstance(design.get("filters") or [], list):
        raise DesignError("filters must be a list")
    for i, f in enumerate(design.get("filters") or []):
        _keys(f, {"signal", "lookback", "skip", "fast", "rule", "value"}, {"signal", "lookback", "rule", "value"}, f"filters[{i}]")
        if not isinstance(f["signal"], str) or not isinstance(f["rule"], str):
            raise DesignError(f"filters[{i}]: signal and rule must be text")
        if f["rule"] not in RULES:
            raise DesignError(f"filters[{i}].rule must be one of {list(RULES)}")
        lo, hi = (0.1, 0.9) if f["rule"].endswith("fraction") else FILTER_VALUE.get(f.get("signal"), (-1.0, 1.0))
        filters.append({**_signal(f, f"filters[{i}]"), "rule": f["rule"], "value": _num(f["value"], f"filters[{i}].value", lo, hi)})
    if len(filters) > MAX_TOTAL_FILTERS:
        raise DesignError(f"at most {MAX_TOTAL_FILTERS} filters")
    top_n = design.get("top_n")
    top_n = None if top_n is None else _int(top_n, "top_n", 1, MAX_TOP_N)
    if design["weighting"] not in WEIGHTINGS:
        raise DesignError(f"weighting must be one of {list(WEIGHTINGS)}")
    ro = design.get("risk_off")
    if ro is not None:
        _keys(ro, {"ticker", "signal", "lookback", "below", "exposure"}, {"ticker", "signal", "lookback", "below", "exposure"}, "risk_off")
        if ro["ticker"] not in MARKET_TICKERS:
            raise DesignError(f"risk_off.ticker must be one of {list(MARKET_TICKERS)}")
        if ro["signal"] not in ("trend", "momentum", "drawdown"):
            raise DesignError("risk_off.signal must be trend, momentum or drawdown")
        ro = {"ticker": ro["ticker"], "signal": ro["signal"], "lookback": _int(ro["lookback"], "risk_off.lookback", *LOOKBACK),
              "below": _num(ro["below"], "risk_off.below", -1, 1), "exposure": _num(ro["exposure"], "risk_off.exposure", 0, 1)}
    # Optional parts appear in the canonical form only when used, so designs without them keep their hash.
    extra = {}
    if design.get("hold_buffer") is not None:
        hb = _num(design["hold_buffer"], "hold_buffer", *HOLD_BUFFER)
        if hb > 1:   # 1 keeps nothing extra: the same design as without it
            extra["hold_buffer"] = hb
    ex = design.get("exit")
    if ex is not None:
        _keys(ex, {"stop_loss", "trailing_stop"}, set(), "exit")
        ex = {k: None if ex.get(k) is None else _num(ex[k], f"exit.{k}", *EXIT_RANGE) for k in ("stop_loss", "trailing_stop")}
        if any(v is not None for v in ex.values()):
            extra["exit"] = ex
    bo = design.get("breadth_off")
    if bo is not None:
        _keys(bo, {"lookback", "below", "exposure"}, {"lookback", "below", "exposure"}, "breadth_off")
        bo = {"lookback": _int(bo["lookback"], "breadth_off.lookback", 20, LOOKBACK[1]),
              "below": _num(bo["below"], "breadth_off.below", 0.05, 0.95),
              "exposure": _num(bo["exposure"], "breadth_off.exposure", 0, 1)}
        if bo["exposure"] < 1:   # full exposure changes nothing
            extra["breadth_off"] = bo
    # canonical order: terms and filters sorted so the same idea written differently hashes the same
    score.sort(key=lambda t: json.dumps(t, sort_keys=True))
    filters.sort(key=lambda t: json.dumps(t, sort_keys=True))
    return {"score": score, "filters": filters, "top_n": top_n, "weighting": design["weighting"], "risk_off": ro, **extra}


def design_hash(design: dict) -> str:
    return hashlib.sha256(json.dumps(normalize_design(design), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def window(design: dict) -> int:
    """Rows of history a stock needs before it can be scored."""
    d = normalize_design(design)
    need = [t["lookback"] + t.get("skip", 0) for t in d["score"] + d["filters"]]
    if d["weighting"] == "inverse_volatility":
        need.append(INV_VOL_LOOKBACK)
    return max(need) + 1


def fundamental_signals(design: dict) -> set[str]:
    d = normalize_design(design)
    return {t["signal"] for t in d["score"] + d["filters"] if t["signal"] in FUNDAMENTAL_SIGNALS}


def column_signals(design: dict) -> set[str]:
    d = normalize_design(design)
    return {t["signal"] for t in d["score"] + d["filters"] if t["signal"] in COLUMN_SIGNALS}


def market_tickers(design: dict) -> list[str]:
    d = normalize_design(design)
    out = [d["risk_off"]["ticker"]] if d["risk_off"] else []
    if any(t["signal"] == "rel_strength" for t in d["score"] + d["filters"]) and BENCHMARK not in out:
        out.append(BENCHMARK)
    return out


# ------------------------------------------------------------------ evaluation (rows <= t only)
def _signal_values(sig: dict, arr: np.ndarray, fund: dict[str, np.ndarray] | None = None,
                   bench: np.ndarray | None = None) -> np.ndarray:
    """Signal per column of ``arr`` (rows = days up to the decision day). NaN when the window is incomplete.
    Column signals read the last row of ``fund[signal]`` (same columns as ``arr``): the value as of that day."""
    if sig["signal"] in COLUMN_SIGNALS:
        f = (fund or {}).get(sig["signal"])
        if f is None or f.shape[0] == 0:
            return np.full(arr.shape[1], np.nan)
        v = f[-1].astype(float)
        return np.where(np.isfinite(v), v, np.nan)
    L, k = sig["lookback"], sig.get("skip", 0)
    n = arr.shape[0]
    out = np.full(arr.shape[1], np.nan)
    if sig["signal"] == "rel_strength":
        if bench is None or len(bench) != n:
            return out
        own = _signal_values({"signal": "momentum", "lookback": L, "skip": 0}, arr)
        market = _signal_values({"signal": "momentum", "lookback": L, "skip": 0}, bench.reshape(-1, 1))[0]
        return own - market if np.isfinite(market) else out
    if sig["signal"] == "momentum":
        if n - 1 - k - L < 0:
            return out
        a, b = arr[n - 1 - k - L], arr[n - 1 - k]
        with np.errstate(invalid="ignore", divide="ignore"):
            return np.where((a > 0) & np.isfinite(a) & np.isfinite(b), b / a - 1.0, np.nan)
    if n < L + 1:
        return out
    win = arr[n - L - 1:]
    ok = np.all(np.isfinite(win) & (win > 0), axis=0)
    if sig["signal"] in ("volatility", "sharpe"):
        with np.errstate(invalid="ignore", divide="ignore"):
            r = np.diff(np.log(np.where(ok, win, 1.0)), axis=0)
            sd = r.std(axis=0, ddof=1)
            val = sd if sig["signal"] == "volatility" else np.where(sd > 0, r.mean(axis=0) / sd, np.nan)
        return np.where(ok, val, np.nan)
    if sig["signal"] == "rsi":
        moves = np.diff(np.where(ok, win, 1.0), axis=0)
        gain, loss = np.clip(moves, 0, None).mean(axis=0), np.clip(-moves, 0, None).mean(axis=0)
        with np.errstate(invalid="ignore", divide="ignore"):
            val = np.where(gain + loss > 0, 100.0 * gain / (gain + loss), 50.0)   # no movement at all: neutral
        return np.where(ok, val, np.nan)
    last = win[-1]
    if sig["signal"] == "zscore":
        w = win[1:]
        sd = w.std(axis=0)
        with np.errstate(invalid="ignore", divide="ignore"):
            return np.where(ok & (sd > 0), (last - w.mean(axis=0)) / sd, np.where(ok, 0.0, np.nan))
    if sig["signal"] == "ma_cross":
        fast = win[-sig["fast"]:].mean(axis=0)
        slow = win[1:].mean(axis=0)
        with np.errstate(invalid="ignore", divide="ignore"):
            return np.where(ok & (slow > 0), fast / slow - 1.0, np.nan)
    base = win[1:].mean(axis=0) if sig["signal"] == "trend" else win[1:].max(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(ok & (base > 0), last / base - 1.0, np.nan)


def _z(x: np.ndarray) -> np.ndarray:
    sd = float(np.std(x))
    return np.zeros_like(x) if sd <= 0 or not math.isfinite(sd) else (x - float(np.mean(x))) / sd


def breadth(hist_arr: np.ndarray, lookback: int) -> float:
    """Share of the stocks (with a full window) whose last close is above their ``lookback``-day average; NaN if none."""
    v = _signal_values({"signal": "trend", "lookback": lookback}, hist_arr)
    v = v[np.isfinite(v)]
    return float(np.mean(v > 0)) if len(v) else float("nan")


def design_scores(design: dict, hist_arr: np.ndarray, tickers: list[str], market: dict[str, np.ndarray],
                  default_top_n: int, fundamentals: dict[str, np.ndarray] | None = None,
                  held: set[str] | frozenset | None = None) -> tuple[dict[str, float], float]:
    """(scores for cap_weights, exposure multiplier). ``hist_arr`` rows are days <= t, columns ``tickers``;
    ``fundamentals[signal]`` has the same rows and columns (point-in-time company values). ``held`` is what the
    strategy holds going into day t (only used with ``hold_buffer``)."""
    fund = fundamentals or {}
    d = normalize_design(design)
    bench = market.get(BENCHMARK)
    exposure = 1.0
    ro = d["risk_off"]
    if ro and ro["ticker"] in market:
        m = _signal_values(ro, market[ro["ticker"]].reshape(-1, 1))[0]
        if np.isfinite(m) and m < ro["below"]:
            exposure = ro["exposure"]
    bo = d.get("breadth_off")
    if bo:
        b = breadth(hist_arr, bo["lookback"])
        if np.isfinite(b) and b < bo["below"]:
            exposure = min(exposure, bo["exposure"])
    need = window(d)
    if hist_arr.shape[0] < need or not tickers:
        return {}, exposure
    alive = np.all(np.isfinite(hist_arr[-need:]) & (hist_arr[-need:] > 0), axis=0)
    idx = np.flatnonzero(alive)
    # Every filter looks at the same eligible stocks and a stock must pass all of them, so the order of filters never
    # matters and "the top 50%" is half of the eligible stocks with a value, not half of what another filter left.
    passed = np.ones(len(idx), dtype=bool)
    fbase = {k: a[:, idx] for k, a in fund.items()}
    for f in d["filters"]:
        v = _signal_values(f, hist_arr[:, idx], fbase, bench)
        keep = np.isfinite(v)
        if f["rule"] == "above":
            keep &= v > f["value"]
        elif f["rule"] == "below":
            keep &= v < f["value"]
        else:
            finite = np.flatnonzero(keep)
            if len(finite):
                k = max(1, int(math.floor(len(finite) * f["value"] + 1e-9)))
                order = finite[np.argsort(-v[finite] if f["rule"] == "top_fraction" else v[finite], kind="stable")]
                keep = np.zeros_like(keep)
                keep[order[:k]] = True
        passed &= keep
    idx = idx[passed]
    if not len(idx):
        return {}, exposure
    sub = hist_arr[:, idx]
    fsub = {k: a[:, idx] for k, a in fund.items()}
    vals = [(_signal_values(t, sub, fsub, bench), t["weight"]) for t in d["score"]]
    ok = np.all([np.isfinite(v) for v, _ in vals], axis=0)
    if not ok.any():
        return {}, exposure
    total = np.zeros(int(ok.sum()))
    for v, w in vals:
        total += w * _z(v[ok])
    names = [tickers[j] for j in idx[ok]]
    order = sorted(range(len(names)), key=lambda i: (-total[i], names[i]))
    n = min(d["top_n"] or default_top_n, len(order))
    pick = order[:n]
    if d.get("hold_buffer") and held:
        # Holdings still within the buffer keep their place; the rest of the slots go to the best-ranked others.
        reach = int(math.ceil(n * d["hold_buffer"]))
        keep = [i for i in order[:reach] if names[i] in held][:n]
        pick = sorted(keep + [i for i in order if i not in keep][:n - len(keep)], key=order.index)
    if d["weighting"] == "equal":
        return {names[i]: 1.0 for i in pick}, exposure
    if d["weighting"] == "rank":
        return {names[i]: float(n - r) for r, i in enumerate(pick)}, exposure
    iv = _signal_values({"signal": "volatility", "lookback": INV_VOL_LOOKBACK}, sub[:, ok])
    return {names[i]: 1.0 / float(iv[i]) for i in pick if np.isfinite(iv[i]) and iv[i] > 0}, exposure


def scaled(design: dict, factor: float) -> dict:
    """The same design with every lookback multiplied by ``factor`` (robustness check)."""
    d = normalize_design(design)

    def s(x):
        return max(LOOKBACK[0], min(LOOKBACK[1], int(round(x["lookback"] * factor))))

    def periods(x):
        if x["signal"] in COLUMN_SIGNALS:
            return x
        out = {**x, "lookback": s(x)}
        if "fast" in x:   # the short average stays shorter than the long one
            out["fast"] = max(2, min(out["lookback"] - 1, int(round(x["fast"] * factor))))
        return out
    out = {**d, "score": [periods(t) for t in d["score"]], "filters": [periods(f) for f in d["filters"]]}
    if d["risk_off"]:
        out["risk_off"] = {**d["risk_off"], "lookback": s(d["risk_off"])}
    if d.get("breadth_off"):
        out["breadth_off"] = {**d["breadth_off"], "lookback": max(20, s(d["breadth_off"]))}
    return normalize_design(out)
