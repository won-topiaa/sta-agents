"""Point-in-time company fundamentals from SEC EDGAR XBRL ``companyfacts``, for value-style research.

Every reported number becomes usable only from the session after its ``filed`` date, so a backtest on day t sees
exactly what had been published by then (restated values carry their own, later, filing date). The panel is attached
to the price frame as extra columns ``"<TICKER>::<signal>"``; the backtester slices rows up to t for these columns
just like prices, and the future-data perturbation test covers them too.

Signals (per stock, as of day t)
  earnings_yield   trailing-twelve-month net income / market value          (higher = cheaper)
  book_to_price    shareholders' equity / market value                       (higher = cheaper)
  fcf_yield        TTM (operating cash flow - capital expenditure) / market value
  roe              TTM net income / shareholders' equity
  debt_to_equity   long-term debt / shareholders' equity                     (lower = safer)
  revenue_growth   TTM revenue / TTM revenue four quarters earlier - 1

Market value = split-adjusted close x shares outstanding put on the same split basis. Yahoo closes are split-adjusted
to today's share count, while filings report the share count of their day; share-count jumps that look like splits
(x2..x20, or 1/2..1/20 within 6%) are applied to the earlier reports so both sides use one basis. This uses the split
ratio, not any later financial value. Companies without US-GAAP filings (ETFs, most foreign filers) get no values.
"""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np
import pandas as pd

SIGNALS = ("earnings_yield", "book_to_price", "fcf_yield", "roe", "debt_to_equity", "revenue_growth")
CONCEPTS = {
    "net_income": ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenuesNetOfInterestExpense"],
    "ocf": ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements"],
    "equity": ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    "debt": ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"],
}
FLOWS = ("net_income", "revenue", "ocf", "capex")
UA = "XTXC STA research skewlabs@skew.deals"


def _facts(doc: dict, concept: str) -> list[dict]:
    for taxonomy in ("us-gaap",):
        units = doc.get("facts", {}).get(taxonomy, {}).get(concept, {}).get("units", {})
        if "USD" in units:
            return units["USD"]
    return []


