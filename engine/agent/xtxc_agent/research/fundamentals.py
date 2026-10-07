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
  dividend_yield   TTM dividends paid / market value (0 for a reporting company without dividend payments)
  ebitda_yield     TTM (operating income + depreciation and amortization) / enterprise value
                   (enterprise value = market value + long-term debt - cash)
  *_vs_sector      earnings yield / book-to-price minus the median of the company's sector that day (SIC-based
                   sectors; peers are every company in the release from that sector, needs MIN_SECTOR_PEERS values)

A release stores each company's raw ``companyfacts`` and a small *digest* derived from it (the dated series below,
before any price is involved); research runs read only the digests.

Market value = split-adjusted close x shares outstanding on today's split basis / ordinary shares per ADS. Yahoo
closes are split-adjusted to today's share count, while filings report the share count of their day: each report is
multiplied by the splits after it, taken from the price data's split events (depositary listings, and tickers without
a price file, use share-count jumps that look like splits instead). Which count is used each day is described in
``_shares_per_day``. This uses split ratios, never a later financial value.

US filers tag us-gaap facts; foreign filers (20-F / 40-F) tag ifrs-full facts, often only for fiscal years and half
years: twelve-month values then come from fiscal years and from first halves rolled forward. Values stay in the
reporting currency in the digest and are converted to USD with FRED daily rates (each session at the previous
session's rate) where they meet a USD market value; ratios inside one currency (ROE, debt to equity, growth) need no
rate. ETFs and trusts have no company facts.
"""

from __future__ import annotations

import collections
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

SIGNALS = ("earnings_yield", "book_to_price", "fcf_yield", "roe", "debt_to_equity", "revenue_growth",
           "dividend_yield", "ebitda_yield", "earnings_yield_vs_sector", "book_to_price_vs_sector")
SECTOR_RELATIVE = {"earnings_yield_vs_sector": "earnings_yield", "book_to_price_vs_sector": "book_to_price"}
MIN_SECTOR_PEERS = 3
# Concept names from both taxonomies: US filers tag us-gaap, foreign filers (20-F / 40-F) tag ifrs-full. A name exists in
# one taxonomy only, except ProfitLoss; the order is the priority when a company reports several.
TAXONOMIES = ("us-gaap", "ifrs-full")
CONCEPTS = {
    "net_income": ["NetIncomeLoss", "ProfitLossAttributableToOwnersOfParent", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenuesNetOfInterestExpense",
                "Revenue", "RevenueFromContractsWithCustomers"],
    "ocf": ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
            "CashFlowsFromUsedInOperatingActivities"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements",
              "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities", "PurchaseOfPropertyPlantAndEquipment"],
    "equity": ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
               "EquityAttributableToOwnersOfParent", "Equity"],
    "debt": ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations",
             "NoncurrentPortionOfNoncurrentBorrowings", "LongtermBorrowings", "NoncurrentBorrowings",
             "LongTermNotesPayable", "SeniorLongTermNotes", "ConvertibleNotesPayable"],
    "dividends": ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock", "PaymentsOfOrdinaryDividends",
                  "DividendsPaidClassifiedAsFinancingActivities", "DividendsPaidToEquityHoldersOfParentClassifiedAsFinancingActivities",
                  "DividendsPaid"],
    "operating_income": ["OperatingIncomeLoss", "ProfitLossFromOperatingActivities"],
    "dna": ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet", "Depreciation",
            "DepreciationAndAmortisationExpense", "AdjustmentsForDepreciationAndAmortisationExpense",
            "DepreciationAmortisationAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss"],
    "cash": ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "CashAndCashEquivalents"],
    "eps_diluted": ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "DilutedEarningsLossPerShare",
                    "BasicAndDilutedEarningsLossPerShare"],
}
# Share counts, by kind. The cover-page count is the actual count of the reporting date; multi-class issuers often
# report only one class there (other classes are dimensional facts, absent from companyfacts), and the as-converted
# diluted weighted count then covers every class. See _shares_per_day for how one is chosen each day.
SHARE_SOURCES = {
    "cover": [("dei", "EntityCommonStockSharesOutstanding")],
    "balance": [("us-gaap", "CommonStockSharesOutstanding"), ("ifrs-full", "NumberOfSharesOutstanding")],
    "diluted": [("us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding"), ("ifrs-full", "AdjustedWeightedAverageShares"),
                ("ifrs-full", "WeightedAverageShares")],
}
# American depositary shares: ordinary shares per ADS (filings count ordinary shares, the price is per ADS). Checked
# against the market values in Binance Web3 RWA Data (2026-10-07); a ratio is a fact about the listing, not a fit.
ADR_SHARES = {"TSM": 5, "UMC": 5, "NTES": 5, "PDD": 4, "FUTU": 8, "BABA": 8, "BIDU": 8, "TM": 10, "JD": 2, "BZ": 2, "LI": 2,
              "HIMX": 2, "TCOM": 1}   # TCOM: one ordinary share per ADS after its 2021 subdivision (no ADS price split)
# Reporting currency -> USD: FRED daily noon buying rates (H.10), (series, quoted as units per USD).
FX_SERIES = {"EUR": ("DEXUSEU", False), "GBP": ("DEXUSUK", False), "AUD": ("DEXUSAL", False), "TWD": ("DEXTAUS", True),
             "DKK": ("DEXDNUS", True), "CAD": ("DEXCAUS", True), "JPY": ("DEXJPUS", True), "CNY": ("DEXCHUS", True),
             "KRW": ("DEXKOUS", True), "HKD": ("DEXHKUS", True), "CHF": ("DEXSZUS", True), "SEK": ("DEXSDUS", True),
             "NOK": ("DEXNOUS", True), "INR": ("DEXINUS", True), "SGD": ("DEXSIUS", True), "BRL": ("DEXBZUS", True),
             "MXN": ("DEXMXUS", True), "ZAR": ("DEXSFUS", True)}
FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={}"
FLOWS = ("net_income", "revenue", "ocf", "capex", "dividends", "operating_income", "dna")
UA = "XTXC STA research skewlabs@skew.deals"
# Issuers that moved to a new SEC registrant (e.g. a holding-company reorganisation): ticker -> earlier CIKs whose
# filings are merged in, so the history before the move is kept. The first filing of each period still wins.
PREDECESSORS = {"XOM": [34088]}   # Exxon Mobil Corp, before ExxonMobil Holdings Corp (2026)


def merged(docs: list[dict]) -> dict:
    """One companyfacts document from several registrants of the same issuer (oldest first)."""
    facts: dict = {}
    for d in docs:
        for taxonomy, concepts in d.get("facts", {}).items():
            for concept, body in concepts.items():
                for unit, rows in body.get("units", {}).items():
                    facts.setdefault(taxonomy, {}).setdefault(concept, {"units": {}})["units"].setdefault(unit, []).extend(rows)
    return {**docs[-1], "facts": facts}


def _facts(doc: dict, concept: str, unit: str = "USD") -> list[dict]:
    for taxonomy in TAXONOMIES:
        units = doc.get("facts", {}).get(taxonomy, {}).get(concept, {}).get("units", {})
        if unit in units:
            return units[unit]
    return []


def currency_of(doc: dict) -> str:
    """The reporting currency: the currency unit most used by the income, revenue and equity facts."""
    counts: collections.Counter = collections.Counter()
    for key in ("net_income", "revenue", "equity"):
        for concept in CONCEPTS[key]:
            for taxonomy in TAXONOMIES:
                for unit, rows in doc.get("facts", {}).get(taxonomy, {}).get(concept, {}).get("units", {}).items():
                    if len(unit) == 3 and unit.isalpha() and unit.isupper():
                        counts[unit] += len(rows)
    return counts.most_common(1)[0][0] if counts else "USD"


def _days(a: str, b: str) -> int:
    return (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days


def quarterly(doc: dict, key: str, unit: str = "USD") -> list[tuple[str, str, float]]:
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
        for f in _facts(doc, concept, unit):
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


def instants(doc: dict, key: str, unit: str = "USD") -> list[tuple[str, str, float]]:
    out: dict[str, tuple[str, str, float]] = {}
    for concept in CONCEPTS[key]:
        mine: dict[str, tuple[str, str, float]] = {}
        for f in _facts(doc, concept, unit):
            if "start" in f or not f.get("filed") or f.get("val") is None:
                continue
            cur = mine.get(f["end"])
            if cur is None or f["filed"] < cur[0]:
                mine[f["end"]] = (f["filed"], f["end"], float(f["val"]))
        for k, v in mine.items():
            out.setdefault(k, v)
    return sorted(out.values(), key=lambda q: q[1])


def _period_facts(doc: dict, key: str, unit: str, lo: int, hi: int) -> dict[str, tuple[str, float, str]]:
    """{period_end: (filed, value, start)} for facts spanning lo..hi days; first filing wins, then concept priority."""
    best: dict[str, tuple[str, float, str]] = {}
    for concept in CONCEPTS[key]:
        mine: dict[str, tuple[str, float, str]] = {}
        for f in _facts(doc, concept, unit):
            if "start" in f and f.get("filed") and f.get("val") is not None and lo <= _days(f["start"], f["end"]) <= hi:
                cur = mine.get(f["end"])
                if cur is None or f["filed"] < cur[0]:
                    mine[f["end"]] = (f["filed"], float(f["val"]), f["start"])
        for k, v in mine.items():
            best.setdefault(k, v)
    return best


def _near(table: dict, day: str, tolerance: int):
    hits = [(abs(_days(k, day)), k) for k in table if abs(_days(k, day)) <= tolerance]
    return table[min(hits)[1]] if hits else None


def yearly(doc: dict, key: str, unit: str = "USD") -> list[tuple[str, str, float]]:
    """(available_from, period_end, twelve-month value) from fiscal-year facts, and from first halves rolled forward
    (H1 + previous FY - previous H1). Most 20-F / 40-F filers publish no quarters."""
    fy = _period_facts(doc, key, unit, 350, 380)
    half = _period_facts(doc, key, unit, 170, 190)
    out = {e: (f, e, v) for e, (f, v, _start) in fy.items()}
    for e, (f1, v1, s1) in half.items():
        prev_fy = _near(fy, (dt.date.fromisoformat(s1) - dt.timedelta(days=1)).isoformat(), 4)   # H1 starts the fiscal year
        prev_half = _near(half, (dt.date.fromisoformat(e) - dt.timedelta(days=365)).isoformat(), 7)
        if prev_fy and prev_half and e not in out:
            out[e] = (max(f1, prev_fy[0], prev_half[0]), e, v1 + prev_fy[1] - prev_half[1])
    return sorted(out.values(), key=lambda r: r[1])


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
    return _split_basis(sorted(rows.values(), key=lambda r: r[1]))


def _split_basis(out: list) -> list[tuple[str, str, float]]:
    """Put every report of one share series on its latest split basis, from jumps that look like splits (used when
    the price data has no split record)."""
    out = sorted((tuple(r) for r in out), key=lambda r: r[1])
    factor, adjusted = 1.0, []
    for i in range(len(out) - 1, -1, -1):
        filed, end, val = out[i]
        if i < len(out) - 1:
            ratio = out[i + 1][2] / val if val else 1.0
            for n in (2, 3, 4, 5, 8, 10, 15, 20, 25, 40, 50, 80, 100):
                if abs(ratio / n - 1) < 0.06:
                    factor *= n
                    break
                if abs(ratio * n - 1) < 0.06:
                    factor /= n
                    break
        adjusted.append((filed, end, val * factor))
    return sorted(adjusted, key=lambda r: r[1])


MAX_AGE_DAYS = 400
FX_MAX_AGE_DAYS = 10   # an exchange rate older than this is not used


def _asof(series: list[tuple[str, str, float]], index: pd.DatetimeIndex, value=lambda rows, i: rows[i][2],
          max_age: int = MAX_AGE_DAYS) -> np.ndarray:
    """Value per session: from the session after the filing date until a newer filing (or MAX_AGE_DAYS), NaN otherwise."""
    out = np.full(len(index), np.nan)
    days = index.values.astype("datetime64[D]")
    for i, (filed, _end, _v) in enumerate(series):
        v = value(series, i)
        if v is None or not math.isfinite(v):
            continue
        start = np.searchsorted(days, np.datetime64(filed) + np.timedelta64(1, "D"))
        stop = np.searchsorted(days, np.datetime64(filed) + np.timedelta64(max_age, "D"))
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


DIGEST_VERSION = 2


def _evaluated(rows, value) -> list[list]:
    out = []
    for i in range(len(rows)):
        v = value(rows, i)
        if v is not None and math.isfinite(v):
            out.append([rows[i][0], rows[i][1], float(v)])
    return out


def ttm_rows(doc: dict, key: str, unit: str = "USD") -> list[list]:
    """Twelve-month values: four consecutive quarters where filed, else fiscal years and rolled half-years."""
    rows = _evaluated(*_ttm(quarterly(doc, key, unit)))
    ends = [r[1] for r in rows]
    rows += [list(r) for r in yearly(doc, key, unit) if not any(abs(_days(e, r[1])) <= 20 for e in ends)]
    return sorted(rows, key=lambda r: r[1])


def _growth(ttm: list[list]) -> list[list]:
    """Twelve-month value / the twelve-month value a year earlier - 1, published once both are."""
    out = []
    for f, e, v in ttm:
        prev = next((r for r in ttm if abs(_days(r[1], e) - 365) <= 20), None)
        if prev and prev[2] > 0:
            out.append([max(f, prev[0]), e, v / prev[2] - 1])
    return out


def share_sources(doc: dict) -> dict[str, list[list]]:
    facts, out = doc.get("facts", {}), {}
    for name, concepts in SHARE_SOURCES.items():
        found: dict[str, list] = {}
        for taxonomy, concept in concepts:
            mine: dict[str, list] = {}
            for f in facts.get(taxonomy, {}).get(concept, {}).get("units", {}).get("shares", []):
                if f.get("filed") and f.get("val") and ("start" not in f or 80 <= _days(f["start"], f["end"]) <= 380):
                    cur = mine.get(f["end"])
                    if cur is None or f["filed"] < cur[0]:
                        mine[f["end"]] = [f["filed"], f["end"], float(f["val"])]
            for k, v in mine.items():
                found.setdefault(k, v)
        out[name] = sorted(found.values(), key=lambda r: r[1])
    return out


def implied_shares(doc: dict, unit: str = "USD") -> list[list]:
    """Diluted share count implied by a period's net income / diluted EPS (last resort when no count is tagged)."""
    def periods(key, u):
        for concept in CONCEPTS[key]:
            table: dict = {}
            for f in _facts(doc, concept, u):
                if "start" in f and f.get("filed") and f.get("val"):
                    k = (f["start"], f["end"])
                    if k not in table or f["filed"] < table[k][0]:
                        table[k] = (f["filed"], float(f["val"]))
            if table:
                return table
        return {}
    income, eps = periods("net_income", unit), periods("eps_diluted", unit + "/shares")
    rows: dict[str, list] = {}
    for k, (f1, n) in income.items():
        if k in eps and eps[k][1] != 0 and n / eps[k][1] > 0:
            filed = max(f1, eps[k][0])
            if k[1] not in rows or filed < rows[k[1]][0]:
                rows[k[1]] = [filed, k[1], n / eps[k][1]]
    return sorted(rows.values(), key=lambda r: r[1])


def digest(doc: dict) -> dict:
    """Dated (available_from, period_end, value) series of one company, in its reporting currency, ready for
    ``ticker_panel``. Depends only on the filings, never on prices or exchange rates, so it is computed once per release."""
    unit = currency_of(doc)
    revenue = ttm_rows(doc, "revenue", unit)
    return {"version": DIGEST_VERSION, "currency": unit, "shares": {**share_sources(doc), "implied": implied_shares(doc, unit)},
            "flows": {k: revenue if k == "revenue" else ttm_rows(doc, k, unit) for k in FLOWS},
            "revenue_growth": _growth(revenue),
            "instants": {k: [list(r) for r in instants(doc, k, unit)] for k in ("equity", "debt", "cash")}}


def _split_factor(end: str, splits: list) -> float:
    return math.prod(r for day, r in splits if day > end)


def _shares_per_day(sources: dict, idx: pd.DatetimeIndex, splits: list | None) -> np.ndarray:
    """One share count per session, on today's split basis (the basis of split-adjusted closes).

    ``splits`` [(date, ratio)] from the price data puts each report on today's basis, including splits after the last
    report; without it, jumps in a series that look like splits are used. Each day: the cover-page count, else the
    balance-sheet count; the as-converted diluted count when it is 1.4x to 20x that (other share classes) or when
    neither is fresh; the count implied by income / EPS when nothing else is, or when only the diluted count is there
    and it is off from the implied one by 50x or more (a filing that tagged thousands as shares)."""
    def series(kind):
        rows = sources.get(kind, [])
        if splits is None:
            return _asof(_split_basis(rows), idx)
        # The cover-page count is the actual count on its date: later splits apply. Statement counts (balance sheet,
        # weighted diluted, EPS) are restated for a split between period end and filing, so only splits after the
        # filing date apply to them.
        return _asof([(f, e, v * _split_factor(e if kind == "cover" else f, splits)) for f, e, v in rows], idx)
    cover, balance, diluted, implied = (series(k) for k in ("cover", "balance", "diluted", "implied"))
    with np.errstate(invalid="ignore", divide="ignore"):
        primary = np.where(np.isfinite(cover), cover, balance)
        use_diluted = np.isfinite(diluted) & (~np.isfinite(primary) | ((diluted > 1.4 * primary) & (diluted < 20 * primary)))
        sh = np.where(use_diluted, diluted, primary)
        off = ~np.isfinite(primary) & np.isfinite(sh) & np.isfinite(implied) & ((sh > 50 * implied) | (implied > 50 * sh))
        sh = np.where(off | ~(sh > 0), implied, sh)
    return np.where(sh > 0, sh, np.nan)


def ticker_panel(doc: dict, close: pd.Series, fx: list | None = None, splits: list | None = None,
                 adr: float = 1.0) -> dict[str, np.ndarray]:
    """Signals per session for one company; ``doc`` is a digest (or raw companyfacts, digested here).

    ``fx`` [(date, date, USD per unit)] converts a non-USD reporting currency (each day at the previous session's
    rate); without it such a company gets no money-based values. ``adr`` is ordinary shares per listed share."""
    d = doc if doc.get("version") == DIGEST_VERSION else digest(doc)
    idx = close.index
    mcap = close.to_numpy(dtype=float) * _shares_per_day(d["shares"], idx, splits) / adr
    usd = np.ones(len(idx)) if d["currency"] == "USD" else _asof(fx, idx, max_age=FX_MAX_AGE_DAYS) if fx else np.full(len(idx), np.nan)
    flows = {k: _asof(d["flows"][k], idx) for k in FLOWS}
    equity, debt, cash = (_asof(d["instants"][k], idx) for k in ("equity", "debt", "cash"))
    dividends = np.where(np.isfinite(flows["dividends"]), flows["dividends"], np.where(np.isfinite(flows["net_income"]), 0.0, np.nan))

    def none_if_never(arr, rows):
        """A concept the company never tagged counts as zero (no debt, no capex); a gap in one it tags is unknown."""
        return arr if rows else np.where(np.isfinite(arr), arr, 0.0)
    debt = none_if_never(debt, d["instants"]["debt"])
    cash = none_if_never(cash, d["instants"]["cash"])
    capex = none_if_never(flows["capex"], d["flows"]["capex"])
    dna = none_if_never(flows["dna"], d["flows"]["dna"])
    with np.errstate(invalid="ignore", divide="ignore"):
        valid = mcap > 0
        ev = mcap + (debt - cash) * usd
        ebitda = flows["operating_income"] + dna
        return {
            "earnings_yield": np.where(valid, flows["net_income"] * usd / mcap, np.nan),
            "book_to_price": np.where(valid, equity * usd / mcap, np.nan),
            "fcf_yield": np.where(valid, (flows["ocf"] - capex) * usd / mcap, np.nan),
            "roe": np.where(equity > 0, flows["net_income"] / equity, np.nan),
            "debt_to_equity": np.where(equity > 0, debt / equity, np.nan),
            "revenue_growth": _asof(d["revenue_growth"], idx),
            "dividend_yield": np.where(valid, dividends * usd / mcap, np.nan),
            "ebitda_yield": np.where(valid & (ev > 0), ebitda * usd / ev, np.nan),
        }


# SIC code ranges -> broad sectors (an approximation of GICS for peer comparison; first match wins).
SIC_SECTORS = [
    ((1300, 1399), "energy"), ((2900, 2999), "energy"), ((4922, 4922), "energy"), ((4950, 4959), "industrials"),
    ((4900, 4999), "utilities"), ((6500, 6553), "real_estate"), ((6798, 6798), "real_estate"), ((6324, 6324), "health_care"),
    ((6199, 6199), "digital_assets"), ((6000, 6799), "financials"), ((3559, 3559), "technology"),
    ((3020, 3021), "consumer_discretionary"), ((3000, 3099), "materials"), ((3810, 3812), "industrials"),
    ((5330, 5331), "consumer_staples"), ((5399, 5399), "consumer_staples"), ((2830, 2836), "health_care"), ((3840, 3851), "health_care"),
    ((8000, 8099), "health_care"), ((3570, 3579), "technology"), ((3600, 3699), "technology"), ((7370, 7379), "technology"),
    ((3820, 3829), "technology"), ((4800, 4899), "communication"), ((2710, 2799), "communication"), ((7800, 7849), "communication"),
    ((2000, 2199), "consumer_staples"), ((2840, 2844), "consumer_staples"), ((5400, 5499), "consumer_staples"),
    ((5910, 5912), "consumer_staples"), ((2300, 2399), "consumer_discretionary"), ((2500, 2599), "consumer_discretionary"),
    ((3711, 3716), "consumer_discretionary"), ((3940, 3949), "consumer_discretionary"), ((5200, 5999), "consumer_discretionary"),
    ((7000, 7099), "consumer_discretionary"), ((7900, 7999), "consumer_discretionary"), ((1000, 1499), "materials"),
    ((2600, 2699), "materials"), ((2800, 2899), "materials"), ((3300, 3399), "materials"), ((1500, 1799), "industrials"),
    ((3400, 3599), "industrials"), ((3700, 3799), "industrials"), ((4000, 4799), "industrials"), ((5000, 5199), "industrials"),
    ((7300, 7399), "industrials"), ((8700, 8799), "industrials"),
]


# Issuers whose SIC code is a catch-all (7389 business services, 7340, 7320, 6199 finance services) or misleading
# for peer comparison; keyed by ticker, applied before the SIC ranges.
SECTOR_OVERRIDES = {"V": "financials", "MA": "financials", "PYPL": "financials", "SPGI": "financials", "AXP": "financials",
                    "SOFI": "financials", "ACN": "technology", "BABA": "consumer_discretionary", "PDD": "consumer_discretionary",
                    "MELI": "consumer_discretionary", "DASH": "consumer_discretionary", "TCOM": "consumer_discretionary",
                    "ABNB": "consumer_discretionary", "UBER": "industrials", "GRAB": "industrials"}


def sector_of(sic, ticker: str | None = None) -> str | None:
    if ticker in SECTOR_OVERRIDES:
        return SECTOR_OVERRIDES[ticker]
    try:
        code = int(sic)
    except (TypeError, ValueError):
        return None
    return next((name for (lo, hi), name in SIC_SECTORS if lo <= code <= hi), None)   # no peer group


def attach(prices: pd.DataFrame, closes: pd.DataFrame, docs: dict[str, dict], companies: set[str] | None = None,
           sectors: dict[str, str] | None = None, fx: dict[str, list] | None = None,
           splits: dict[str, list] | None = None) -> pd.DataFrame:
    """Price frame plus "<TICKER>::<signal>" columns (NaN where unknown) for ``companies``. ``closes`` are split-adjusted
    closes. ``docs`` may include sector peers that are not researched: they only feed the sector medians.
    ``companies`` limits value signals to operating companies (common stock / ADRs): a gold trust has "net income"
    but no earnings yield in any useful sense."""
    cols, panels = {}, {}
    wanted = set(docs) if companies is None else companies
    for t, doc in docs.items():
        if t in closes.columns:
            d = doc if doc.get("version") == DIGEST_VERSION else digest(doc)
            # An ADS can change its ratio without an ordinary-share split (and the reverse), so depositary listings put
            # their ordinary counts on one basis from the counts themselves rather than from the ADS price splits.
            panels[t] = ticker_panel(d, closes[t].reindex(prices.index), fx=(fx or {}).get(d["currency"]),
                                     splits=None if t in ADR_SHARES else (splits or {}).get(t), adr=ADR_SHARES.get(t, 1.0))
    for t in wanted & set(panels):
        for s, arr in panels[t].items():
            cols[f"{t}::{s}"] = arr
    # Sector-relative value: the company's value minus the median of its sector peers on the same day (same
    # point-in-time inputs, so no look-ahead). Needs MIN_SECTOR_PEERS companies with a value that day.
    for rel, base in SECTOR_RELATIVE.items():
        groups: dict[str, list[str]] = {}
        for t in panels:
            if sectors and sectors.get(t):
                groups.setdefault(sectors[t], []).append(t)
        for peers in groups.values():
            mat = np.column_stack([panels[t][base] for t in peers])
            count = np.isfinite(mat).sum(axis=1)
            with np.errstate(all="ignore"), warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)          # days on which no peer has a value
                med = np.where(count >= MIN_SECTOR_PEERS, np.nanmedian(np.where(np.isfinite(mat), mat, np.nan), axis=1), np.nan)
            for j, t in enumerate(peers):
                if t in wanted:
                    cols[f"{t}::{rel}"] = mat[:, j] - med
    return pd.concat([prices, pd.DataFrame(cols, index=prices.index)], axis=1) if cols else prices


