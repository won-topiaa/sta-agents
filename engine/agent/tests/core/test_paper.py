"""모의운용 moves forward with the daily history the forecasts use (verified release + tape continuation)."""
import json
from types import SimpleNamespace

import pandas as pd

from xtxc_agent.core.config import Settings
from xtxc_agent.core.db import Database
from xtxc_agent.core.ledger import Ledger
from xtxc_agent.core.paper import Paper


def test_paper_runs_are_valued_on_sessions_after_the_release(tmp_path):
    db = Database(Settings(db_path=tmp_path / "t.db").db_path)
    idx = pd.to_datetime(["2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30"])
    adj = pd.DataFrame({"AAA": [90.0, 100.0, 110.0, 121.0], "QQQ": [500.0, 500.0, 505.0, 510.0]}, index=idx)
    daily = SimpleNamespace(adj=adj, as_of="2026-09-30",
                            provenance={"_extension": {"from": "2026-09-29", "to": "2026-09-30", "sessions": 2}})
    paper = Paper(db, Ledger(db), None, daily=lambda: daily)
    run = {"run_id": "r1", "status": "done", "title_ko": "t", "target": {"weights": {"AAA": 0.5}, "cash": 0.5},
           "data": {"as_of": "2026-09-28"}}
    pid = paper.start(run, "W")["paper_id"]
    st = paper.status(pid)
    assert st["days"] == 2 and st["as_of"] == "2026-09-30"
    assert abs(st["total_return"] - 0.5 * 0.21) < 1e-9 and abs(st["benchmark_return"] - 0.02) < 1e-9
    assert st["data"]["extended"]["from"] == "2026-09-29" and "2026-09-29" in st["note_ko"]
