"""변동 예측 in the conversation: the agent asks for what is missing (stocks, then the period); the card needs no model."""
from types import SimpleNamespace

import pytest

from test_chat import UNIVERSE, FakeKiln
from xtxc_agent.core.briefs import BriefError, Briefs
from xtxc_agent.core.chat import Chat
from xtxc_agent.core.config import Settings
from xtxc_agent.core.db import Database
from xtxc_agent.core.ledger import Ledger
from xtxc_agent.core.prompts import validate_brief, validate_forecast_request

EMPTY = {"budget_krw": None, "sectors": [], "tickers": [], "exclude": [], "max_weight": None, "min_cash": None, "rebalance": None,
         "template": None, "exclude_leveraged": None, "questions": []}
CHIPS = ["1h", "1d", "1w", "1m", "3m", "6m", "1y", "3y"]


@pytest.fixture
def fenv(tmp_path):
    s = Settings(db_path=tmp_path / "t.db")
    db = Database(s.db_path)
    ledger, kiln = Ledger(db), FakeKiln()
    briefs = Briefs(s, db, ledger, kiln, lambda: UNIVERSE)
    chat = Chat(db, ledger, kiln, briefs, SimpleNamespace(get=lambda rid: (_ for _ in ()).throw(KeyError(rid))),
                SimpleNamespace(plan=lambda pid: None), SimpleNamespace(_facts=lambda w, r: ({}, {})))
    return SimpleNamespace(chat=chat, kiln=kiln, db=db, briefs=briefs)


def test_a_first_message_asking_how_much_a_stock_moves_is_a_forecast_and_the_agent_asks_the_period(fenv):
    fenv.kiln.script["brief_compile"] = [{**EMPTY, "forecast": {"tickers": ["AAPL"], "horizon": None}}]
    out = fenv.chat.turn("W", "애플은 앞으로 얼마나 흔들릴까?", "start", {})
    a = out["action"]
    assert out["intent"] == "forecast" and a["type"] == "forecast_ask" and a["need"] == "horizon" and a["tickers"] == ["AAPL"]
    assert [c["code"] for c in a["choices"]] == CHIPS and a["choices"][1]["label"] == "1일 (밤사이 포함)"
    assert out["reply_ko"].startswith("애플(AAPL)을 얼마나 오래 가지고 있을 생각이세요?")
    assert fenv.db.one("SELECT COUNT(*) n FROM briefs")["n"] == 0            # a question, not investment conditions
    assert [c[0] for c in fenv.kiln.calls] == ["brief_compile"]            # still one model call per typed message


def test_the_period_answer_is_read_in_one_call_and_an_invalid_period_is_repaired(fenv):
    fenv.kiln.script["forecast_turn"] = [{"intent": "forecast", "tickers": [], "horizon": "20y", "sentences": []},   # > 3 years
                                         {"intent": "forecast", "tickers": [], "horizon": "2y", "sentences": []}]
    out = fenv.chat.turn("W", "2년 정도 들고 있을 거예요", "forecast", {"forecast": {"tickers": ["AAPL"], "horizon": None}})
    assert out["action"] == {"type": "forecast_ready", "tickers": ["AAPL"], "horizon": "2y"}
    assert out["reply_ko"] == "2년 예측이에요." and [c[0] for c in fenv.kiln.calls] == ["forecast_turn"]


def test_without_stocks_the_agent_asks_which_ones_first(fenv):
    fenv.kiln.script["brief_compile"] = [{**EMPTY, "forecast": {"tickers": [], "horizon": "1y"}}]
    out = fenv.chat.turn("W", "1년 동안 얼마나 오르내릴지 알려줘", "start", {})
    assert out["action"]["need"] == "tickers" and out["action"]["horizon"] == "1y" and "어떤 종목" in out["reply_ko"]
    fenv.kiln.script["forecast_turn"] = [{"intent": "forecast", "tickers": ["MSFT", "AAPL"], "horizon": None, "sentences": []}]
    out = fenv.chat.turn("W", "마소랑 애플", "forecast", {"forecast": {"tickers": [], "horizon": "1y"}})
    assert out["action"] == {"type": "forecast_ready", "tickers": ["MSFT", "AAPL"], "horizon": "1y"}


def test_during_other_steps_a_forecast_uses_the_stocks_of_the_conditions(fenv):
    fenv.kiln.script["brief_compile"] = [{**EMPTY, "budget_krw": 3_000_000, "sectors": ["healthcare"], "min_cash": "0.1"}]
    b = fenv.chat.turn("W", "300만 원으로 헬스케어", "start", {})["brief"]
    fenv.kiln.script["chat_turn"] = [{"intent": "forecast", "changes": {"tickers": [], "horizon": None}, "sentences": []}]
    out = fenv.chat.turn("W", "이 종목들 얼마나 흔들려?", "brief", {"brief_id": b["brief_id"]})
    assert out["action"]["type"] == "forecast_ask" and out["action"]["tickers"] == ["LLY", "NVO", "UNH"]


def test_cancel_other_and_new_while_the_agent_waits_for_the_period(fenv):
    known = {"forecast": {"tickers": ["AAPL"], "horizon": None}}
    fenv.kiln.script["forecast_turn"] = [{"intent": "cancel", "tickers": [], "horizon": None, "sentences": []}]
    assert fenv.chat.turn("W", "안 할래", "forecast", known)["action"]["type"] == "forecast_cancel"
    fenv.kiln.script["forecast_turn"] = [{"intent": "other", "tickers": [], "horizon": None, "sentences": ["날씨 이야기는 잘 몰라요."]}]
    out = fenv.chat.turn("W", "오늘 날씨 어때", "forecast", known)
    assert out["action"]["need"] == "horizon" and out["reply_ko"].startswith("날씨 이야기는 잘 몰라요. 애플(AAPL)을")
    fenv.kiln.script["forecast_turn"] = [{"intent": "new", "tickers": [], "horizon": None, "sentences": []}]
    fenv.kiln.script["brief_compile"] = [{**EMPTY, "budget_krw": 1_000_000, "tickers": ["AAPL"]}]
    assert fenv.chat.turn("W", "그냥 100만 원으로 애플 살래", "forecast", known)["action"]["type"] == "brief_created"


def test_the_conditions_endpoint_refuses_a_forecast_question(fenv):
    fenv.kiln.script["brief_compile"] = [{**EMPTY, "forecast": {"tickers": ["AAPL"], "horizon": "1y"}}]
    with pytest.raises(BriefError):
        fenv.briefs.create("애플 1년 변동성", "W")


def test_forecast_request_rules():
    assert validate_forecast_request({"tickers": ["AAPL", "AAPL"], "horizon": "18m"}, {"AAPL"}) == {"tickers": ["AAPL"], "horizon": "18m"}
    for bad in ({"tickers": ["ZZZ"], "horizon": None}, {"tickers": ["AAPL"], "horizon": "25h"}, {"tickers": ["AAPL"], "horizon": "4y"},
                {"tickers": ["AAPL"]}, {"tickers": "AAPL", "horizon": None}):
        with pytest.raises(ValueError):
            validate_forecast_request(bad, {"AAPL"})
    # edits and older cached answers have no forecast key and still validate as conditions
    assert "forecast" not in validate_brief({**EMPTY, "budget_krw": 1_000_000}, {"AAPL"}, {"big_tech"})