# ------------------------------------------------------------------ release (fetched once, content-addressed)
def _object(root: Path, h: str, suffix: str) -> bytes:
    raw = gzip.decompress((root / "objects" / f"{h}{suffix}").read_bytes())
    if hashlib.sha256(raw).hexdigest() != h:
        raise ValueError("WAITING_DATA: Fundamentals object hash mismatch.")
    return raw


def _atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _put(root: Path, raw: bytes, suffix: str) -> str:
    h = hashlib.sha256(raw).hexdigest()
    path = root / "objects" / f"{h}{suffix}"
    try:
        _object(root, h, suffix)   # present and intact: keep it
    except Exception:              # missing, truncated or corrupt: write it again
        _atomic(path, gzip.compress(raw))
    return h


def _digest_object(root: Path, raw: bytes, earlier: list[bytes] = ()) -> tuple[str, str]:
    """(digest object hash, reporting currency) of one company."""
    d = digest(merged([json.loads(r) for r in (*earlier, raw)]))
    return _put(root, json.dumps(d, sort_keys=True, separators=(",", ":")).encode(), ".digest.json.gz"), d["currency"]


def _write(root: Path, rel: dict) -> dict:
    """Readers always see a whole release: the file is replaced in one step."""
    rel.pop("release_id", None)
    rel["release_id"] = hashlib.sha256(json.dumps(rel, sort_keys=True).encode()).hexdigest()
    _atomic(root / "release.json", json.dumps(rel, indent=1, sort_keys=True).encode())
    return rel


