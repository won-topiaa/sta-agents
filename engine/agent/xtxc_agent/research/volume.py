"""Trading-activity signals per stock, as "<TICKER>::<signal>" columns of the price frame.

Every value on day t uses rows <= t only (trailing rolling means), so the backtester's slicing and the future-data
perturbation test cover them like any other column. Volume and the unadjusted close come from the same verified
price release (Yahoo volume is split-adjusted, like the close)."""

from __future__ import annotations

import numpy as np
import pandas as pd

SHORT, LONG = 20, 120
SIGNALS = ("volume_surge", "dollar_volume")


def ticker_panel(close: pd.Series, volume: pd.Series) -> dict[str, np.ndarray]:
    v = volume.astype("float64")
    short = v.rolling(SHORT, min_periods=SHORT).mean()
    long = v.rolling(LONG, min_periods=LONG).mean()
    traded = (close.astype("float64") * v).rolling(SHORT, min_periods=SHORT).mean()
    with np.errstate(invalid="ignore", divide="ignore"):
        surge = np.where(long > 0, short / long - 1.0, np.nan)
        dollars = np.where(traded > 0, np.log10(traded), np.nan)
    return {"volume_surge": surge, "dollar_volume": dollars}


def attach(prices: pd.DataFrame, closes: pd.DataFrame, volumes: pd.DataFrame) -> pd.DataFrame:
    cols = {}
    for t in volumes.columns:
        if t not in closes.columns:
            continue
        panel = ticker_panel(closes[t].reindex(prices.index), volumes[t].reindex(prices.index))
        for s, arr in panel.items():
            cols[f"{t}::{s}"] = arr
    return pd.concat([prices, pd.DataFrame(cols, index=prices.index)], axis=1) if cols else prices
