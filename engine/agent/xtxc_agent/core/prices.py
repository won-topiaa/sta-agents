"""Stock closes as of a point in time.

Token prices must be compared with the stock price that was current when the
token price was observed. A daily bar dated D counts as known only after the
16:00 New York close of D. On the local chain the pool state is a capture
(e.g. Sunday 2026-09-20), so the right comparison is Friday's close, not the
latest bar in the snapshot.
"""

from __future__ import annotations

from datetime import datetime, time, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import pandas as pd

NY = ZoneInfo("America/New_York")


def _parse(at: str | datetime | None) -> datetime:
    if at is None:
        return datetime.now(timezone.utc)
    if isinstance(at, datetime):
        return at if at.tzinfo else at.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(at.replace("Z", "+00:00"))


def closes_at(prices: pd.DataFrame, tickers: list[str], at: str | datetime | None = None) -> tuple[dict[str, Decimal], str | None]:
    when = _parse(at)
    known = [d for d in prices.index if datetime.combine(pd.Timestamp(d).date(), time(16, 0), NY) <= when]
    if not known:
        return {}, None
    frame = prices.loc[known]
    out: dict[str, Decimal] = {}
    for t in tickers:
        if t in frame.columns:
            series = frame[t].dropna()
            if len(series):
                out[t] = Decimal(str(float(series.iloc[-1])))
    return out, str(pd.Timestamp(known[-1]).date())
