"""Existing core tests assert Korean display text: run them in Korean. test_i18n.py switches languages itself."""
import pytest

from xtxc_agent.core import i18n


@pytest.fixture(autouse=True)
def korean_by_default():
    with i18n.speaking("ko"):
        yield
