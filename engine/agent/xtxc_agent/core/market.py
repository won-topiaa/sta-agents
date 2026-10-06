"""US regular-session calendar (NYSE/Nasdaq), expressed for Korean users.

Tokenized stocks trade around the clock, but the underlying market does not.
Outside the regular session the token price can drift from the last close,
so orders placed then get a caution light and a 'wait for the open' option.
Early closes are treated as full days (conservative only in the other direction:
they are listed so the UI never claims an early-close afternoon is open).
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
KST = ZoneInfo("Asia/Seoul")
OPEN = time(9, 30)
CLOSE = time(16, 0)

HOLIDAYS = {
    # 2026 NYSE full-day closures
    date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16), date(2026, 4, 3), date(2026, 5, 25),
    date(2026, 6, 19), date(2026, 7, 3), date(2026, 9, 7), date(2026, 11, 26), date(2026, 12, 25),
    # 2027 NYSE full-day closures
    date(2027, 1, 1), date(2027, 1, 18), date(2027, 2, 15), date(2027, 3, 26), date(2027, 5, 31),
    date(2027, 6, 18), date(2027, 7, 5), date(2027, 9, 6), date(2027, 11, 25), date(2027, 12, 24),
}
EARLY_CLOSE = {date(2026, 11, 27): time(13, 0), date(2026, 12, 24): time(13, 0), date(2027, 11, 26): time(13, 0)}


_override: bool | None = None  # dev-only demo switch; every caller sees the same value


def set_override(value: bool | None) -> None:
    global _override
    _override = value


def _is_session_day(d: date) -> bool:
    return d.weekday() < 5 and d not in HOLIDAYS


def status(at: datetime | None = None) -> dict:
    at = (at or datetime.now(timezone.utc)).astimezone(NY)
    close = EARLY_CLOSE.get(at.date(), CLOSE)
    is_open = _is_session_day(at.date()) and OPEN <= at.time() < close
    if _override is not None and at.tzinfo is not None and abs((datetime.now(timezone.utc) - at).total_seconds()) < 60:
        is_open = _override
    nxt = next_open(at)
    result = {"open": is_open, "next_open_kst": nxt.astimezone(KST).isoformat(), "next_open_ny": nxt.isoformat()}
    if _override is not None:
        result["dev_override"] = _override
    if is_open:
        result["closes_kst"] = datetime.combine(at.date(), close, NY).astimezone(KST).isoformat()
    return result


def next_open(at: datetime) -> datetime:
    at = at.astimezone(NY)
    d = at.date()
    if _is_session_day(d) and at.time() < OPEN:
        return datetime.combine(d, OPEN, NY)
    d += timedelta(days=1)
    while not _is_session_day(d):
        d += timedelta(days=1)
    return datetime.combine(d, OPEN, NY)
