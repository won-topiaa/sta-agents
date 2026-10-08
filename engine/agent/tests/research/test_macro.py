"""Official statistics (FRED/ALFRED) as point-in-time macro guards: a value counts only from the day after it was
published, as it stood then; a guard scales its own sector's weights; designs without guards are unchanged."""
import datetime as dt
import json

import numpy as np
import pandas as pd
import pytest

from xtxc_agent.core.strategy_design import describe
from xtxc_agent.research import agent_profile as ap
from xtxc_agent.research import macro
from xtxc_agent.research import strategy_lang as sl
from xtxc_agent.research.strategies import normalize_spec, target_weights

from test_agent_profile import AGENT
from test_strategy_lang import DESIGN

# Monthly index: June 100 (published Jul 15), July 95 (published Aug 15, revised to 105 on Sep 15), Aug 90 (Sep 15).
ROWS = [["2026-06-01", "2026-07-15", "9999-12-31", 100.0],
        ["2026-07-01", "2026-08-15", "2026-09-14", 95.0], ["2026-07-01", "2026-09-15", "9999-12-31", 105.0],
        ["2026-08-01", "2026-09-15", "9999-12-31", 90.0]]


def test_vintages_use_only_what_was_published_then():
    v = macro.Vintages(ROWS)
    assert v.change("2026-08-14", 1) is None                         # only June is out
    assert v.change("2026-08-15", 1) == pytest.approx(95 / 100 - 1)    # July's first print
    assert v.change("2026-09-15", 1) == pytest.approx(90 / 105 - 1)    # August vs July as revised that day
    idx = pd.DatetimeIndex(["2026-08-15", "2026-08-16", "2026-09-15", "2026-09-16"])
    col = macro.change_column(ROWS, idx, 1)                            # usable from the day after publication
    assert np.isnan(col[0]) and col[1] == pytest.approx(-0.05) and col[2] == pytest.approx(-0.05) and col[3] == pytest.approx(90 / 105 - 1)
    # no look-ahead: dropping everything published later never changes an earlier day
    cut = [r for r in ROWS if r[1] <= "2026-08-20"]
    assert macro.change_column(cut, idx[:2], 1)[1] == col[1]


def test_scope_by_sic_sector_and_fund():
    assert macro.in_scope("semiconductors", "NVDA", "3674", "technology")
    assert macro.in_scope("semiconductors", "AMAT", 3559, "technology") and macro.in_scope("semiconductors", "QCOM", "3663", "technology")
    assert not macro.in_scope("semiconductors", "MSFT", "7372", "technology")
    assert macro.in_scope("semiconductors", "SOXL", None, None) and not macro.in_scope("semiconductors", "SOXS", None, None)
    assert macro.in_scope("consumer", "WMT", "5331", "consumer_staples") and macro.in_scope("energy", "XLE", None, None)
    assert macro.in_scope("market", "ANY", None, None)


BASE = {"score": [{"signal": "momentum", "lookback": 21, "weight": 1}], "filters": [], "top_n": None, "weighting": "equal", "risk_off": None}
GUARD = {"series": "IPG3344S", "change": 3, "below": 0, "exposure": 0.5}


def test_macro_off_is_optional_checked_and_canonical():
    assert sl.design_hash(DESIGN) == sl.design_hash({**DESIGN, "macro_off": None}) == sl.design_hash({**DESIGN, "macro_off": []})
    d = sl.normalize_design({**BASE, "macro_off": [{"series": "DTWEXBGS", "change": 63, "above": 0.03, "exposure": 0.4}, GUARD]})
    assert [g["series"] for g in d["macro_off"]] == ["DTWEXBGS", "IPG3344S"]
    assert sl.macro_columns(d) == [("DTWEXBGS", 63), ("IPG3344S", 3)]
    assert "macro_off" not in sl.normalize_design({**BASE, "macro_off": [{**GUARD, "exposure": 1}]})   # changes nothing
    for bad in ([{**GUARD, "series": "GDP"}], [{**GUARD, "above": 0.1}], [{"series": "IPG3344S", "change": 3, "exposure": 0.5}],
                [{**GUARD, "change": 24}], [{"series": "DCOILWTICO", "change": 2, "below": -0.1, "exposure": 0.5}], [GUARD, GUARD], GUARD):
        with pytest.raises(sl.DesignError):
            sl.normalize_design({**BASE, "macro_off": bad})
    assert "50%" in describe({**BASE, "macro_off": [GUARD]})["macro"]


def _frame(change_value):
    idx = pd.bdate_range("2024-01-01", periods=60)
    rng = np.random.default_rng(4)
    prices = pd.DataFrame({t: 50 * np.exp(np.cumsum(rng.normal(0.001, 0.01, 60))) for t in ("NVDA", "AMD", "KO", "XOM")}, index=idx)
    prices["MACRO::IPG3344S::3"] = change_value
    for t in prices.columns[:4]:
        prices[f"{t}::in::semiconductors"] = 1.0 if t in ("NVDA", "AMD") else 0.0
    return prices


def test_a_triggered_guard_scales_only_its_sector_and_keeps_the_rest_in_cash():
    spec = lambda d: normalize_spec({"template": "custom", "params": {"design": d}, "universe": ["NVDA", "AMD", "KO", "XOM"],
                                     "max_weight": "0.25", "min_cash": "0", "rebalance": "monthly"})
    plain = target_weights(spec(BASE), _frame(-0.02), 59)
    guarded = target_weights(spec({**BASE, "macro_off": [GUARD]}), _frame(-0.02), 59)
    calm = target_weights(spec({**BASE, "macro_off": [GUARD]}), _frame(0.01), 59)
    unknown = target_weights(spec({**BASE, "macro_off": [GUARD]}), _frame(np.nan), 59)
    assert calm == plain == unknown                                    # not triggered, or nothing published: no effect
    for t in plain:
        assert guarded[t] == pytest.approx(plain[t] * (0.5 if t in ("NVDA", "AMD") else 1.0))
    assert sum(guarded.values()) < sum(plain.values())


