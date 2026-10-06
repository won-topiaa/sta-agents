import json
import re

from xtxc_agent.research import universe as u

# The 50 tickers listed in the workbench plan (section 3.2).  Used only as an expectation here;
# the code itself reads report.json.
PLAN_TICKERS = set("""AAPL AMBR AMD AMZN AVGO BMNR BRK.B CMCSA COIN CRCL CVX DFDV F GLD GME GOOGL HOOD IBM INTC JPM
KO LLY MCD META MRNA MRVL MSFT MSTR MU NFLX NVDA NVO ORCL PEP PG PLTR QQQ SLV SPCX SPY STRC TQQQ TSLA TSM
UBER UNH V VIDA WMT XOM""".split())


def _report_tickers():
    report = json.loads(u.catalog_report_path().read_text())
    matched = [p for p in report["products"]
               if any(pl.get("status") == "PAIR_IDENTITY_MATCH" for pl in p.get("pools") or [])]
    return report, matched


def test_universe_has_50_unique_tickers_from_catalog():
    insts = u.load_universe()
    tickers = [i.ticker for i in insts]
    assert len(tickers) == 50
    assert len(set(tickers)) == 50
    report, matched = _report_tickers()
    assert report["productsWithMatchedPool"] == 54
    assert len(matched) == 54
    assert set(tickers) == {p["instrument"] for p in matched}
    assert set(tickers) == PLAN_TICKERS


def test_products_carry_catalog_fields():
    insts = u.load_universe()
    products = [p for i in insts for p in i.products]
    assert len(products) == 54
    _, matched = _report_tickers()
    by_mint = {p["mint"]: p for p in matched}
    for inst in insts:
        for p in inst.products:
            assert set(p) == {"mint", "issuer", "symbol", "decimals", "token_program"}
            src = by_mint[p["mint"]]
            assert src["instrument"] == inst.ticker
            assert p["decimals"] == src["decimals"]
            assert p["token_program"] == src["mintOwner"]
            assert p["issuer"] in ("xStocks", "Ondo")
            assert p["symbol"] and p["symbol"].startswith(inst.ticker)
            assert p["symbol"].endswith("x" if p["issuer"] == "xStocks" else "on")
    multi = {i.ticker for i in insts if len(i.products) > 1}
    assert multi == {"AAPL", "AMD", "GOOGL", "SPY"}


def test_names_sectors_kinds_are_curated_and_valid():
    insts = {i.ticker: i for i in u.load_universe()}
    for i in insts.values():
        assert i.name_ko and i.name_en
        assert i.sector in u.SECTORS and i.sector != "unknown"
        assert i.kind in u.KINDS
    assert insts["NVDA"].name_ko == "엔비디아"
    assert insts["TSM"].name_ko == "TSMC"
    assert insts["BRK.B"].name_ko == "버크셔 해서웨이 B"
    assert insts["QQQ"].name_ko == "나스닥100 ETF(QQQ)"
    assert insts["TQQQ"].kind == "leveraged_etf"
    assert insts["QQQ"].kind == "etf" and insts["SPY"].kind == "etf"
    assert insts["STRC"].kind == "preferred"
    assert {t for t, i in insts.items() if i.sector == "semiconductors"} == {
        "NVDA", "AMD", "AVGO", "TSM", "MU", "MRVL", "INTC"}


def test_kind_matches_yahoo_rule_or_is_explained():
    mapping = json.loads(u.MAPPING_FILE.read_text())["tickers"]
    for t, m in mapping.items():
        seed = u.derive_kind(m["yahoo_instrument_type"], m["yahoo_long_name"])
        assert m["kind_seed"] in (seed, "preferred")  # shortName also feeds the seed (STRC)
        if m["kind"] != m["kind_seed"]:
            assert m.get("notes"), f"{t}: kind override without a note"


def test_derive_kind_rules():
    assert u.derive_kind("ETF", "ProShares UltraPro QQQ") == "leveraged_etf"
    assert u.derive_kind("ETF", "Invesco QQQ Trust") == "etf"
    assert u.derive_kind("EQUITY", "Strategy Inc", "Strategy Inc - Variable Rate Se") == "preferred"
    assert u.derive_kind("EQUITY", "NVIDIA Corporation") == "common"
    assert u.derive_kind(None, "x") == "other"


def test_universe_version_is_stable_hash():
    v1, v2 = u.universe_version(), u.universe_version()
    assert v1 == v2 and re.fullmatch(r"[0-9a-f]{64}", v1)


def test_instrument_dict_is_json_ready():
    d = u.instrument_dict(u.get_instrument("nvda"))
    assert json.loads(json.dumps(d, ensure_ascii=False))["ticker"] == "NVDA"
    assert d["products"][0]["symbol"] == "NVDAx"


def test_universe_objects_are_not_shared():
    a = u.load_universe()
    a[0].products[0]["mint"] = "tampered"
    assert u.load_universe()[0].products[0]["mint"] != "tampered"