def load_release(root) -> tuple[dict[str, dict], dict]:
    """Digest per ticker from ``<root>/fundamentals/release.json`` (hash-checked), plus the exchange rates its
    non-USD reporters need. Missing release -> no fundamentals."""
    root = Path(root) / "fundamentals"
    path = root / "release.json"
    if not path.exists():
        return {}, {"available": False}
    rel = json.loads(path.read_text())
    if rel.get("digest_version") != DIGEST_VERSION:
        raise ValueError("WAITING_DATA: Fundamentals release needs new digests (python -m xtxc_agent.research.fundamentals --derive).")
    docs = {t: json.loads(_object(root, row["digest"], ".digest.json.gz")) for t, row in rel["tickers"].items()}
    fx = {c: json.loads(_object(root, row["object"], ".fx.json.gz")) for c, row in rel.get("fx", {}).items()}
    sectors = {t: row["sector"] for t, row in rel["tickers"].items() if row.get("sector")}
    return docs, {"available": True, "releaseId": rel["release_id"], "fetchedAt": rel["fetched_at"], "source": rel["source"],
                  "tickers": sorted(docs), "sectors": sectors, "fx": fx}


def split_events(root, tickers) -> dict[str, list]:
    """[(date, ratio)] stock splits per ticker from the price data (``<root>/prices/<TICKER>.json`` events). A ticker
    without a price file is left out, so its share counts fall back to the split heuristic."""
    out = {}
    for t in tickers:
        try:
            events = json.loads((Path(root) / "prices" / f"{t}.json").read_text()).get("events", [])
        except (OSError, ValueError):
            continue
        rows = []
        for e in events:
            if e.get("type") == "split":
                a, _, b = str(e.get("ratio", "")).partition(":")
                try:
                    r = float(a) / float(b)
                except (ValueError, ZeroDivisionError):
                    continue
                if r > 0 and e.get("date"):
                    rows.append((e["date"], r))
        out[t] = rows
    return out


