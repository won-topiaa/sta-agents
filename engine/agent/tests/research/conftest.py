import sys
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parents[2]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from xtxc_agent.research import marketdata  # noqa: E402


@pytest.fixture(scope="session")
def real_snapshot_id():
    from xtxc_agent.research.universe import load_universe

    # other services write small per-brief snapshots too: pick the newest one covering the universe
    sid = marketdata.latest_snapshot_id(tickers=[i.ticker for i in load_universe()])
    if sid is None:
        pytest.skip("no full-universe snapshot yet (run python -m xtxc_agent.research.marketdata)")
    return sid


@pytest.fixture(scope="session")
def real_prices(real_snapshot_id):
    return marketdata.load_prices(real_snapshot_id)


SEMIS = ["NVDA", "AMD", "AVGO", "TSM", "MU", "MRVL", "INTC"]


@pytest.fixture
def semis_spec():
    return {"template": "momentum", "params": {}, "universe": list(SEMIS), "max_weight": "0.25",
            "min_cash": "0.20", "rebalance": "weekly", "exclude_leveraged": True}



@pytest.fixture(autouse=True)
def korean_by_default():
    """The research tests assert Korean check texts."""
    from xtxc_agent.core import i18n
    with i18n.speaking("ko"):
        yield
