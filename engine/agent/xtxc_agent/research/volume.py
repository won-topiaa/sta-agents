"""Trading-activity signals per stock, as "<TICKER>::<signal>" columns of the price frame.

Every value on day t uses rows <= t only (trailing rolling means). The columns are built once for the whole period, so
the future-data perturbation test (which edits finished columns) cannot see a look-ahead inside a builder: each builder
has its own test that changing later rows leaves earlier values unchanged (tests/research/test_technical.py). Volume and the unadjusted close come from the same verified
price release (Yahoo volume is split-adjusted, like the close)."""

from __future__ import annotations

import numpy as np
import pandas as pd

SHORT, LONG = 20, 120
SECTOR_RETURN_DAYS = 63
SIGNALS = ("volume_surge", "dollar_volume", "money_flow")
SECTOR_SIGNALS = ("sector_momentum", "sector_money_flow")


def _signed_dollars(close: pd.Series, volume: pd.Series) -> tuple[pd.Series, pd.Series]:
    """Dollars traded per day, and the same signed by the day's close-to-close direction (0 on unchanged days)."""
    c = close.astype("float64")
    dollars = c * volume.astype("float64")
    return dollars, dollars * np.sign(c.diff())


def ticker_panel(close: pd.Series, volume: pd.Series) -> dict[str, np.ndarray]:
    v = volume.astype("float64")
    short = v.rolling(SHORT, min_periods=SHORT).mean()
    long = v.rolling(LONG, min_periods=LONG).mean()
    traded = (close.astype("float64") * v).rolling(SHORT, min_periods=SHORT).mean()
    total, signed = _signed_dollars(close, volume)
    flow_in = signed.rolling(SHORT, min_periods=SHORT).sum()
    flow_all = total.rolling(SHORT, min_periods=SHORT).sum()
    with np.errstate(invalid="ignore", divide="ignore"):
        surge = np.where(long > 0, short / long - 1.0, np.nan)
        dollars = np.where(traded > 0, np.log10(traded), np.nan)
        flow = np.where(flow_all > 0, flow_in / flow_all, np.nan)
    return {"volume_surge": surge, "dollar_volume": dollars, "money_flow": flow}


def attach(prices: pd.DataFrame, closes: pd.DataFrame, volumes: pd.DataFrame) -> pd.DataFrame:
    cols = {}
    for t in volumes.columns:
        if t not in closes.columns:
            continue
        panel = ticker_panel(closes[t].reindex(prices.index), volumes[t].reindex(prices.index))
        for s, arr in panel.items():
            cols[f"{t}::{s}"] = arr
    return pd.concat([prices, pd.DataFrame(cols, index=prices.index)], axis=1) if cols else prices


def sector_columns(index: pd.DatetimeIndex, closes: pd.DataFrame, volumes: pd.DataFrame, sectors: dict[str, str],
                   wanted: set[str]) -> dict[str, np.ndarray]:
    """Sector-wide signals for the ``wanted`` tickers, from every company of their sectors in ``closes``/``volumes``:
    ``sector_momentum`` (median three-month return of the sector's companies, at least 3 with a value) and
    ``sector_money_flow`` (the sector's signed dollars over its dollars traded, 20 days). Rows <= t only."""
    groups: dict[str, list[str]] = {}
    for t, sec in sectors.items():
        if sec and t in closes.columns:
            groups.setdefault(sec, []).append(t)
    out = {}
    for sec, members in groups.items():
        targets = [t for t in members if t in wanted]
        if not targets:
            continue
        c = closes[members].reindex(index)
        ret = c / c.shift(SECTOR_RETURN_DAYS) - 1.0
        enough = ret.notna().sum(axis=1) >= 3
        momentum = ret.median(axis=1, skipna=True).where(enough).to_numpy()
        total = signed = None
        for t in members:
            if t not in volumes.columns:
                continue
            d, sd = _signed_dollars(closes[t].reindex(index), volumes[t].reindex(index))
            total = d.fillna(0) if total is None else total + d.fillna(0)
            signed = sd.fillna(0) if signed is None else signed + sd.fillna(0)
        flow = np.full(len(index), np.nan)
        if total is not None:
            with np.errstate(invalid="ignore", divide="ignore"):
                all_ = total.rolling(SHORT, min_periods=SHORT).sum()
                flow = np.where(all_ > 0, signed.rolling(SHORT, min_periods=SHORT).sum() / all_, np.nan)
        for t in targets:
            out[f"{t}::sector_momentum"] = momentum
            out[f"{t}::sector_money_flow"] = flow
    return out
