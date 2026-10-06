"""Volatility forecast on XTXC's execution data, for the horizon the user picks (1 hour .. 3 years).

What the user gets per stock: how far the price may move over the horizon (an 80% range), for holding periods of a
month or more how far it may dip below the entry price along the way, and what buying (and later selling) its token
may cost. Every number is checked on the past first: the backtest shows how often the real outcome fell inside the
range on data the model had not seen.

Three models, one per kind of horizon. Each is walk-forward backtested out of sample against a simpler baseline and
the live forecast uses whichever scored better in its own backtest (execution data has to earn its place):

1. hours (1..24)   token model      The token trades around the clock. HAR regression on hourly token returns plus
                                    how much of the window the US market is open.  Baseline: EWMA of token returns.
                                    Data: token_bars of the execution tape (post-trade, every on-chain trade).
2. days (1..21)    off-hours model  Users usually ask while the US market is closed (Asian daytime). Stock data stops
                                    at the last close; the token keeps trading. The range starts from the token-implied
                                    price now and its width uses what the token did since the close.
                                    Baseline: the price-history model anchored at the last close (what an agent without
                                    execution data can do). Data: token_bars + the verified price release.
3. days (1..756)   price model      Direct HAR regression of the average daily variance over the next h trading days on
                                    the past day / week / month / quarter / year, pooled over all stocks, on the verified
                                    quant-store release (2010..). Baselines: past-year volatility, EWMA (RiskMetrics).

Ranges are 80% ranges: the multiple of the predicted volatility that covered 80% of the training outcomes. Scores:
coverage (share of test outcomes inside), average width, and the interval score (width plus a penalty for misses,
lower is better) used to choose between model and baseline. Training data always ends before a test period starts
(targets included), so overlapping windows cannot leak.

Pre-trade cost: the tape's size-tiered quotes -> cost of buying / selling at the user's size now and its recent range,
separately for US-market open and closed. Premium: token vs stock at the session close over the tape's window.
"""

from __future__ import annotations

import datetime as dt
import math
import re
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from . import marketdata as md
from . import quantstore

NY = ZoneInfo("America/New_York")
OPEN_T, CLOSE_T = dt.time(9, 30), dt.time(16, 0)
COVER = 0.80
ALPHA = 1 - COVER
FLOOR_D = 1e-6            # daily variance floor (0.1% move)
FLOOR_H = 1e-8            # hourly variance floor
MIN_TRAIN, MIN_TEST = 400, 50
EXEC_MAX_DAYS = 21
EXEC_MIN_TRAIN, EXEC_MIN_TEST, EXEC_MIN_DECIDE = 150, 20, 150
MAX_OFFHOURS_MOVE = 0.30  # larger overnight token moves are treated as data errors (e.g. a scaled-UI change)

# ------------------------------------------------------------------ horizons
UNITS = {"h": (1, 24, 0), "d": (1, 756, 1), "w": (1, 156, 5), "m": (1, 36, 21), "y": (1, 3, 252)}
CHOICES = ("1h", "1d", "1w", "1m", "3m", "6m", "1y", "3y")
_H = re.compile(r"^\s*(\d{1,3})\s*([hdwmy])\s*$")


@dataclass(frozen=True)
class Horizon:
    code: str
    unit: str
    n: int

    @property
    def hours(self) -> int:
        return self.n if self.unit == "h" else 0

    @property
    def days(self) -> int:
        """Trading days (a week is 5, a month 21, a year 252)."""
        return 0 if self.unit == "h" else self.n * UNITS[self.unit][2]


def parse_horizon(code) -> Horizon:
    m = _H.match(str(code or "").lower())
    if not m:
        raise ValueError("horizon must look like 1h, 1d, 2w, 3m or 1y")
    n, unit = int(m.group(1)), m.group(2)
    lo, hi, _ = UNITS[unit]
    if not lo <= n <= hi:
        raise ValueError(f"{unit} horizons go from {lo} to {hi}")
    return Horizon(f"{n}{unit}", unit, n)


# ------------------------------------------------------------------ calendar
def session_close(d: dt.date) -> dt.datetime:
    from ..core.market import EARLY_CLOSE
    return dt.datetime.combine(d, EARLY_CLOSE.get(d, CLOSE_T), NY)


def session_open(d: dt.date) -> dt.datetime:
    return dt.datetime.combine(d, OPEN_T, NY)


def _utc(ts) -> pd.Timestamp:
    return pd.Timestamp(ts).tz_convert("UTC")


def _is_open(ts: dt.datetime, sessions: set[dt.date]) -> bool:
    t = ts.astimezone(NY)
    return t.date() in sessions and session_open(t.date()) <= t < session_close(t.date())


# ------------------------------------------------------------------ scoring
def _score(y: np.ndarray, center: np.ndarray, sigma: np.ndarray, k: float) -> dict:
    lo, hi = center - k * sigma, center + k * sigma
    inside = (y >= lo) & (y <= hi)
    miss = np.maximum(lo - y, 0) + np.maximum(y - hi, 0)
    return {"n": int(len(y)), "coverage": float(inside.mean()) if len(y) else None,
            "width": float(np.median(np.exp(hi) - np.exp(lo))) if len(y) else None,
            "score": float(((hi - lo) + (2 / ALPHA) * miss).mean()) if len(y) else None}


def _k(dev: np.ndarray, sigma: np.ndarray) -> float:
    z = np.abs(dev) / np.maximum(sigma, 1e-12)
    return float(np.quantile(z[np.isfinite(z)], COVER))


def _ols(X: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, float]:
    b, *_ = np.linalg.lstsq(X, y, rcond=None)
    smear = float(np.mean(np.exp(y - X @ b)))       # Duan smearing: log-scale fit -> variance scale
    return b, smear


def _pool(parts: list[dict], keys: tuple[str, ...]) -> dict:
    return {k: np.concatenate([p[k] for p in parts]) if parts else np.array([]) for k in keys}


