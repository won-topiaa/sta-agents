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
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

SIGNALS = ("earnings_yield", "book_to_price", "fcf_yield", "roe", "debt_to_equity", "revenue_growth",
           "dividend_yield", "ebitda_yield", "earnings_yield_vs_sector", "book_to_price_vs_sector")
SECTOR_RELATIVE = {"earnings_yield_vs_sector": "earnings_yield", "book_to_price_vs_sector": "book_to_price"}
MIN_SECTOR_PEERS = 3
CONCEPTS = {
    "net_income": ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenuesNetOfInterestExpense"],
    "ocf": ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements"],
    "equity": ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    "debt": ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"],
    "dividends": ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock", "PaymentsOfOrdinaryDividends"],
    "operating_income": ["OperatingIncomeLoss"],
    "dna": ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet", "Depreciation"],
    "cash": ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
}
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


DIGEST_VERSION = 1


def digest(doc: dict) -> dict:
    """Dated (available_from, period_end, value) series of one company, ready for ``ticker_panel``. Depends only on
    the filings, never on prices, so it can be computed once per release."""
    def evaluated(rows, value):
        out = []
        for i in range(len(rows)):
            v = value(rows, i)
            if v is not None and math.isfinite(v):
                out.append([rows[i][0], rows[i][1], float(v)])
        return out
    flows = {k: evaluated(*_ttm(quarterly(doc, k))) for k in FLOWS}
    rev_rows = quarterly(doc, "revenue")

    def growth(series, i):
        if i < 7:
            return None
        now, before = rev_rows[i - 3:i + 1], rev_rows[i - 7:i - 3]
        if _days(before[0][1], now[-1][1]) > 660:
            return None
        base = sum(r[2] for r in before)
        return sum(r[2] for r in now) / base - 1 if base > 0 else None
    return {"version": DIGEST_VERSION, "shares": [list(r) for r in shares(doc)], "flows": flows,
            "revenue_growth": evaluated(_ttm(rev_rows)[0], growth),
            "instants": {k: [list(r) for r in instants(doc, k)] for k in ("equity", "debt", "cash")}}


def ticker_panel(doc: dict, close: pd.Series) -> dict[str, np.ndarray]:
    """Signals per session for one company; ``doc`` is a digest (or raw companyfacts, digested here)."""
    d = doc if doc.get("version") == DIGEST_VERSION else digest(doc)
    idx = close.index
    mcap = close.to_numpy(dtype=float) * _asof(d["shares"], idx)
    flows = {k: _asof(d["flows"][k], idx) for k in FLOWS}
    equity, debt, cash = (_asof(d["instants"][k], idx) for k in ("equity", "debt", "cash"))
    dividends = np.where(np.isfinite(flows["dividends"]), flows["dividends"], np.where(np.isfinite(flows["net_income"]), 0.0, np.nan))
    with np.errstate(invalid="ignore", divide="ignore"):
        valid = mcap > 0
        ev = mcap + np.nan_to_num(debt) - np.nan_to_num(cash)
        ebitda = flows["operating_income"] + np.nan_to_num(flows["dna"])
        return {
            "earnings_yield": np.where(valid, flows["net_income"] / mcap, np.nan),
            "book_to_price": np.where(valid, equity / mcap, np.nan),
            "fcf_yield": np.where(valid, (flows["ocf"] - np.nan_to_num(flows["capex"])) / mcap, np.nan),
            "roe": np.where(equity > 0, flows["net_income"] / equity, np.nan),
            "debt_to_equity": np.where(equity > 0, np.nan_to_num(debt) / equity, np.nan),
            "revenue_growth": _asof(d["revenue_growth"], idx),
            "dividend_yield": np.where(valid, dividends / mcap, np.nan),
            "ebitda_yield": np.where(valid & (ev > 0), ebitda / ev, np.nan),
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
           sectors: dict[str, str] | None = None) -> pd.DataFrame:
    """Price frame plus "<TICKER>::<signal>" columns (NaN where unknown) for ``companies``. ``closes`` are split-adjusted
    closes. ``docs`` may include sector peers that are not researched: they only feed the sector medians.
    ``companies`` limits value signals to operating companies (common stock / ADRs): a gold trust has "net income"
    but no earnings yield in any useful sense."""
    cols, panels = {}, {}
    wanted = set(docs) if companies is None else companies
    for t, doc in docs.items():
        if t in closes.columns:
            panels[t] = ticker_panel(doc, closes[t].reindex(prices.index))
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


