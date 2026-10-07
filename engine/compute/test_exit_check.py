import pandas as pd
import pytest

import exit_check


def test_exit_check_matches_the_backtest_rules(monkeypatch):
    idx = pd.bdate_range("2026-09-01", periods=8)
    frame = pd.DataFrame({"AMD": [100, 104, 110, 120, 108, 101, 99, 95], "MU": [50, 51, 52, 53, 54, 55, 56, 57]}, index=idx, dtype=float)
    monkeypatch.setattr(exit_check, "load_prices", lambda root, tickers, column, common: (frame[tickers], {"asOf": "2026-09-10"}))
    out = exit_check.check("/data", [
        {"ticker": "AMD", "since": "2026-09-02", "stop_loss": 0.1, "trailing_stop": None},      # entry 104, last 95: -8.7%
        {"ticker": "AMD", "since": "2026-09-02", "stop_loss": None, "trailing_stop": 0.2},      # peak 120, last 95: -20.8%
        {"ticker": "MU", "since": "2026-09-01", "stop_loss": 0.05, "trailing_stop": 0.05}])
    a, b, c = out["positions"]
    assert (a["entryClose"], a["peakClose"], a["lastClose"], a["triggered"]) == (104, 120, 95, None)
    assert b["triggered"] == "trailing_stop" and c["triggered"] is None and out["asOf"] == "2026-09-10"
    with pytest.raises(ValueError):
        exit_check.check("/data", [{"ticker": "AMD", "since": "2026-09-02", "stop_loss": 0.9}])
