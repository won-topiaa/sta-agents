"""What XTXC can trade: the research universe.

Source of truth for *which* tickers exist is the on-chain catalog report
``evidence/secondary-execution-20260928/catalog/report.json`` (override: ``XTXC_CATALOG_REPORT``).
A product is in the universe when it has at least one pool with status ``PAIR_IDENTITY_MATCH``
(54 products at the time of writing, deduplicating to 50 underlying tickers).  Nothing here
hard-codes the ticker list: a new matched product in the report shows up automatically, with
``kind="other"``/``sector="unknown"`` until it is curated.

Per product we carry ``{mint, issuer, symbol, decimals, token_program}``:

* ``mint``, ``decimals`` and ``token_program`` (the mint's owner program) come from report.json.
* ``issuer`` and ``symbol`` are not in report.json.  They come from ``token_products.json`` (next to
  this file), an extract keyed by mint that ``extract_token_products()`` builds from the stock catalog
  the discovery run used (``catalog-v2.json``, sha256 recorded) plus the issuer symbol bindings
  (xStocks) / quote manifest / presentation aliases (Ondo).  Every row records where its symbol
  came from.  A mint missing from the extract loads with ``issuer``/``symbol`` = None.

Korean names, sectors and kinds are curated in ``universe_map.json`` (provenance and open
questions are written in that file).  ``kind`` was derived from Yahoo chart metadata
(``instrumentType`` EQUITY/ETF) plus name evidence; see ``derive_kind``.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

__all__ = [
    "Instrument",
    "load_universe",
    "universe_version",
    "get_instrument",
    "instrument_dict",
    "derive_kind",
    "SECTORS",
    "KINDS",
]

_HERE = Path(__file__).resolve().parent
_LOCAL = _HERE.parents[2] / ".local"
DEFAULT_CATALOG_REPORT = _LOCAL / "catalog-report.json"
DEFAULT_STOCK_CATALOG_DIR = _LOCAL / "stock-catalog"
MAPPING_FILE = _HERE / "universe_map.json"
PRODUCTS_FILE = _HERE / "token_products.json"
MATCH_STATUS = "PAIR_IDENTITY_MATCH"

KINDS = ("common", "etf", "leveraged_etf", "preferred", "adr", "other")
SECTORS = (
    "semiconductors", "big_tech", "software_it", "telecom_media", "etf_index", "commodities_etf",
    "crypto_related", "financials", "healthcare", "consumer", "energy", "industrials", "other", "unknown",
)
ISSUER_BY_PRODUCT_PREFIX = {"catalog:xstocks:": "xStocks", "catalog:ondo:": "Ondo"}


@dataclass(frozen=True)
class Instrument:
    ticker: str
    name_ko: str
    name_en: str
    sector: str
    kind: str
    products: tuple[dict, ...]
    name_zh: str = ""            # Simplified Chinese display name
    name_short_en: str = ""      # short English display name ("Apple", not "Apple Inc.")


def catalog_report_path() -> Path:
    return Path(os.environ.get("XTXC_CATALOG_REPORT", str(DEFAULT_CATALOG_REPORT)))


def _file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _mtime_key(*paths: Path) -> tuple:
    return tuple((str(p), p.stat().st_mtime_ns if p.exists() else None) for p in paths)


def matched_products(report: dict) -> list[dict]:
    """Products of the catalog report with a pair-identity-matched pool, in report order."""
    out = []
    for p in report.get("products", []):
        pools = [pl for pl in (p.get("pools") or []) if pl.get("status") == MATCH_STATUS]
        if pools:
            out.append({**p, "pools": pools})
    return out


def derive_kind(instrument_type: str | None, *names: str | None) -> str:
    """Rule used to seed ``kind`` from Yahoo metadata + names (curation may refine to 'adr').

    ETF -> 'leveraged_etf' if a name says 3x/2x/UltraPro/Ultra/Leveraged, else 'etf'.
    EQUITY -> 'preferred' if a name says preferred / perpetual / 'variable rate' / ' PP ', else 'common'.
    Anything else (or missing) -> 'other'.
    """
    text = " ".join(n for n in names if n).lower()
    it = (instrument_type or "").upper()
    if it == "ETF":
        if re.search(r"\b[23]x\b|ultrapro|\bultra\b|leveraged", text):
            return "leveraged_etf"
        return "etf"
    if it == "EQUITY":
        if re.search(r"preferred|perpetual|variable rate|\bpp\b", text):
            return "preferred"
        return "common"
    return "other"


@lru_cache(maxsize=4)
def _load_cached(key: tuple) -> tuple[list[Instrument], str]:
    report_path = Path(key[0][0])
    report_bytes = report_path.read_bytes()
    report = json.loads(report_bytes)
    mapping_bytes = MAPPING_FILE.read_bytes()
    mapping = json.loads(mapping_bytes)["tickers"]
    products_bytes = PRODUCTS_FILE.read_bytes() if PRODUCTS_FILE.exists() else b"{}"
    extract = json.loads(products_bytes).get("products", {})

    by_ticker: dict[str, list[dict]] = {}
    for p in matched_products(report):
        ticker = p["instrument"].strip().upper()
        ex = extract.get(p["mint"], {})
        by_ticker.setdefault(ticker, []).append({
            "mint": p["mint"],
            "issuer": ex.get("issuer"),
            "symbol": ex.get("symbol"),
            "decimals": int(p["decimals"]),
            "token_program": p.get("mintOwner"),
        })
    instruments = []
    for ticker in sorted(by_ticker):
        m = mapping.get(ticker, {})
        instruments.append(Instrument(
            ticker=ticker,
            name_ko=m.get("name_ko") or ticker,
            name_en=m.get("name_en") or ticker,
            sector=m.get("sector") or "unknown",
            kind=m.get("kind") or "other",
            products=tuple(by_ticker[ticker]),
            name_zh=m.get("name_zh") or m.get("name_en") or ticker,
            name_short_en=m.get("name_short_en") or m.get("name_en") or ticker,
        ))
    h = hashlib.sha256()
    for label, data in (("report", report_bytes), ("mapping", mapping_bytes), ("products", products_bytes)):
        h.update(label.encode() + b"\0" + hashlib.sha256(data).digest())
    return instruments, h.hexdigest()


def load_universe() -> list[Instrument]:
    """All matched underlying tickers from the catalog report (sorted by ticker).

    Returns fresh objects (product dicts copied) so callers cannot mutate the cached universe.
    """
    instruments, _ = _load_cached(_mtime_key(catalog_report_path(), MAPPING_FILE, PRODUCTS_FILE))
    return [dataclasses.replace(i, products=tuple(dict(p) for p in i.products)) for i in instruments]


def universe_version() -> str:
    """sha256 over the hashes of the catalog report, the curated mapping and the product extract."""
    _, version = _load_cached(_mtime_key(catalog_report_path(), MAPPING_FILE, PRODUCTS_FILE))
    return version


def get_instrument(ticker: str) -> Instrument | None:
    t = ticker.strip().upper()
    for inst in load_universe():
        if inst.ticker == t:
            return inst
    return None


def instrument_dict(inst: Instrument) -> dict:
    """JSON-ready dict (products as a list)."""
    d = dataclasses.asdict(inst)
    d["products"] = [dict(p) for p in inst.products]
    return d


def mapping_notes() -> dict:
    """Curation notes (open questions / uncertainty) per ticker from universe_map.json."""
    mapping = json.loads(MAPPING_FILE.read_text())["tickers"]
    return {t: m["notes"] for t, m in mapping.items() if m.get("notes")}


# ---------------------------------------------------------------------------------------------
# dev tool: (re)build token_products.json from the catalog files.  Not used at request time.


def extract_token_products(catalog_dir: Path = DEFAULT_STOCK_CATALOG_DIR,
                           out: Path = PRODUCTS_FILE) -> dict:  # pragma: no cover - dev tool
    report_path = catalog_report_path()
    report = json.loads(report_path.read_text())
    mints = {p["mint"]: p["instrument"] for p in matched_products(report)}
    cat_path = catalog_dir / "catalog-v2.json"
    catalog = {p["address"]: p for p in json.loads(cat_path.read_text())["products"]
               if str(p.get("chain", "")).startswith("solana:")}
    bind_path = catalog_dir / "issuer-price-bindings.json"
    bindings = {b["address"]: b for b in json.loads(bind_path.read_text())["bindings"]}
    qm_path = catalog_dir / "quote-manifest.json"
    lanes = {ln["output_mint"]: ln for bank in json.loads(qm_path.read_text())["banks"] for ln in bank["lanes"]}
    pres_path = catalog_dir / "presentation-v1.json"
    aliases = {i["instrument"]: i.get("aliases", []) for i in json.loads(pres_path.read_text())["instruments"]}
    rows = {}
    for mint, ticker in mints.items():
        c = catalog.get(mint)
        issuer = None
        issuer_legal = None
        if c:
            issuer_legal = c.get("issuer")
            for prefix, brand in ISSUER_BY_PRODUCT_PREFIX.items():
                if c.get("productId", "").startswith(prefix):
                    issuer = brand
        symbol, symbol_source = None, None
        if mint in bindings:
            symbol, symbol_source = bindings[mint]["symbol"], "issuer-price-bindings (api.xstocks.fi)"
        elif mint in lanes:
            symbol, symbol_source = lanes[mint]["output_symbol"], "quote-manifest"
        elif issuer == "Ondo":
            cand = [a for a in aliases.get(ticker, []) if a == f"{ticker}on"]
            if cand:
                symbol, symbol_source = cand[0], "presentation-v1 alias (issuer Ondo)"
        rows[mint] = {
            "ticker": ticker,
            "issuer": issuer,
            "issuer_legal": issuer_legal,
            "catalog_name": c.get("name") if c else None,
            "catalog_product_id": c.get("productId") if c else None,
            "catalog_source_url": c.get("sourceUrl") if c else None,
            "symbol": symbol,
            "symbol_source": symbol_source,
        }
    doc = {
        "_provenance": {
            "purpose": "issuer/symbol per matched mint; report.json lacks them. Built by "
                       "xtxc_agent.research.universe.extract_token_products().",
            "catalog_report": {"path": str(report_path), "sha256": _file_sha256(report_path)},
            "stock_catalog": {"path": str(cat_path), "sha256": _file_sha256(cat_path)},
            "issuer_price_bindings": {"path": str(bind_path), "sha256": _file_sha256(bind_path)},
            "quote_manifest": {"path": str(qm_path), "sha256": _file_sha256(qm_path)},
            "presentation": {"path": str(pres_path), "sha256": _file_sha256(pres_path)},
            "issuer_rule": "brand from catalog productId prefix: catalog:xstocks: -> xStocks, catalog:ondo: -> Ondo",
        },
        "products": dict(sorted(rows.items(), key=lambda kv: (kv[1]["ticker"], kv[0]))),
    }
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    return doc