def test_agent_macro_rules_enforced_merged_and_checked():
    agent = {**AGENT, "rules": [{"id": "semis_cycle_guard", "params": {"months": 6, "exposure": 0.3}},
                                {"id": "dollar_guard", "params": {"days": 63, "rise": 0.05, "exposure": 0.5}},
                                {"id": "oil_guard", "params": {"days": 126, "drop": 0.2, "exposure": 0.7}}]}
    model = {**DESIGN, "risk_off": None, "macro_off": [{"series": "IPG3344S", "change": 1, "below": 0.1, "exposure": 0.9},
                                                      {"series": "RSAFS", "change": 3, "below": 0, "exposure": 0.5}]}
    d = ap.apply(model, agent)
    got = {g["series"]: g for g in d["macro_off"]}
    assert got["IPG3344S"] == {"series": "IPG3344S", "change": 6, "below": 0, "exposure": 0.3}   # the agent's guard wins
    assert got["RSAFS"]["change"] == 3                                                            # the model's other guard stays
    assert got["DTWEXBGS"]["above"] == 0.05 and got["DCOILWTICO"]["below"] == -0.2
    assert all(c["status"] == "pass" for c in ap.compliance(d, agent))
    assert {c["rule"]: c["status"] for c in ap.compliance(model, agent)}["semis_cycle_guard"] == "fail"


def test_bridge_adds_columns_and_waits_for_stale_statistics(tmp_path):
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "compute"))
    from design_bridge import with_macro
    from xtxc_agent.research import marketdata as md
    d = tmp_path / "macro"
    (d / "objects").mkdir(parents=True)
    body = md._canonical_json(ROWS)
    sha = md._sha256(body)
    (d / "objects" / f"{sha}.json").write_bytes(body)
    now = dt.datetime.now(dt.timezone.utc)
    rel = {"schema": macro.SCHEMA, "fetched_at": now.isoformat(), "release_id": "r", "series": {"IPG3344S": {"object": sha, "observation_end": "2026-08-01"}}}
    (d / "release.json").write_text(json.dumps(rel))
    (tmp_path / "fundamentals").mkdir()
    (tmp_path / "fundamentals" / "release.json").write_text(json.dumps({"tickers": {"NVDA": {"sic": "3674", "sector": "technology"}, "KO": {"sic": "2080", "sector": "consumer_staples"}}}))
    prices = pd.DataFrame({"NVDA": [1.0, 1.0], "KO": [1.0, 1.0]}, index=pd.DatetimeIndex(["2026-09-15", "2026-09-16"]))
    cands = [{"design": {**BASE, "macro_off": [{**GUARD, "change": 1}]}}]
    out, snap = with_macro(prices, {"limitations": []}, tmp_path, ["NVDA", "KO"], cands)
    assert out["NVDA::in::semiconductors"].tolist() == [1.0, 1.0] and out["KO::in::semiconductors"].tolist() == [0.0, 0.0]
    assert out["MACRO::IPG3344S::1"].iloc[-1] == pytest.approx(90 / 105 - 1)
    assert snap["macro"]["series"] == ["IPG3344S"] and macro.NOTICE in snap["limitations"][-1]
    assert with_macro(prices, {}, tmp_path, ["NVDA"], [{"design": BASE}])[0] is prices          # no guard, nothing read
    (d / "release.json").write_text(json.dumps({**rel, "fetched_at": (now - dt.timedelta(days=30)).isoformat()}))
    with pytest.raises(ValueError, match="WAITING_DATA"):
        with_macro(prices, {}, tmp_path, ["NVDA"], cands)


def test_refresh_keeps_a_failed_series_and_refuses_copyright(tmp_path, monkeypatch):
    calls = []

    def fake(series_id, key, start="2010-01-01"):
        calls.append(series_id)
        if series_id == "RSAFS":
            raise ValueError("RSAFS is copyrighted; it is not used")
        return {"rows": ROWS, "last_updated": "x", "observation_end": "2026-08-01", "frequency": "M", "title": series_id}
    monkeypatch.setattr(macro, "fetch_series", fake)
    rel = macro.refresh_release(tmp_path, "k")
    assert set(rel["series"]) == set(macro.SERIES) - {"RSAFS"} and "RSAFS" in rel["errors"]
    assert macro.load_rows(tmp_path, "IPG3344S") == ROWS and macro.release_age_days(tmp_path) < 1


def test_refresh_without_a_readable_fred_key_still_refreshes_prices(tmp_path, monkeypatch):
    import importlib.util
    import json
    import sys
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("refresh_research_data", Path(__file__).resolve().parents[3] / "scripts" / "refresh_research_data.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "refresh_prices", lambda root, store: {"release": "p"})
    monkeypatch.setattr(mod, "refresh_fundamentals", lambda root: {"release": "f"})
    monkeypatch.setattr(sys, "argv", ["refresh", str(tmp_path), "--fred-env", str(tmp_path / "missing.env")])
    assert mod.main() == 1
    parts = json.loads((tmp_path / "refresh-status.json").read_text())["parts"]
    assert parts["prices"]["ok"] and parts["fundamentals"]["ok"]
    assert not parts["macro"]["ok"] and "FRED key file unreadable" in parts["macro"]["error"]