def _http(fetcher=None):
    import http.client
    import urllib.error
    import urllib.request

    def get(url):
        if fetcher:
            return fetcher(url)
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    return r.read()
            except urllib.error.HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                    raise
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead):
                if attempt == 2:
                    raise
            time.sleep(2 * (attempt + 1))
    return get


def fetch_fx(currencies, get) -> dict[str, list]:
    """[(date, date, USD per unit)] per currency from FRED; a rate is used from the session after its date."""
    out = {}
    for c in sorted(set(currencies) - {"USD"}):
        if c not in FX_SERIES:
            continue
        series, per_usd = FX_SERIES[c]
        rows = []
        for line in get(FRED_CSV.format(series)).decode().splitlines()[1:]:
            day, _, value = line.partition(",")
            try:
                x = float(value)
            except ValueError:
                continue
            if x > 0 and len(day) == 10 and day[4] == "-" and day[7] == "-":
                rows.append([day, day, 1 / x if per_usd else x])
        if not rows:
            raise ValueError(f"FRED {series}: no rates in the response")
        out[c] = rows
    return out


def _store_fx(root: Path, rel: dict, get) -> None:
    currencies = {row.get("currency", "USD") for row in rel["tickers"].values()}
    try:
        rates = fetch_fx(currencies, get)
    except Exception as exc:   # keep the previous rates; a stale rate expires after MAX_AGE_DAYS
        rel["fx_error"] = str(exc)[:200]
        return
    rel.pop("fx_error", None)
    fx = rel.setdefault("fx", {})
    for c, rows in rates.items():
        fx[c] = {"series": FX_SERIES[c][0], "through": rows[-1][0],
                 "object": _put(root, json.dumps(rows, separators=(",", ":")).encode(), ".fx.json.gz")}


