"""Helpers for the research-engine tests (kept out of conftest.py on purpose)."""
import numpy as np
import pandas as pd


def synthetic_prices(n_days: int = 700, tickers=("AAA", "BBB", "CCC", "DDD", "EEE", "FFF"), seed: int = 7,
                     late: dict | None = None) -> pd.DataFrame:
    """Random-walk adjusted closes on business days; ``late`` = {ticker: first valid row}."""
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2020-01-01", periods=n_days)
    steps = rng.normal(0.0004, 0.02, size=(n_days, len(tickers)))
    px = 50.0 * np.exp(np.cumsum(steps, axis=0))
    df = pd.DataFrame(px, index=idx, columns=list(tickers))
    for t, first in (late or {}).items():
        df.iloc[:first, df.columns.get_loc(t)] = np.nan
    df.index.name = "date"
    return df