def _days(a: str, b: str) -> int:
    return (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days


def quarterly(doc: dict, key: str) -> list[tuple[str, str, float]]:
    """(available_from, period_end, 3-month value) for a flow concept; the first filing of each period wins.

    Filings report flows as 3-month figures and/or year-to-date figures (cash-flow statements are usually 6- and
    9-month cumulative). Discrete quarters come from the 3-month facts, else from the difference of consecutive
    cumulative facts with the same fiscal-year start (Q2 = 6M - Q1, Q3 = 9M - 6M, Q4 = FY - 9M). A derived quarter is
    available only once both of its inputs are. Companies rename concepts over time; periods are merged across the
    listed concepts, the higher-priority concept winning for the same period."""
    best: dict[str, tuple[str, str, float]] = {}
    for concept in CONCEPTS[key]:
        direct: dict[str, tuple[str, str, float]] = {}
        chains: dict[str, dict[str, tuple[str, int, float]]] = {}
        for f in _facts(doc, concept):
            if "start" not in f or not f.get("filed") or f.get("val") is None:
                continue
            span = _days(f["start"], f["end"])
            if 80 <= span <= 100:
                cur = direct.get(f["end"])
                if cur is None or f["filed"] < cur[0]:
                    direct[f["end"]] = (f["filed"], f["end"], float(f["val"]))
            if any(lo <= span <= hi for lo, hi in ((80, 100), (170, 190), (260, 280), (350, 380))):
                chain = chains.setdefault(f["start"], {})
                cur = chain.get(f["end"])
                if cur is None or f["filed"] < cur[0]:
                    chain[f["end"]] = (f["filed"], span, float(f["val"]))
        derived: dict[str, tuple[str, str, float]] = {}
        for chain in chains.values():
            points = sorted(chain.items())                      # (end, (filed, span, cumulative value))
            for (e0, (f0, s0, v0)), (e1, (f1, s1, v1)) in zip(points, points[1:]):
                if 80 <= s1 - s0 <= 100:
                    derived[e1] = (max(f0, f1), e1, v1 - v0)
        for k, v in {**derived, **direct}.items():               # a reported 3-month figure beats a derived one
            best.setdefault(k, v)
        # Fiscal years whose quarters were reported as separate 3-month figures: Q4 = FY - (Q1 + Q2 + Q3).
        for chain in chains.values():
            for end, (filed, span, val) in chain.items():
                if 350 <= span <= 380 and end not in best:
                    start = (dt.date.fromisoformat(end) - dt.timedelta(days=span)).isoformat()
                    inside = [q for q in best.values() if start < q[1] < end]
                    if len(inside) == 3:
                        best[end] = (max(filed, *(q[0] for q in inside)), end, val - sum(q[2] for q in inside))
    return sorted(best.values(), key=lambda q: q[1])


def instants(doc: dict, key: str) -> list[tuple[str, str, float]]:
    out: dict[str, tuple[str, str, float]] = {}
    for concept in CONCEPTS[key]:
        mine: dict[str, tuple[str, str, float]] = {}
        for f in _facts(doc, concept):
            if "start" in f or not f.get("filed") or f.get("val") is None:
                continue
            cur = mine.get(f["end"])
            if cur is None or f["filed"] < cur[0]:
                mine[f["end"]] = (f["filed"], f["end"], float(f["val"]))
        for k, v in mine.items():
            out.setdefault(k, v)
    return sorted(out.values(), key=lambda q: q[1])


def shares(doc: dict) -> list[tuple[str, str, float]]:
    # One source only (so split detection never mixes bases): the one reported most recently, among the cover-page
    # count, the balance-sheet count and diluted weighted shares. Multi-class issuers often stop tagging the first.
    facts, sources = doc.get("facts", {}), []
    for taxonomy, concept in (("dei", "EntityCommonStockSharesOutstanding"), ("us-gaap", "CommonStockSharesOutstanding"),
                              ("us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding")):
        found: dict[str, tuple[str, str, float]] = {}
        for f in facts.get(taxonomy, {}).get(concept, {}).get("units", {}).get("shares", []):
            if f.get("filed") and f.get("val"):
                cur = found.get(f["end"])
                if cur is None or f["filed"] < cur[0]:
                    found[f["end"]] = (f["filed"], f["end"], float(f["val"]))
        if len(found) >= 4:
            sources.append(found)
    rows = max(sources, key=lambda r: max(r)) if sources else {}
    out = sorted(rows.values(), key=lambda r: r[1])
    # Put every report on the latest split basis (see module docstring).
    factor, adjusted = 1.0, []
    for i in range(len(out) - 1, -1, -1):
        filed, end, val = out[i]
        if i < len(out) - 1:
            ratio = out[i + 1][2] / val if val else 1.0
            for n in (2, 3, 4, 5, 8, 10, 15, 20):
                if abs(ratio / n - 1) < 0.06:
                    factor *= n
                    break
                if abs(ratio * n - 1) < 0.06:
                    factor /= n
                    break
        adjusted.append((filed, end, val * factor))
    return sorted(adjusted, key=lambda r: r[1])


MAX_AGE_DAYS = 400


def _asof(series: list[tuple[str, str, float]], index: pd.DatetimeIndex, value=lambda rows, i: rows[i][2]) -> np.ndarray:
    """Value per session: from the session after the filing date until a newer filing (or MAX_AGE_DAYS), NaN otherwise."""
    out = np.full(len(index), np.nan)
    days = index.values.astype("datetime64[D]")
    for i, (filed, _end, _v) in enumerate(series):
        v = value(series, i)
        if v is None or not math.isfinite(v):
            continue
        start = np.searchsorted(days, np.datetime64(filed) + np.timedelta64(1, "D"))
        stop = np.searchsorted(days, np.datetime64(filed) + np.timedelta64(MAX_AGE_DAYS, "D"))
        out[start:stop] = v   # later rows are overwritten by later filings (series is ordered by period end)
    return out


def _ttm(rows: list[tuple[str, str, float]]):
    def value(series, i):
        if i < 3:
            return None
        window = series[i - 3:i + 1]
        if _days(window[0][1], window[-1][1]) > 300:   # four consecutive quarters only
            return None
        return sum(r[2] for r in window)
    # A TTM figure is published when its latest quarter is, but never before any of its four quarters.
    return [(max(r[0] for r in rows[max(0, i - 3):i + 1]), rows[i][1], rows[i][2]) for i in range(len(rows))], value


def ticker_panel(doc: dict, close: pd.Series) -> dict[str, np.ndarray]:
    idx = close.index
    sh = _asof(shares(doc), idx)
    mcap = close.to_numpy(dtype=float) * sh
    flows = {}
    for k in FLOWS:
        rows, value = _ttm(quarterly(doc, k))
        flows[k] = _asof(rows, idx, value)
    rev_rows = quarterly(doc, "revenue")
    growth_rows, _ = _ttm(rev_rows)

    def growth(series, i):
        if i < 7:
            return None
        now, before = rev_rows[i - 3:i + 1], rev_rows[i - 7:i - 3]
        if _days(before[0][1], now[-1][1]) > 660:
            return None
        base = sum(r[2] for r in before)
        return sum(r[2] for r in now) / base - 1 if base > 0 else None
    equity = _asof(instants(doc, "equity"), idx)
    debt = _asof(instants(doc, "debt"), idx)
    with np.errstate(invalid="ignore", divide="ignore"):
        valid = mcap > 0
        return {
            "earnings_yield": np.where(valid, flows["net_income"] / mcap, np.nan),
            "book_to_price": np.where(valid, equity / mcap, np.nan),
            "fcf_yield": np.where(valid, (flows["ocf"] - np.nan_to_num(flows["capex"])) / mcap, np.nan),
            "roe": np.where(equity > 0, flows["net_income"] / equity, np.nan),
            "debt_to_equity": np.where(equity > 0, np.nan_to_num(debt) / equity, np.nan),
            "revenue_growth": _asof(growth_rows, idx, growth),
        }


def attach(prices: pd.DataFrame, closes: pd.DataFrame, docs: dict[str, dict], companies: set[str] | None = None) -> pd.DataFrame:
    """Price frame plus "<TICKER>::<signal>" columns (NaN where unknown). ``closes`` are split-adjusted closes.
    ``companies`` limits value signals to operating companies (common stock / ADRs): a gold trust has "net income"
    but no earnings yield in any useful sense."""
    cols = {}
    for t, doc in docs.items():
        if t not in closes.columns or (companies is not None and t not in companies):
            continue
        panel = ticker_panel(doc, closes[t].reindex(prices.index))
        for s, arr in panel.items():
            cols[f"{t}::{s}"] = arr
    return pd.concat([prices, pd.DataFrame(cols, index=prices.index)], axis=1) if cols else prices


# ------------------------------------------------------------------ release (fetched once, content-addressed)
def load_release(root) -> tuple[dict[str, dict], dict]:
    """Facts per ticker from ``<root>/fundamentals/release.json`` (hash-checked). Missing release -> no fundamentals."""
    root = Path(root) / "fundamentals"
    path = root / "release.json"
    if not path.exists():
        return {}, {"available": False}
    rel = json.loads(path.read_text())
    docs = {}
    for ticker, row in rel["tickers"].items():
        raw = gzip.decompress((root / "objects" / f"{row['object']}.json.gz").read_bytes())
        if hashlib.sha256(raw).hexdigest() != row["object"]:
            raise ValueError("WAITING_DATA: Fundamentals object hash mismatch.")
        docs[ticker] = json.loads(raw)
    return docs, {"available": True, "releaseId": rel["release_id"], "fetchedAt": rel["fetched_at"], "source": rel["source"], "tickers": sorted(docs)}


def fetch_release(tickers: list[str], root, fetcher=None) -> dict:
    """Download companyfacts for tickers that have a SEC CIK and write a content-addressed release."""
    import urllib.request

    def get(url):
        if fetcher:
            return fetcher(url)
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    root = Path(root) / "fundamentals"
    (root / "objects").mkdir(parents=True, exist_ok=True)
    ciks = {v["ticker"].upper(): int(v["cik_str"]) for v in json.loads(get("https://www.sec.gov/files/company_tickers.json")).values()}
    rows, missing = {}, []
    for t in tickers:
        cik = ciks.get(t) or ciks.get(t.replace(".", "-"))
        if not cik:
            missing.append(t)
            continue
        try:
            raw = get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json")
        except Exception as exc:   # e.g. 404 for trusts/ETFs without XBRL company facts
            if getattr(exc, "code", None) == 404:
                missing.append(t)
                continue
            raise
        time.sleep(0.15)          # SEC fair access: well under 10 requests per second
        h = hashlib.sha256(raw).hexdigest()
        (root / "objects" / f"{h}.json.gz").write_bytes(gzip.compress(raw))
        doc = json.loads(raw)
        rows[t] = {"cik": cik, "object": h, "entity": doc.get("entityName"), "us_gaap": bool(doc.get("facts", {}).get("us-gaap"))}
    rel = {"schema": "xtxc.fundamentals-release/v1", "source": "SEC EDGAR XBRL companyfacts", "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
           "tickers": rows, "missing": missing}
    rel["release_id"] = hashlib.sha256(json.dumps(rel, sort_keys=True).encode()).hexdigest()
    (root / "release.json").write_text(json.dumps(rel, indent=1, sort_keys=True))
    return rel


if __name__ == "__main__":  # pragma: no cover - operator entry point
    import sys
    target, names = sys.argv[1], sys.argv[2].split(",")
    r = fetch_release(names, target)
    print(json.dumps({"release": r["release_id"], "tickers": len(r["tickers"]), "missing": r["missing"]}))