def derive_release(root) -> dict:
    """Recompute every digest, currency and sector from the stored raw companyfacts and SIC codes (after a change to
    that code); no network."""
    root = Path(root) / "fundamentals"
    rel = json.loads((root / "release.json").read_text())
    for ticker, row in rel["tickers"].items():
        earlier = [_object(root, e["object"], ".json.gz") for e in row.get("predecessors", [])]
        row["digest"], row["currency"] = _digest_object(root, _object(root, row["object"], ".json.gz"), earlier)
        row["sector"] = sector_of(row.get("sic"), ticker)
    rel["digest_version"] = DIGEST_VERSION
    return _write(root, rel)


def _company(t: str, cik: int, get, root: Path, submissions: dict) -> dict | None:
    """One company's row: raw companyfacts (+ predecessors) stored, digest computed. None when SEC has no facts."""
    try:
        raw = get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json")
    except Exception as exc:   # e.g. 404 for trusts/ETFs without XBRL company facts
        if getattr(exc, "code", None) == 404:
            return None
        raise
    time.sleep(0.15)               # SEC fair access: well under 10 requests per second
    earlier = []
    for old in PREDECESSORS.get(t, []):
        earlier.append(get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{old:010d}.json"))
        time.sleep(0.15)
    doc = json.loads(raw)
    sic = submissions.get("sic") or None
    digest_hash, currency = _digest_object(root, raw, earlier)
    return {"cik": cik, "object": _put(root, raw, ".json.gz"), "digest": digest_hash, "currency": currency,
            **({"predecessors": [{"cik": c, "object": _put(root, r, ".json.gz")} for c, r in zip(PREDECESSORS[t], earlier)]}
               if earlier else {}),
            "entity": doc.get("entityName"), "us_gaap": bool(doc.get("facts", {}).get("us-gaap")),
            "sic": sic, "sector": sector_of(sic, t), "last_filing": _last_filing(submissions), "facts_through": _facts_through(doc)}


REPORT_FORMS = {"10-K", "10-Q", "20-F", "40-F", "6-K", "10-K/A", "10-Q/A", "20-F/A", "40-F/A", "6-K/A", "10-KT", "10-QT"}


def _last_filing(submissions: dict) -> str | None:
    """Date of the newest periodic report with XBRL data (cover-page-only and insider filings do not count)."""
    recent = submissions.get("filings", {}).get("recent", {})
    dates, forms, xbrl = recent.get("filingDate", []), recent.get("form", []), recent.get("isXBRL", [])
    hits = [d for i, d in enumerate(dates) if i < len(forms) and forms[i] in REPORT_FORMS and (i >= len(xbrl) or xbrl[i])]
    return max(hits) if hits else None


def _facts_through(doc: dict) -> str | None:
    """The newest filing date among a companyfacts document's facts: what SEC has actually processed."""
    return max((f["filed"] for tax in doc.get("facts", {}).values() for c in tax.values()
                for rows in c.get("units", {}).values() for f in rows if f.get("filed")), default=None)


def _submissions(cik: int, get) -> dict:
    out = json.loads(get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json"))
    time.sleep(0.15)
    return out


def fetch_release(tickers: list[str], root, fetcher=None) -> dict:
    """Download companyfacts (and the SIC code) for tickers that have a SEC CIK, plus exchange rates for non-USD
    reporters, and write a content-addressed release."""
    get = _http(fetcher)
    root = Path(root) / "fundamentals"
    (root / "objects").mkdir(parents=True, exist_ok=True)
    ciks = {v["ticker"].upper(): int(v["cik_str"]) for v in json.loads(get("https://www.sec.gov/files/company_tickers.json")).values()}
    rows, missing, errors = {}, [], {}
    for t in tickers:
        cik = ciks.get(t) or ciks.get(t.replace(".", "-"))
        try:
            row = _company(t, cik, get, root, _submissions(cik, get)) if cik else None
        except Exception as exc:   # one company never stops the others
            errors[t] = f"{type(exc).__name__}: {exc}"[:160]
            continue
        if row:
            rows[t] = row
        else:
            missing.append(t)
    rel = {"schema": "xtxc.fundamentals-release/v1", "source": "SEC EDGAR XBRL companyfacts + submissions (SIC); FRED H.10 rates",
           "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(), "digest_version": DIGEST_VERSION,
           "tickers": rows, "missing": missing, **({"errors": errors} if errors else {})}
    _store_fx(root, rel, get)
    return _write(root, rel)


def refresh_release(root, fetcher=None) -> dict:
    """Bring a release up to date: one submissions request per company, and companyfacts only for companies with a
    filing newer than the stored one; exchange rates are refreshed. The old release stays in place until the new one
    is complete."""
    get = _http(fetcher)
    root = Path(root) / "fundamentals"
    rel = json.loads((root / "release.json").read_text())
    if rel.get("digest_version") != DIGEST_VERSION:
        rel = derive_release(root.parent)
    updated, errors = [], {}
    for t, row in sorted(rel["tickers"].items()):
        try:
            subs = _submissions(row["cik"], get)
            latest = _last_filing(subs)
            # Download again only for a periodic report newer than the facts SEC had processed at the last download.
            # If companyfacts lags the filing, the next run tries again.
            if row.get("facts_through") and (latest is None or latest <= row["facts_through"]):
                sic = subs.get("sic") or row.get("sic")
                row.update(sic=sic, sector=sector_of(sic, t))
                continue
            fresh = _company(t, row["cik"], get, root, subs)
        except Exception as exc:   # keep the previous row; one company never stops the others
            errors[t] = f"{type(exc).__name__}: {exc}"[:160]
            continue
        if fresh and fresh["object"] != row.get("object"):
            updated.append(t)
        if fresh:
            rel["tickers"][t] = fresh
    rel["fetched_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    rel["updated"] = updated
    rel["errors"] = errors
    _store_fx(root, rel, get)
    return _write(root, rel)


if __name__ == "__main__":  # pragma: no cover - operator entry point
    import sys
    if sys.argv[1] == "--derive":
        r = derive_release(sys.argv[2])
    elif sys.argv[1] == "--refresh":
        r = refresh_release(sys.argv[2])
    else:
        r = fetch_release(sys.argv[2].split(","), sys.argv[1])
    print(json.dumps({"release": r["release_id"], "tickers": len(r["tickers"]), "missing": r["missing"],
                      "updated": r.get("updated"), "errors": r.get("errors"), "fx": sorted(r.get("fx", {})), "fx_error": r.get("fx_error")}))