# ------------------------------------------------------------------ data
@dataclass
class Daily:
    adj: pd.DataFrame          # date x ticker, adjusted close
    raw: pd.DataFrame          # date x ticker, session close as traded
    release_id: str
    as_of: str
    provenance: dict


def load_daily(root: Path | None = None) -> Daily:
    """Every ticker of the verified quant release (see quantstore.build_release)."""
    root = root or md.data_dir()
    rel = quantstore.load_release(root)
    adj, raw = {}, {}
    for t, info in sorted(rel["tickers"].items()):
        if not info.get("object"):
            continue
        rows = md._csv_to_rows(md._read_object(root, info["object"]))
        idx = pd.DatetimeIndex([r[0] for r in rows])
        adj[t] = pd.Series([np.nan if r[2] is None else float(r[2]) for r in rows], index=idx)
        raw[t] = pd.Series([np.nan if r[1] is None else float(r[1]) for r in rows], index=idx)
    A = pd.DataFrame(adj).sort_index()
    R = pd.DataFrame(raw).reindex(A.index)
    return Daily(A, R, rel["release_id"], str(A.index.max().date()),
                 {t: info.get("provenance") for t, info in rel["tickers"].items()})


class TapeReader:
    """Read-only view of the execution tape (research.exectape)."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def _q(self, sql: str, params=()) -> list[tuple]:
        if not self.path.exists():
            return []
        conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, timeout=10)
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()

    def watermark(self) -> tuple:
        """Changes when new bars arrive (not with every quote): the fitted models depend on bars only."""
        r = self._q("SELECT MAX(ts), COUNT(*), MAX(fetched_at) FROM token_bars WHERE tf = 'hour'")
        return tuple(r[0]) if r else (None,)

    def primary_mints(self) -> dict[str, str]:
        """ticker -> the token product with the most USD traded in the tape (its trades are what we follow)."""
        rows = self._q("SELECT p.ticker, b.mint, SUM(b.v_usd) FROM token_bars b JOIN products p ON p.mint = b.mint "
                       "WHERE b.tf = 'hour' GROUP BY p.ticker, b.mint")
        best: dict[str, tuple[float, str]] = {}
        for t, m, v in rows:
            if t not in best or (v or 0) > best[t][0]:
                best[t] = (v or 0, m)
        return {t: m for t, (_, m) in best.items()}

    def hourly(self, mint: str) -> pd.DataFrame:
        """Bars of the product's primary pool: index = bar END (UTC), columns c (USD), v (USD volume)."""
        rows = self._q("SELECT ts, c, v_usd FROM token_bars WHERE mint = ? AND tf = 'hour' AND pool = "      # = Tape.history_pool
                       "(SELECT pool FROM token_bars WHERE mint = ? AND tf = 'hour' GROUP BY pool ORDER BY COUNT(*) DESC LIMIT 1) "
                       "ORDER BY ts", (mint, mint))
        if not rows:
            return pd.DataFrame(columns=["c", "v"])
        a = np.array(rows, dtype="float64")
        idx = pd.to_datetime(a[:, 0].astype("int64") + 3600, unit="s", utc=True)
        return pd.DataFrame({"c": a[:, 1], "v": a[:, 2]}, index=idx)

    def quotes(self, ticker: str, since_iso: str, mint: str | None = None) -> list[dict]:
        """Quotes of one token product (products of the same stock can trade at different prices, e.g. Ondo vs xStocks)."""
        rows = self._q("SELECT q.set_id, q.ts, q.side, q.usd, q.in_atoms, q.out_atoms, p.decimals, q.mint FROM quotes q "
                       "JOIN products p ON p.mint = q.mint WHERE q.ticker = ? AND q.ts >= ? AND q.error IS NULL "
                       "AND q.out_atoms IS NOT NULL AND (? IS NULL OR q.mint = ?) ORDER BY q.ts", (ticker, since_iso, mint, mint))
        return [dict(zip(("set_id", "ts", "side", "usd", "in_atoms", "out_atoms", "decimals", "mint"), r)) for r in rows]

    def stockmesh_orders(self) -> list[dict]:
        cols = ("order_id", "instrument", "side", "input_atoms", "quoted_output", "minimum_output", "final_phase", "actual_output",
                "block_time", "execution")
        try:
            rows = self._q(f"SELECT {', '.join(cols)} FROM stockmesh_orders")
        except sqlite3.OperationalError:          # an older tape without the table
            return []
        return [dict(zip(cols, r)) for r in rows]

    def counts(self) -> dict:
        b = self._q("SELECT COUNT(*), COUNT(DISTINCT mint), MIN(ts), MAX(ts) FROM token_bars WHERE tf = 'hour'")
        q = self._q("SELECT COUNT(*), COUNT(DISTINCT set_id), MIN(ts), MAX(ts) FROM quotes WHERE error IS NULL")
        fmt = lambda t: dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat(timespec="minutes") if t else None
        return {"bars": b[0][0] if b else 0, "products": b[0][1] if b else 0,
                "bars_first": fmt(b[0][2]) if b else None, "bars_last": fmt(b[0][3] + 3600) if b and b[0][3] else None,
                "quotes": q[0][0] if q else 0, "quote_sets": q[0][1] if q else 0,
                "quotes_first": q[0][2] if q else None, "quotes_last": q[0][3] if q else None}


# ------------------------------------------------------------------ 3. price model (days)
_PKEYS = ("tick", "pos", "origin", "end", "X", "R", "V", "pmin", "hist", "ewma", "sub")


