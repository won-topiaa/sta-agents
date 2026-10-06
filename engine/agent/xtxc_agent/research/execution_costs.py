"""Execution cost of buying the *token* instead of the share: "profit you can actually buy".

Inputs
------
``order_usdc``  order size in USDC atoms (6 decimals), e.g. 539_568_345 = 539.568345 USDC.
``quotes``      ticker -> quote, or ticker -> [quote, ...] at several sizes, where a quote is
                ``{"input_atoms", "output_atoms", "decimals", "quoted_at", "source"}`` (USDC in, token
                atoms out, token decimals).  Optional per quote: ``"input_decimals"`` (default 6) and
                ``"ui_multiplier"`` (shares represented by 1 whole token; xStocks use the Token-2022
                scaled-UI-amount extension, so this is not always 1).
Underlying close: the last *unadjusted* close of the ticker in a price snapshot (``snapshot_id``;
default the latest snapshot containing the quoted tickers), or an explicit ``underlying_close={ticker: price}``.

Outputs (per ticker)
--------------------
``premium_bps``  (token implied price / underlying close - 1) x 1e4, from the **smallest** quote
                 (closest to the pool's marginal price).
``cost_bps``     total shortfall at the **order size**: (1 - value_of_tokens_at_underlying_close /
                 usdc_paid) x 1e4, i.e. premium + slippage + pool fees.  Uses the smallest quote whose
                 input >= order; if every quote is smaller the largest is used and flagged.
``source``       ``"quote:<quote source>"`` or ``"default-conservative"``.
``flags``/``detail``  extensions: why a number is missing or suspect, and the raw inputs.

Missing quote (or no underlying close) -> ``cost_bps = 100`` with ``source="default-conservative"``.

1 token = 1 share is **verified, not assumed**: if the implied price is outside 0.8x..1.25x the
underlying close, the quote is not used (default-conservative cost, ``premium_bps=None``) and the
result is flagged ``price-ratio-suspect`` with the nearest split-like factor and recent split events
from the snapshot.  (Observed 2026-09-21 in the StockMesh catalog: NFLXx ~10.2x NFLX after its 10:1
split, TQQQx ~2.05x TQQQ after its 2:1 split, UBERx ~2.84x UBER with no split.)  Nothing is silently
rescaled.  Amounts are computed in Decimal; bps are returned as float rounded to 0.01.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal, getcontext

__all__ = ["token_cost_model", "cost_model_from", "xtxc_cost_model", "DEFAULT_CONSERVATIVE_BPS",
           "USDC_DECIMALS", "RATIO_BAND"]

getcontext().prec = 34
USDC_DECIMALS = 6
DEFAULT_CONSERVATIVE_BPS = 100.0
RATIO_BAND = (Decimal("0.8"), Decimal("1.25"))
_SPLIT_FACTORS = (2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50, 100)
_STALE_CLOSE_DAYS = 4


def _default(flags: list[str], detail: dict | None = None) -> dict:
    return {"cost_bps": DEFAULT_CONSERVATIVE_BPS, "premium_bps": None, "source": "default-conservative",
            "flags": flags, "detail": detail or {}}


def _as_list(q) -> list[dict]:
    if q is None:
        return []
    if isinstance(q, dict):
        return [q]
    return [x for x in q if isinstance(x, dict)]


def _valid(q: dict) -> bool:
    try:
        return int(q["input_atoms"]) > 0 and int(q["output_atoms"]) > 0 and int(q["decimals"]) >= 0
    except (KeyError, TypeError, ValueError):
        return False


def _implied_price(q: dict) -> Decimal:
    """USDC paid per share implied by a quote (per whole token / ui_multiplier)."""
    usdc = Decimal(int(q["input_atoms"])) / (Decimal(10) ** int(q.get("input_decimals", USDC_DECIMALS)))
    tokens = Decimal(int(q["output_atoms"])) / (Decimal(10) ** int(q["decimals"]))
    mult = Decimal(str(q["ui_multiplier"])) if q.get("ui_multiplier") not in (None, "") else Decimal(1)
    return usdc / (tokens * mult)


def _bps(ratio: Decimal) -> float:
    return float(round((ratio - 1) * Decimal(10000), 2))


def _scaling_guess(ratio: Decimal) -> str | None:
    for f in _SPLIT_FACTORS:
        for cand, label in ((Decimal(f), f"{f}x"), (Decimal(1) / Decimal(f), f"1/{f}x")):
            if abs(ratio / cand - 1) <= Decimal("0.05"):
                return label
    return None


def _underlying(tickers: list[str], snapshot_id: str | None) -> tuple[dict, dict, dict, str | None]:
    from .marketdata import latest_snapshot_id, load_prices, snapshot_record

    sid = snapshot_id or latest_snapshot_id(tickers=tickers)
    if sid is None:
        return {}, {}, {}, None
    closes = load_prices(sid, field="close")
    rec = snapshot_record(sid)
    px, asof, splits = {}, {}, {}
    for t in tickers:
        if t in closes.columns:
            col = closes[t].dropna()
            if len(col):
                px[t] = float(col.iloc[-1])
                asof[t] = str(col.index[-1].date())
        cutoff = str(dt.date.fromisoformat(rec["manifest"]["as_of"]) - dt.timedelta(days=730))
        splits[t] = [e for e in (rec.get("events", {}).get(t) or []) if e["type"] == "split" and e["date"] >= cutoff]
    return px, asof, splits, sid


def token_cost_model(tickers: list[str], order_usdc: int, quotes: dict, *, snapshot_id: str | None = None,
                     underlying_close: dict | None = None) -> dict:
    """ticker -> {"cost_bps", "premium_bps", "source", "flags", "detail"} (see module docstring)."""
    if int(order_usdc) <= 0:
        raise ValueError("order_usdc must be a positive number of USDC atoms")
    order = int(order_usdc)
    tickers = [str(t).strip().upper() for t in tickers]
    quotes = {str(k).strip().upper(): v for k, v in (quotes or {}).items()}
    need = [t for t in tickers if any(_valid(q) for q in _as_list(quotes.get(t)))]
    if underlying_close is not None:
        px = {str(k).upper(): float(v) for k, v in underlying_close.items()}
        asof, splits, sid = {}, {}, None
    elif need:
        px, asof, splits, sid = _underlying(need, snapshot_id)
    else:
        px, asof, splits, sid = {}, {}, {}, snapshot_id

    out: dict[str, dict] = {}
    for t in tickers:
        qs = [q for q in _as_list(quotes.get(t)) if _valid(q)]
        if not qs:
            out[t] = _default(["no-quote"] if t not in quotes else ["invalid-quote"])
            continue
        close = px.get(t)
        if close is None or not close > 0:
            out[t] = _default(["underlying-close-missing"], {"snapshot_id": sid})
            continue
        c = Decimal(repr(close))
        small = min(qs, key=lambda q: int(q["input_atoms"]))
        bigger = [q for q in qs if int(q["input_atoms"]) >= order]
        at_size = min(bigger, key=lambda q: int(q["input_atoms"])) if bigger else max(qs, key=lambda q: int(q["input_atoms"]))
        r_small = _implied_price(small) / c
        r_size = _implied_price(at_size) / c
        flags: list[str] = []
        if not bigger:
            flags.append("order-larger-than-quotes")
        if any(q.get("ui_multiplier") in (None, "") for q in (small, at_size)):
            flags.append("ui-multiplier-not-provided")
        detail = {
            "underlying_close": close,
            "underlying_as_of": asof.get(t),
            "snapshot_id": sid,
            "implied_price_smallest": float(round(_implied_price(small), 6)),
            "implied_price_at_size": float(round(_implied_price(at_size), 6)),
            "ratio_smallest": float(round(r_small, 6)),
            "ratio_at_size": float(round(r_size, 6)),
            "smallest_input_atoms": int(small["input_atoms"]),
            "at_size_input_atoms": int(at_size["input_atoms"]),
            "order_usdc_atoms": order,
            "quoted_at": at_size.get("quoted_at"),
        }
        qa, ua = at_size.get("quoted_at"), asof.get(t)
        if qa and ua:
            try:
                q_date = dt.datetime.fromisoformat(str(qa).replace("Z", "+00:00")).date()
                if (q_date - dt.date.fromisoformat(ua)).days > _STALE_CLOSE_DAYS:
                    flags.append("underlying-close-older-than-quote")
            except ValueError:
                flags.append("quoted_at-unparsed")
        suspect = [r for r in (r_small, r_size) if not (RATIO_BAND[0] <= r <= RATIO_BAND[1])]
        if suspect:
            detail["scaling_factor_guess"] = _scaling_guess(suspect[0])
            detail["recent_splits"] = splits.get(t, [])
            out[t] = _default(flags + ["price-ratio-suspect"], detail)
            continue
        out[t] = {
            "cost_bps": _bps(r_size),
            "premium_bps": _bps(r_small),
            "source": f"quote:{at_size.get('source') or 'unknown'}",
            "flags": flags,
            "detail": detail,
        }
    return out


def cost_model_from(token_costs: dict) -> dict[str, float]:
    """per_ticker_bps for ``run_backtest``.

    A negative shortfall (token cheaper than the share) is used as its absolute value: the backtest
    charges the same bps on buys and sells, and on the way out the same gap works against you.
    """
    return {t: abs(float(v["cost_bps"])) for t, v in sorted(token_costs.items())}


def xtxc_cost_model(token_costs: dict, default_bps: float = DEFAULT_CONSERVATIVE_BPS) -> dict:
    """Full cost model for the XTXC run: {"default_bps": 100, "per_ticker_bps": cost_model_from(...)}."""
    return {"default_bps": float(default_bps), "per_ticker_bps": cost_model_from(token_costs)}