def _put(root: Path, raw: bytes, suffix: str) -> str:
    h = hashlib.sha256(raw).hexdigest()
    (root / "objects" / f"{h}{suffix}").write_bytes(gzip.compress(raw))
    return h


def _digest_object(root: Path, raw: bytes, earlier: list[bytes] = ()) -> str:
    doc = merged([json.loads(r) for r in (*earlier, raw)])
    return _put(root, json.dumps(digest(doc), sort_keys=True, separators=(",", ":")).encode(), ".digest.json.gz")


def _write(root: Path, rel: dict) -> dict:
    rel.pop("release_id", None)
    rel["release_id"] = hashlib.sha256(json.dumps(rel, sort_keys=True).encode()).hexdigest()
    (root / "release.json").write_text(json.dumps(rel, indent=1, sort_keys=True))
    return rel


def load_release(root) -> tuple[dict[str, dict], dict]:
    """Digest per ticker from ``<root>/fundamentals/release.json`` (hash-checked). Missing release -> no fundamentals."""
    root = Path(root) / "fundamentals"
    path = root / "release.json"
    if not path.exists():
        return {}, {"available": False}
    rel = json.loads(path.read_text())
    if rel.get("digest_version") != DIGEST_VERSION:
        raise ValueError("WAITING_DATA: Fundamentals release needs new digests (python -m xtxc_agent.research.fundamentals --derive).")
    docs = {t: json.loads(_object(root, row["digest"], ".digest.json.gz")) for t, row in rel["tickers"].items()}
    sectors = {t: row["sector"] for t, row in rel["tickers"].items() if row.get("sector")}
    return docs, {"available": True, "releaseId": rel["release_id"], "fetchedAt": rel["fetched_at"], "source": rel["source"],
                  "tickers": sorted(docs), "sectors": sectors}


def derive_release(root) -> dict:
    """Recompute every digest and sector from the stored raw companyfacts and SIC codes (after a change to that
    code); no network."""
    root = Path(root) / "fundamentals"
    rel = json.loads((root / "release.json").read_text())
    for ticker, row in rel["tickers"].items():
        earlier = [_object(root, e["object"], ".json.gz") for e in row.get("predecessors", [])]
        row["digest"] = _digest_object(root, _object(root, row["object"], ".json.gz"), earlier)
        row["sector"] = sector_of(row.get("sic"), ticker)
    rel["digest_version"] = DIGEST_VERSION
    return _write(root, rel)


def fetch_release(tickers: list[str], root, fetcher=None) -> dict:
    """Download companyfacts (and the SIC code) for tickers that have a SEC CIK and write a content-addressed release."""
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
        sic = json.loads(get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json")).get("sic") or None
        time.sleep(0.15)
        earlier = []
        for old in PREDECESSORS.get(t, []):
            earlier.append(get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{old:010d}.json"))
            time.sleep(0.15)
        doc = json.loads(raw)
        rows[t] = {"cik": cik, "object": _put(root, raw, ".json.gz"), "digest": _digest_object(root, raw, earlier),
                   **({"predecessors": [{"cik": c, "object": _put(root, r, ".json.gz")} for c, r in zip(PREDECESSORS[t], earlier)]}
                      if earlier else {}),
                   "entity": doc.get("entityName"), "us_gaap": bool(doc.get("facts", {}).get("us-gaap")),
                   "sic": sic, "sector": sector_of(sic, t)}
    return _write(root, {"schema": "xtxc.fundamentals-release/v1", "source": "SEC EDGAR XBRL companyfacts + submissions (SIC)",
                         "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(), "digest_version": DIGEST_VERSION,
                         "tickers": rows, "missing": missing})


if __name__ == "__main__":  # pragma: no cover - operator entry point
    import sys
    if sys.argv[1] == "--derive":
        r = derive_release(sys.argv[2])
    else:
        r = fetch_release(sys.argv[2].split(","), sys.argv[1])
    print(json.dumps({"release": r["release_id"], "tickers": len(r["tickers"]), "missing": r["missing"]}))