def _ticker_series(adj: pd.Series):
    s = adj.dropna()
    s = s[s > 0]
    if len(s) < 80:
        return None
    r = np.diff(np.log(s.to_numpy()))
    dates = s.index[1:].to_numpy(dtype="datetime64[D]")
    r2 = r * r
    ser = pd.Series(r2)
    wins = [ser.rolling(w).mean().to_numpy() for w in (5, 21, 63, 252)]
    for i in (2, 3):                   # a recent listing: the longest window falls back to the longest one it has
        wins[i] = np.where(np.isnan(wins[i]), wins[i - 1], wins[i])
    feats = np.column_stack([np.ones(len(r)), np.log(np.maximum(r2, FLOOR_D))] + [np.log(np.maximum(w, FLOOR_D)) for w in wins])
    short = np.isnan(ser.rolling(252).mean().to_numpy())
    return dates, r, r2, feats, wins[3], ser.ewm(alpha=0.06, adjust=False).mean().to_numpy(), short


def _price_panel(daily: Daily, h: int) -> tuple[dict, dict, list[str]]:
    parts, live = [], {}
    tickers = [t for t in daily.adj.columns]
    step = max(1, h // 5)
    for ti, t in enumerate(tickers):
        ts = _ticker_series(daily.adj[t])
        if ts is None:
            continue
        dates, r, r2, X, hist, ewma, short = ts
        n = len(r)
        c = np.concatenate([[0.0], np.cumsum(r)])
        c2 = np.concatenate([[0.0], np.cumsum(r2)])
        ok = np.isfinite(X).all(axis=1)
        live[t] = {"X": X[n - 1], "hist": hist[n - 1], "ewma": ewma[n - 1], "date": str(dates[n - 1]), "ok": bool(ok[n - 1]),
                   "short_history": bool(short[n - 1]), "days": int(n)}
        i = np.arange(n - h)
        i = i[ok[i]]
        if not len(i):
            continue
        roll_min = pd.Series(c).rolling(h).min().to_numpy()
        parts.append({"tick": np.full(len(i), ti), "pos": i, "origin": dates[i], "end": dates[i + h], "X": X[i],
                      "R": c[i + h + 1] - c[i + 1], "V": (c2[i + h + 1] - c2[i + 1]) / h,
                      "pmin": np.minimum(roll_min[i + h + 1] - c[i + 1], 0.0),
                      "hist": hist[i], "ewma": ewma[i], "sub": (i % step) == 0})
    P = _pool(parts, _PKEYS)
    if len(P["tick"]):
        P["y"] = np.log(np.maximum(P["V"], FLOOR_D / 10))
    return P, live, tickers


PRICE_METHODS = ("har", "hist", "ewma")
MIN_CONFORMAL = 200


def _sigmas(P: dict, m, h: int, b: np.ndarray, smear: float) -> dict:
    return {"har": np.sqrt(h * np.exp(P["X"][m] @ b) * smear), "hist": np.sqrt(h * P["hist"][m]), "ewma": np.sqrt(h * P["ewma"][m])}


def _year(d) -> int:
    return int(str(d)[:4])


def price_model(daily: Daily, h: int) -> dict:
    """Walk-forward by calendar year. Each year: fit on windows that ended before it; set the 80% multiple k (and the
    dip quantiles) on the out-of-sample results of earlier years (split conformal, purged), falling back to in-sample
    residuals while fewer than MIN_CONFORMAL exist. The live forecast uses the method with the best interval score."""
    P, live, tickers = _price_panel(daily, h)
    n = len(P["tick"])
    if n == 0:
        raise ValueError("not enough price history")
    sig = {m: np.full(n, np.nan) for m in PRICE_METHODS}
    kk = {m: np.full(n, np.nan) for m in PRICE_METHODS}
    tested = np.zeros(n, dtype=bool)
    years = sorted({_year(d) for d in P["origin"]})
    fits = {}
    for Y in years:
        start = np.datetime64(f"{Y}-01-01")
        tr = (P["end"] < start) & P["sub"]
        te = (P["origin"] >= start) & (P["origin"] < np.datetime64(f"{Y + 1}-01-01"))
        if tr.sum() < MIN_TRAIN or te.sum() == 0:
            continue
        b, smear = _ols(P["X"][tr], P["y"][tr])
        fits[Y] = (b, smear)
        s_te = _sigmas(P, te, h, b, smear)
        prior = tested & P["sub"] & (P["end"] < start)          # earlier out-of-sample windows, already finished
        conformal = prior.sum() >= MIN_CONFORMAL
        s_tr = None if conformal else _sigmas(P, tr, h, b, smear)
        for m in PRICE_METHODS:
            sig[m][te] = s_te[m]
            kk[m][te] = _k(P["R"][prior], sig[m][prior]) if conformal else _k(P["R"][tr], s_tr[m])
        tested |= te
    ev = tested & P["sub"]
    back: dict = {"tests": int(ev.sum())}
    scores = {}
    if ev.sum() >= MIN_TEST:
        R = P["R"][ev]
        for m in PRICE_METHODS:
            scores[m] = _score_vec(R, sig[m][ev], kk[m][ev])
        realized = np.sqrt(h * P["V"][ev])
        err = lambda s: float(np.median(np.abs(np.log(np.maximum(s, 1e-9) / np.maximum(realized, 1e-9)))))
        best = min(PRICE_METHODS, key=lambda m: scores[m]["score"])
        per = {}
        for ti in np.unique(P["tick"][ev]):
            mm = P["tick"][ev] == ti
            per[tickers[ti]] = {"tests": int(mm.sum()), "coverage": float((np.abs(R[mm]) <= kk[best][ev][mm] * sig[best][ev][mm]).mean())}
        span = lambda ti: (P["origin"][ev][P["tick"][ev] == ti].max() - P["origin"][ev][P["tick"][ev] == ti].min()).astype(int)
        # the "bad case" dip (10% quantile) of each test year, set on earlier years' finished windows of the chosen method
        bad = np.zeros(n, dtype=bool)
        judged = np.zeros(n, dtype=bool)
        for Y in years:
            start = np.datetime64(f"{Y}-01-01")
            te = ev & (P["origin"] >= start) & (P["origin"] < np.datetime64(f"{Y + 1}-01-01"))
            prior = ev & (P["end"] < start)
            if te.any() and prior.sum() >= MIN_CONFORMAL:
                q10 = np.quantile(P["pmin"][prior] / sig[best][prior], 0.1)
                bad[te] = P["pmin"][te] < q10 * sig[best][te]
                judged |= te
        back.update(first=str(P["origin"][ev].min()), last=str(P["origin"][ev].max()),
                    independent=int(min(ev.sum(), sum(max(1, int(span(ti) * 252 / 365 // h)) for ti in np.unique(P["tick"][ev])))),
                    model=scores["har"], baselines={"hist": scores["hist"], "ewma": scores["ewma"]}, best=best, scores=scores,
                    vol_error={m: err(sig[m][ev]) for m in PRICE_METHODS},
                    dip_bad_rate=float(bad[judged].mean()) if judged.any() else None, dip_tests=int(judged.sum()),   # target 0.10
                    per_ticker=per)
    best = back.get("best", "har")
    # live: coefficients on every finished window; k and dip quantiles from all out-of-sample windows
    allm = P["sub"] if P["sub"].sum() >= MIN_TRAIN else np.ones(n, dtype=bool)
    b, smear = _ols(P["X"][allm], P["y"][allm])
    if ev.sum() >= MIN_CONFORMAL:
        k_live = {m: _k(P["R"][ev], sig[m][ev]) for m in PRICE_METHODS}
        dd_z = P["pmin"][ev] / sig[best][ev]
    else:
        s_all = _sigmas(P, allm, h, b, smear)
        k_live = {m: _k(P["R"][allm], s_all[m]) for m in PRICE_METHODS}
        dd_z = P["pmin"][allm] / s_all[best]
    out_live = {}
    for t, L in live.items():
        if not L["ok"]:
            continue
        s = {"har": math.sqrt(h * math.exp(float(L["X"] @ b)) * smear), "hist": math.sqrt(h * L["hist"]), "ewma": math.sqrt(h * L["ewma"])}
        if not math.isfinite(s[best]):
            continue
        out_live[t] = {"sigma": s[best], "as_of": L["date"], "short_history": L["short_history"], "days": L["days"]}
    return {"h": h, "method": best, "backtest": back, "k": k_live[best], "dd50": float(np.quantile(dd_z, 0.5)),
            "dd10": float(np.quantile(dd_z, 0.1)), "live": out_live,
            "_oos": {"sigma": sig["har"], "k": kk["har"], "panel": P, "tickers": tickers}}


def _score_vec(y, sigma, k):
    """Interval score etc. with a per-row k (walk-forward calibration differs by test year). Width: median."""
    lo, hi = -k * sigma, k * sigma
    inside = (y >= lo) & (y <= hi)
    miss = np.maximum(lo - y, 0) + np.maximum(y - hi, 0)
    return {"n": int(len(y)), "coverage": float(inside.mean()), "width": float(np.median(np.exp(hi) - np.exp(lo))),
            "score": float(((hi - lo) + (2 / ALPHA) * miss).mean())}


# ------------------------------------------------------------------ token series helpers
def _grid(bars: pd.DataFrame) -> pd.DataFrame:
    """Regular hourly grid from the first to the last bar; hours without trades keep the last price and volume 0."""
    if bars.empty:
        return bars
    idx = pd.date_range(bars.index.min(), bars.index.max(), freq="h")
    g = bars.reindex(idx)
    g["v"] = g["v"].fillna(0.0)
    g["c"] = g["c"].ffill()
    g["traded"] = bars["c"].reindex(idx).notna()
    return g


# ------------------------------------------------------------------ keeping the daily history current (24 hours)
def extend_with_tape(daily: Daily, tape: "TapeReader", *, now: dt.datetime | None = None) -> Daily:
    """The verified quant release ends where the quant store ends. Sessions finished since then are continued with the
    token's own price at each session close (the execution tape, post-trade), chained by returns, so the engine stays
    current around the clock without another price source. A day without a token trade near the close stays empty.
    When the quant store is refreshed and the release rebuilt, these rows are simply superseded."""
    from ..core.market import _is_session_day
    now = now or dt.datetime.now(dt.timezone.utc)
    last = daily.adj.index.max().date()
    days, d = [], last + dt.timedelta(days=1)
    while d <= now.date():
        if _is_session_day(d) and _utc(session_close(d)) + pd.Timedelta(minutes=15) <= pd.Timestamp(now).tz_convert("UTC"):
            days.append(d)
        d += dt.timedelta(days=1)
    if not days:
        return daily
    mints = tape.primary_mints()
    add_adj, add_raw, filled = {}, {}, {}
    for t in daily.adj.columns:
        if t not in mints:
            continue
        g = _grid(tape.hourly(mints[t]))
        if g.empty:
            continue
        traded = g["traded"].to_numpy()

        def token_close(day: dt.date) -> float | None:
            c = _utc(session_close(day))
            i = g.index.searchsorted(c, side="right") - 1
            if i < 0:
                return None
            tr = np.flatnonzero(traded[: i + 1])
            if not len(tr) or g.index[tr[-1]] < c - pd.Timedelta(hours=2):
                return None
            return float(g["c"].iloc[i])

        base_tok = token_close(last)
        base_adj, base_raw = daily.adj[t].dropna(), daily.raw[t].dropna()
        if base_tok is None or base_adj.empty or base_adj.index[-1].date() != last:
            continue
        a0, r0 = float(base_adj.iloc[-1]), float(base_raw.iloc[-1]) if not base_raw.empty else None
        for day in days:
            px = token_close(day)
            if px is None:
                continue
            add_adj.setdefault(t, {})[pd.Timestamp(day)] = a0 * px / base_tok
            if r0:
                add_raw.setdefault(t, {})[pd.Timestamp(day)] = r0 * px / base_tok
            filled[t] = filled.get(t, 0) + 1
    if not add_adj:
        return daily
    idx = daily.adj.index.union(pd.DatetimeIndex([pd.Timestamp(x) for x in days]))
    A, R = daily.adj.reindex(idx), daily.raw.reindex(idx)
    for t, rows in add_adj.items():
        for k, x in rows.items():
            A.loc[k, t] = x
    for t, rows in add_raw.items():
        for k, x in rows.items():
            R.loc[k, t] = x
    prov = dict(daily.provenance)
    prov["_extension"] = {"from": str(days[0]), "to": str(days[-1]), "sessions": len(days), "tickers": len(filled),
                          "source": "execution tape: token price at the session close, chained by returns"}
    filled_days = sorted({k for rows in add_adj.values() for k in rows})
    return Daily(A, R, daily.release_id, str(filled_days[-1].date()), prov)


# ------------------------------------------------------------------ 2. off-hours model (days, with execution data)
def _offhours_rows(daily: Daily, pm: dict, tape: TapeReader, h: int) -> dict:
    """One row per (stock, night): the token's move and activity from the close to tau, and the stock's h-day outcome."""
    P, tickers = pm["_oos"]["panel"], pm["_oos"]["tickers"]
    sigma_oos = pm["_oos"]["sigma"]
    index = {(int(P["tick"][j]), str(P["origin"][j])): j for j in range(len(P["tick"]))}
    mints = tape.primary_mints()
    rows = []
    for ti, t in enumerate(tickers):
        if t not in mints:
            continue
        s = _token_series(tape, mints[t])
        if s is None:
            continue
        ends = s[0]
        cutoff = (ends[0] - pd.Timedelta(days=5)).tz_convert(None)
        days = [d.date() for d in daily.adj[t].dropna().index if d >= cutoff]
        for a, b in zip(days, days[1:]):
            c_close = _utc(session_close(a))
            nxt_open = _utc(session_open(b))
            j = index.get((ti, str(np.datetime64(a))))
            if j is None or not np.isfinite(sigma_oos[j]):
                continue
            for tau in (c_close + pd.Timedelta(hours=4), nxt_open - pd.Timedelta(hours=2)):
                if tau <= c_close + pd.Timedelta(hours=1) or tau > ends[-1]:
                    continue
                row = _offhours_features(*s, c_close, tau)
                if row is not None:
                    rows.append({"tick": ti, "j": j, "tau": tau.value, "end": P["end"][j], "y": P["R"][j], "sp": sigma_oos[j], **row})
    keys = ("tick", "j", "tau", "end", "y", "sp", "g", "rv", "ntr", "vol")
    return {k: np.array([r[k] for r in rows]) for k in keys} if rows else {k: np.array([]) for k in keys}


def _token_series(tape: TapeReader, mint: str):
    g = _grid(tape.hourly(mint))
    if g.empty:
        return None
    close_px = g["c"].to_numpy()
    return (g.index, close_px, g["traded"].to_numpy(), g["v"].to_numpy(), np.concatenate([[0.0], np.diff(np.log(close_px))]))


def offhours_live(om: dict, pm: dict, daily: Daily, tape: TapeReader, tickers, *, now: dt.datetime | None = None) -> dict:
    """Now: the token's move since the last close in the price history, if we are still before the next open."""
    from ..core.market import next_open
    now_ts = pd.Timestamp(now or dt.datetime.now(dt.timezone.utc)).tz_convert("UTC")
    mints = tape.primary_mints()
    f = om.get("_fit")
    out = {}
    for t in tickers:
        if t not in mints or t not in daily.adj or daily.adj[t].dropna().empty:
            continue
        s = _token_series(tape, mints[t])
        if s is None:
            continue
        ends, traded = s[0], s[2]
        last_day = daily.adj[t].dropna().index[-1].date()
        c_close = _utc(session_close(last_day))
        nxt_open = _utc(next_open(c_close.to_pydatetime()))
        tau = min(now_ts, ends[-1])
        feat = _offhours_features(*s, c_close, tau) if tau > c_close else None
        entry = {"last_close_day": str(last_day), "close_utc": c_close.isoformat(), "in_window": bool(now_ts <= nxt_open),
                 "last_trade": ends[traded][-1].isoformat() if traded.any() else None}
        if feat:
            entry.update(g=feat["g"], trade_hours=feat["ntr"], hours=feat["hours"])
        sp = pm["live"].get(t, {}).get("sigma")
        if feat and sp and f:
            one = {"sp": np.array([sp]), "rv": np.array([feat["rv"]]), "g": np.array([feat["g"]]), "ntr": np.array([feat["ntr"]])}
            se = float(np.sqrt(np.exp(_exec_design(one, np.array([True])) @ f["b"]) * f["smear"])[0])
            entry.update(center=f["beta"] * feat["g"], sigma=se)
        out[t] = entry
    return out


def _offhours_features(ends, close_px, traded, vol, lr, c_close, tau) -> dict | None:
    i0 = ends.searchsorted(c_close, side="right") - 1          # last bar ending at or before the close
    i1 = ends.searchsorted(tau, side="right") - 1              # last bar ending at or before tau
    if i0 < 0 or i1 < i0:
        return None
    last_before_close = np.flatnonzero(traded[: i0 + 1])
    if not len(last_before_close) or ends[last_before_close[-1]] < c_close - pd.Timedelta(hours=6):
        return None                                           # no token trade near the close: no reference price
    g = float(np.log(close_px[i1] / close_px[i0]))
    if abs(g) > MAX_OFFHOURS_MOVE:
        return None
    win = slice(i0 + 1, i1 + 1)
    return {"g": g, "rv": float(np.sum(lr[win] ** 2)), "ntr": int(traded[win].sum()), "vol": float(vol[win].sum()),
            "hours": float((tau - c_close).total_seconds() / 3600)}


def _exec_design(D: dict, m) -> np.ndarray:
    sp = D["sp"][m]
    return np.column_stack([np.ones(len(sp)), np.log(sp ** 2), np.log(D["rv"][m] + FLOOR_H), np.abs(D["g"][m]) / sp, np.log1p(D["ntr"][m])])


def _fit_exec(D: dict, m) -> dict:
    g, y = D["g"][m], D["y"][m]
    beta = float(np.clip(np.sum(y * g) / np.sum(g * g), 0.0, 1.5)) if np.sum(g * g) > 0 else 0.0
    resid = y - beta * g
    Z = _exec_design(D, m)
    b, smear = _ols(Z, np.log(resid ** 2 + FLOOR_D / 100))
    se = np.sqrt(np.exp(Z @ b) * smear)
    return {"beta": beta, "b": b, "smear": smear, "k": _k(resid, se), "k_price": _k(y, D["sp"][m])}


def offhours_fit(daily: Daily, pm: dict, tape: TapeReader, h: int) -> dict:
    """Walk-forward by month over the tape's window; the live forecast uses it only when it beat the price-only model."""
    D = _offhours_rows(daily, pm, tape, h)
    n = len(D["y"])
    out = {"h": h, "method": "offhours-token", "rows": n, "use": False, "backtest": {"tests": 0}}
    if n < EXEC_MIN_TRAIN + EXEC_MIN_TEST:
        out["reason"] = "not enough token trading history yet"
        return out
    taus = pd.to_datetime(D["tau"], utc=True)
    months = sorted({(x.year, x.month) for x in taus})
    ends = D["end"]
    res = {"exec": [], "price": []}
    for (yy, mm) in months:
        start = pd.Timestamp(dt.datetime(yy, mm, 1, tzinfo=dt.timezone.utc))
        stop = start + pd.offsets.MonthBegin(1)
        tr = ends < np.datetime64(start.date())
        te = np.asarray((taus >= start) & (taus < stop))
        if tr.sum() < EXEC_MIN_TRAIN or te.sum() < EXEC_MIN_TEST:
            continue
        f = _fit_exec(D, tr)
        se = np.sqrt(np.exp(_exec_design(D, te) @ f["b"]) * f["smear"])
        res["exec"].append((D["y"][te], f["beta"] * D["g"][te], se, np.full(te.sum(), f["k"])))
        res["price"].append((D["y"][te], np.zeros(te.sum()), D["sp"][te], np.full(te.sum(), f["k_price"])))
    if res["exec"]:
        cat = lambda L, i: np.concatenate([x[i] for x in L])
        sc = {}
        for name, L in res.items():
            y, c, s, k = (cat(L, i) for i in range(4))
            lo, hi = c - k * s, c + k * s
            miss = np.maximum(lo - y, 0) + np.maximum(y - hi, 0)
            sc[name] = {"n": int(len(y)), "coverage": float(((y >= lo) & (y <= hi)).mean()),
                        "width": float(np.median(np.exp(hi) - np.exp(lo))), "score": float(((hi - lo) + (2 / ALPHA) * miss).mean())}
        out["backtest"] = {"tests": sc["exec"]["n"], "exec": sc["exec"], "price": sc["price"],
                           "first": taus.min().date().isoformat(), "last": taus.max().date().isoformat(),
                           "tickers": int(len(np.unique(D["tick"])))}
        out["use"] = bool(sc["exec"]["n"] >= EXEC_MIN_DECIDE and sc["exec"]["score"] < sc["price"]["score"])
    f = _fit_exec(D, ends < ends.max())
    out.update(beta=f["beta"], k=f["k"], k_price=f["k_price"], _fit=f)
    return out


def offhours_model(daily: Daily, pm: dict, tape: TapeReader, h: int, *, now: dt.datetime | None = None) -> dict:
    om = offhours_fit(daily, pm, tape, h)
    om["live"] = offhours_live(om, pm, daily, tape, list(daily.adj.columns), now=now) if om.get("_fit") else {}
    return om


# ------------------------------------------------------------------ 1. token model (hours)
def token_model(tape: TapeReader, sessions: set[dt.date], H: int) -> dict:
    mints = tape.primary_mints()
    parts, live = [], {}
    for t, mint in sorted(mints.items()):
        g = _grid(tape.hourly(mint))
        if len(g) < 24 * 30:
            continue
        c = g["c"].to_numpy()
        lr = np.concatenate([[0.0], np.diff(np.log(c))])
        r2 = pd.Series(lr * lr)
        ends = g.index
        open_now = np.array([_is_open(e - pd.Timedelta(minutes=30), sessions) for e in ends], dtype=float)
        fut_open = pd.Series(open_now[::-1]).rolling(H, min_periods=1).mean().to_numpy()[::-1]
        fut_open = np.concatenate([fut_open[1:], [np.nan]])
        vol24 = pd.Series(g["v"].to_numpy()).rolling(24, min_periods=1).sum().to_numpy()
        X = np.column_stack([np.ones(len(c)), np.log(np.maximum(r2.to_numpy(), FLOOR_H))]
                            + [np.log(np.maximum(r2.rolling(w).mean().to_numpy(), FLOOR_H)) for w in (6, 24, 168)]
                            + [fut_open, open_now, np.log1p(vol24)])
        ewma = r2.ewm(alpha=0.03, adjust=False).mean().to_numpy()
        cs = np.concatenate([[0.0], np.cumsum(lr)])
        cs2 = np.concatenate([[0.0], np.cumsum(lr * lr)])
        n = len(c)
        i = np.arange(168, n - H)
        ok = np.isfinite(X[i]).all(axis=1)
        i = i[ok]
        parts.append({"tick": np.full(len(i), len(parts)), "end": ends[i + H].to_numpy(), "origin": ends[i].to_numpy(), "X": X[i],
                      "R": cs[i + H + 1] - cs[i + 1], "V": (cs2[i + H + 1] - cs2[i + 1]) / H, "ewma": ewma[i],
                      "name": np.array([t] * len(i))})
        live[t] = {"X": X[-1].copy(), "ewma": float(ewma[-1]), "price": float(c[-1]), "at": ends[-1].isoformat(),
                   "traded_24h": int(g["traded"].to_numpy()[-24:].sum())}
    out = {"h_hours": H, "method": "har-token-hourly", "use": False, "backtest": {"tests": 0}, "live": {}}
    if not parts:
        out["reason"] = "no token trading history yet"
        return out
    P = _pool(parts, ("tick", "end", "origin", "X", "R", "V", "ewma", "name"))
    y = np.log(np.maximum(P["V"], FLOOR_H / 10))
    step = max(1, H // 2)
    sub = (np.arange(len(y)) % step) == 0
    origin = pd.to_datetime(P["origin"], utc=True)
    months = sorted({(x.year, x.month) for x in origin})
    ev = {"model": [], "ewma": []}
    for (yy, mm) in months:
        start = pd.Timestamp(dt.datetime(yy, mm, 1, tzinfo=dt.timezone.utc))
        stop = start + pd.offsets.MonthBegin(1)
        tr = np.asarray(pd.to_datetime(P["end"], utc=True) < start) & sub
        te = np.asarray((origin >= start) & (origin < stop)) & sub
        if tr.sum() < MIN_TRAIN or te.sum() < MIN_TEST:
            continue
        b, smear = _ols(P["X"][tr], y[tr])
        s_tr = np.sqrt(H * np.exp(P["X"][tr] @ b) * smear)
        k = _k(P["R"][tr], s_tr)
        k_e = _k(P["R"][tr], np.sqrt(H * P["ewma"][tr]))
        s_te = np.sqrt(H * np.exp(P["X"][te] @ b) * smear)
        ev["model"].append(_score(P["R"][te], np.zeros(te.sum()), s_te, k))
        ev["ewma"].append(_score(P["R"][te], np.zeros(te.sum()), np.sqrt(H * P["ewma"][te]), k_e))
    if ev["model"]:
        def agg(L):
            n = sum(x["n"] for x in L)
            return {"n": n, **{key: sum(x[key] * x["n"] for x in L) / n for key in ("coverage", "width", "score")}}
        m, e = agg(ev["model"]), agg(ev["ewma"])
        out["backtest"] = {"tests": m["n"], "model": m, "baseline": e, "first": origin.min().date().isoformat(),
                           "last": origin.max().date().isoformat(), "tickers": len(parts)}
        out["use"] = m["score"] <= e["score"]
    b, smear = _ols(P["X"][sub], y[sub])
    s_all = np.sqrt(H * np.exp(P["X"][sub] @ b) * smear)
    out["_fit"] = {"b": b, "smear": smear, "k": _k(P["R"][sub], s_all), "k_e": _k(P["R"][sub], np.sqrt(H * P["ewma"][sub])),
                   "use_model": bool(out["use"] or not out["backtest"].get("tests"))}
    out["_raw"] = live
    for t in live:
        out["live"][t] = token_live(out, t, sessions)
    return out


def token_live(tm: dict, t: str, sessions: set[dt.date], *, now: dt.datetime | None = None, price_now: tuple | None = None) -> dict | None:
    """The next H hours from now: features from the last bars, the market-open share of the coming hours from the calendar,
    and the freshest price (a newer quote, when given as (price, iso time))."""
    L, f = tm.get("_raw", {}).get(t), tm.get("_fit")
    if not L or not f:
        return None
    H = tm["h_hours"]
    start = pd.Timestamp(now).tz_convert("UTC") if now is not None else pd.Timestamp(L["at"])
    x = L["X"].copy()
    x[5] = float(np.mean([_is_open(start + pd.Timedelta(minutes=30 + 60 * k), sessions) for k in range(H)]))
    sigma = float(np.sqrt(H * np.exp(x @ f["b"]) * f["smear"])) if f["use_model"] else float(np.sqrt(H * L["ewma"]))
    price, at = L["price"], L["at"]
    if price_now and price_now[0] and price_now[1] > at:
        price, at = float(price_now[0]), price_now[1]
    return {"sigma": sigma, "k": f["k"] if f["use_model"] else f["k_e"], "price": price, "at": at, "traded_24h": L["traded_24h"]}


# ------------------------------------------------------------------ pre-trade cost and premium
def _unit_prices(q: list[dict]) -> dict:
    """One quote set -> {("BUY"|"SELL", usd): USD per whole token}."""
    out = {}
    for x in q:
        if x["decimals"] is None:
            continue
        tok_in = x["in_atoms"] / 10 ** x["decimals"]
        if x["side"] == "BUY":
            tok = x["out_atoms"] / 10 ** x["decimals"]
            if tok > 0:
                out[("BUY", x["usd"])] = x["usd"] / tok
        else:
            if tok_in > 0:
                out[("SELL", x["usd"])] = (x["out_atoms"] / 1e6) / tok_in
    return out


def _interp_bps(tiers: dict[float, float], size: float) -> tuple[float | None, bool]:
    if not tiers:
        return None, False
    xs = sorted(tiers)
    lx = np.log(xs)
    ys = np.array([tiers[x] for x in xs])
    if size <= xs[0]:
        return float(ys[0]), False
    if size <= xs[-1] or len(xs) == 1:
        return float(np.interp(np.log(size), lx, ys)), size > xs[-1]
    slope = (ys[-1] - ys[-2]) / (lx[-1] - lx[-2])            # beyond the largest quote: extend the last slope (flagged)
    return float(ys[-1] + slope * (np.log(size) - lx[-1])), True


def cost_profile(tape: TapeReader, ticker: str, size_usd: float, sessions: set[dt.date], *, now: dt.datetime | None = None,
                 days: int = 7, mint: str | None = None) -> dict:
    """Pre-trade cost of the token product the models follow (the stock's most traded product unless `mint` is given)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    mint = mint or tape.primary_mints().get(ticker)
    rows = tape.quotes(ticker, (now - dt.timedelta(days=days)).isoformat(timespec="seconds").replace("+00:00", "Z"), mint)
    sets: dict[str, list[dict]] = {}
    for r in rows:
        sets.setdefault(r["set_id"], []).append(r)
    samples = []
    for sid, q in sets.items():
        up = _unit_prices(q)
        b0, s0 = up.get(("BUY", 100.0)), up.get(("SELL", 100.0))
        if not b0 or not s0:
            continue
        mid = (b0 + s0) / 2
        buy = {usd: (p / mid - 1) * 1e4 for (side, usd), p in up.items() if side == "BUY"}
        sell = {usd: (1 - p / mid) * 1e4 for (side, usd), p in up.items() if side == "SELL"}
        cb, xb = _interp_bps(buy, size_usd)
        cs, xs = _interp_bps(sell, size_usd)
        ts = dt.datetime.fromisoformat(q[0]["ts"].replace("Z", "+00:00"))
        samples.append({"ts": ts, "mid": mid, "buy": cb, "sell": cs, "extrap": xb or xs, "open": _is_open(ts, sessions),
                        "spread_bps": (b0 - s0) / mid * 1e4, "mint": q[0]["mint"]})
    samples.sort(key=lambda s: s["ts"])
    out = {"size_usd": size_usd, "samples": len(samples), "days": days, "first": samples[0]["ts"].isoformat() if samples else None}
    if not samples:
        return out
    last = samples[-1]
    out["now"] = {"buy_bps": last["buy"], "sell_bps": last["sell"], "at": last["ts"].isoformat(), "mid": last["mid"],
                  "age_min": int((now - last["ts"]).total_seconds() // 60), "extrapolated": last["extrap"],
                  "spread_bps": last["spread_bps"]}

    def rng(key, sel):
        v = np.array([s[key] for s in samples if sel(s) and s[key] is not None])
        return {"n": int(len(v)), "p10": float(np.quantile(v, 0.1)), "p50": float(np.median(v)), "p90": float(np.quantile(v, 0.9))} if len(v) else {"n": 0}
    out["buy"] = {"all": rng("buy", lambda s: True), "open": rng("buy", lambda s: s["open"]), "closed": rng("buy", lambda s: not s["open"])}
    out["sell"] = {"all": rng("sell", lambda s: True), "open": rng("sell", lambda s: s["open"]), "closed": rng("sell", lambda s: not s["open"])}
    return out


def premium_profile(daily: Daily, tape: TapeReader, ticker: str) -> dict:
    """Token price at the session close vs the stock's close, over the tape's window."""
    mint = tape.primary_mints().get(ticker)
    if not mint:
        return {"n": 0}
    g = _grid(tape.hourly(mint))
    raw = daily.raw[ticker].dropna() if ticker in daily.raw else pd.Series(dtype=float)
    if g.empty or raw.empty:
        return {"n": 0}
    prem = []
    for d, close in raw[raw.index >= (g.index[0] - pd.Timedelta(days=1)).tz_convert(None)].items():
        c = _utc(session_close(d.date()))
        i = g.index.searchsorted(c, side="right") - 1
        if i < 0:
            continue
        tr = np.flatnonzero(g["traded"].to_numpy()[: i + 1])
        if not len(tr) or g.index[tr[-1]] < c - pd.Timedelta(hours=2):
            continue
        prem.append((d.date().isoformat(), float(g["c"].iloc[i] / close - 1)))
    if not prem:
        return {"n": 0}
    v = np.array([p for _, p in prem])
    ratio = float(np.median(1 + v))
    if not 0.8 <= ratio <= 1.25:          # the token's display unit is not one share (scaled UI amount / split): no premium
        return {"n": len(v), "scaled": True, "ratio": ratio}
    return {"n": len(v), "first": prem[0][0], "last": prem[-1][0], "latest": prem[-1][1],
            "p10": float(np.quantile(v, 0.1)), "p50": float(np.median(v)), "p90": float(np.quantile(v, 0.9))}


# ------------------------------------------------------------------ cache
class Models:
    """Fits are cached per (release, tape watermark, horizon); a fit takes well under a second per horizon."""

    def __init__(self, tape_path: Path, root: Path | None = None):
        self.tape = TapeReader(tape_path)
        self.root = root
        self._daily: Daily | None = None
        self._base: Daily | None = None
        self._daily_key: tuple | None = None
        self._cache: dict[tuple, dict] = {}
        self._lock = threading.RLock()

    def daily(self) -> Daily:
        """The verified release, continued to the last finished session with the tape (see extend_with_tape)."""
        with self._lock:
            rel = quantstore.load_release(self.root or md.data_dir())["release_id"]
            key = (rel, self.tape.watermark())
            if self._daily is None or self._daily_key != key:
                if self._base is None or self._base.release_id != rel:
                    self._base = load_daily(self.root)
                ext = extend_with_tape(self._base, self.tape)
                if self._daily is None or self._daily.release_id != ext.release_id or self._daily.as_of != ext.as_of:
                    self._cache.clear()
                self._daily, self._daily_key = ext, key
            return self._daily

    def sessions(self) -> set[dt.date]:
        from ..core.market import _is_session_day
        d = self.daily()
        known = {x.date() for x in d.adj.index}
        last = max(known)
        extra = {last + dt.timedelta(days=i) for i in range(1, 400)}
        return known | {x for x in extra if _is_session_day(x)}

    def _get(self, key: tuple, compute):
        with self._lock:
            if key not in self._cache:
                if len(self._cache) > 64:
                    self._cache.pop(next(iter(self._cache)))
                self._cache[key] = compute()
            return self._cache[key]

    def price(self, h: int) -> dict:
        d = self.daily()
        return self._get(("price", d.release_id, d.as_of, h), lambda: price_model(d, h))

    def offhours(self, h: int) -> dict:
        d = self.daily()
        return self._get(("off", d.release_id, d.as_of, self.tape.watermark(), h), lambda: offhours_fit(d, self.price(h), self.tape, h))

    def token(self, H: int) -> dict:
        return self._get(("tok", self.tape.watermark(), H), lambda: token_model(self.tape, self.sessions(), H))
