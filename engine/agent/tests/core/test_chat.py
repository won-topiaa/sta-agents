"""대화형 진행: one model call per typed message, code applies edits, the model never approves anything."""
import json
from types import SimpleNamespace

import pytest

from xtxc_agent.core.briefs import Briefs
from xtxc_agent.core.chat import Chat, ChatError
from xtxc_agent.core.config import Settings
from xtxc_agent.core.db import Database, dumps, now_iso
from xtxc_agent.core.kiln import ModelOutputInvalid, ModelResult
from xtxc_agent.core.ledger import Ledger

UNIVERSE = {t: SimpleNamespace(name_ko=n, sector=s, kind="common") for t, n, s in
            [("LLY", "일라이 릴리", "healthcare"), ("NVO", "노보 노디스크", "healthcare"), ("UNH", "유나이티드헬스", "healthcare"),
             ("AAPL", "애플", "big_tech"), ("MSFT", "마이크로소프트", "big_tech")]}


class FakeKiln:
    """Plays scripted model answers per flow and runs the real validator (a rejected answer = one repair attempt)."""
    def __init__(self):
        self.script, self.calls = {}, []

    def complete_json(self, flow, messages, validate, **kw):
        self.calls.append((flow, messages))
        for answer in self.script.get(flow, []):
            try:
                value = validate(answer)
            except ValueError:
                continue
            self.script[flow] = self.script[flow][self.script[flow].index(answer) + 1:]
            return ModelResult(value, f"call-{len(self.calls)}", False, {"input_tokens": 900, "output_tokens": 80, "cost_usd": 0.0001})
        raise ModelOutputInvalid("no valid scripted answer")


@pytest.fixture
def env(tmp_path):
    s = Settings(db_path=tmp_path / "t.db")
    db = Database(s.db_path)
    ledger, kiln = Ledger(db), FakeKiln()
    briefs = Briefs(s, db, ledger, kiln, lambda: UNIVERSE)
    plans = {}
    executor = SimpleNamespace(plan=lambda pid: plans[pid])
    runner = SimpleNamespace(get=lambda rid: (_ for _ in ()).throw(KeyError(rid)))
    asker = SimpleNamespace(_facts=lambda wallet, rid: ({"recent_records_newest_first": "none"}, {}))
    chat = Chat(db, ledger, kiln, briefs, runner, executor, asker)
    kiln.script["brief_compile"] = [{"budget_krw": 3_000_000, "sectors": ["healthcare"], "tickers": [], "exclude": [], "max_weight": None,
                                     "min_cash": "0.1", "rebalance": None, "template": None, "exclude_leveraged": None, "questions": []}]
    first = chat.turn("W", "300만 원으로 헬스케어 사고 싶어", "start", {})
    return SimpleNamespace(chat=chat, kiln=kiln, db=db, briefs=briefs, plans=plans, brief=first["brief"], first=first)


def test_first_message_compiles_conditions(env):
    assert env.first["action"]["type"] == "brief_created" and env.first["intent"] == "new"
    assert env.brief["universe"]["tickers"] == ["LLY", "NVO", "UNH"] and "짐작" in env.first["reply_ko"]
    assert [c[0] for c in env.kiln.calls] == ["brief_compile"]                # one call, no routing call first


def test_typed_edit_is_applied_by_code_and_reported_with_code_numbers(env):
    env.kiln.script["chat_turn"] = [{"intent": "edit", "changes": {"max_weight": "0.3"}, "sentences": []}]
    out = env.chat.turn("W", "한 종목에 30%까지 괜찮아", "brief", {"brief_id": env.brief["brief_id"]})
    assert out["action"]["type"] == "brief_updated" and out["brief"]["version"] == 2 and out["brief"]["max_weight"] == "0.3"
    assert "한 종목 최대 비중 25% → 30%" in out["reply_ko"]
    assert env.db.one("SELECT COUNT(*) n FROM events WHERE type = 'brief.edited'")["n"] == 1


def test_an_edit_that_breaks_the_rules_is_repaired_or_refused(env):
    env.kiln.script["chat_turn"] = [{"intent": "edit", "changes": {"tickers": ["TSLA"]}, "sentences": []},     # not tradable -> rejected
                                    {"intent": "edit", "changes": {"exclude": ["UNH"]}, "sentences": []}]
    out = env.chat.turn("W", "유나이티드헬스는 빼 줘", "brief", {"brief_id": env.brief["brief_id"]})
    assert out["brief"]["universe"]["tickers"] == ["LLY", "NVO"] and "제외 종목 유나이티드헬스" in out["reply_ko"]


def test_question_answers_use_placeholders_and_digits_are_rejected(env):
    env.kiln.script["chat_turn"] = [{"intent": "question", "changes": None, "sentences": ["예산은 3000000원이에요."]},   # digits -> rejected
                                    {"intent": "question", "changes": None, "sentences": ["예산은 {budget}이고 한 종목은 최대 {max_weight}까지예요."]}]
    out = env.chat.turn("W", "내 예산이 얼마였지?", "brief", {"brief_id": env.brief["brief_id"]})
    assert out["reply_ko"] == "예산은 300만 원이고 한 종목은 최대 25%까지예요." and out["action"]["type"] == "none"
    assert env.db.one("SELECT summary_ko FROM events WHERE type = 'ask'")["summary_ko"].startswith("질문:")


def test_proceed_never_approves_and_edits_wait_while_orders_are_pending(env):
    env.plans["p1"] = {"wallet": "W", "orders": [{"ticker": "LLY", "name_ko": "일라이 릴리", "side": "BUY", "krw": 900000, "slicing": {"count": 6}}],
                       "cost_krw_est": 3000, "cash_after_krw": 300000, "tier": "careful", "lights": [], "mode_options": ["slice"],
                       "slicing_note_ko": "일라이 릴리는 거래가 얇아 6번에 나눠 사요.", "immediate": {"available": False, "reason_ko": "비용이 커서 막아 두었어요."}}
    refs = {"brief_id": env.brief["brief_id"], "plan_id": "p1"}
    env.kiln.script["chat_turn"] = [{"intent": "proceed", "changes": None, "sentences": []}]
    out = env.chat.turn("W", "응 사줘", "plan", refs)
    assert out["action"]["type"] == "open_approval" and "대신 결재할 수는 없어요" in out["reply_ko"]
    env.kiln.script["chat_turn"] = [{"intent": "edit", "changes": {"min_cash": "0.2"}, "sentences": []}]
    out = env.chat.turn("W", "현금 20% 남겨줘", "waiting", refs)
    assert out["action"]["type"] == "none" and "모두 멈추기" in out["reply_ko"]
    assert env.briefs.get(env.brief["brief_id"])["version"] == 1                      # nothing changed
    env.kiln.script["chat_turn"] = [{"intent": "stop", "changes": None, "sentences": []}]
    assert env.chat.turn("W", "그만할래", "waiting", refs)["action"]["type"] == "confirm_stop"


def test_prompt_is_a_stage_summary_not_the_whole_conversation(env):
    env.kiln.script["chat_turn"] = [{"intent": "other", "changes": None, "sentences": ["투자 이야기로 돌아가 볼까요?"]}] * 5
    for _ in range(5):
        env.chat.turn("W", "오늘 날씨 어때?", "brief", {"brief_id": env.brief["brief_id"]})
    sizes = [len(json.dumps(m, ensure_ascii=False)) for f, m in env.kiln.calls if f == "chat_turn"]
    assert len(set(sizes)) == 1 and sizes[0] < 6000           # same size every turn: history is never re-sent
    user = env.kiln.calls[-1][1][1]["content"]
    assert "300" not in user and "{budget}" in user            # facts carry placeholders, not numbers


def test_limits_on_message_and_stage(env):
    with pytest.raises(ChatError):
        env.chat.turn("W", "x" * 301, "brief", {"brief_id": env.brief["brief_id"]})
    with pytest.raises(ChatError):
        env.chat.turn("W", "안녕", "nowhere", {"brief_id": env.brief["brief_id"]})


def test_an_edit_that_leaves_the_stocks_unchanged_is_sent_back(env):
    # removing a sector stock by re-listing tickers changes nothing -> rejected; the exclude version is accepted
    env.kiln.script["chat_turn"] = [{"intent": "edit", "changes": {"tickers": ["LLY", "NVO", "UNH"]}, "sentences": []},
                                    {"intent": "edit", "changes": {"exclude": ["UNH"]}, "sentences": []}]
    out = env.chat.turn("W", "유나이티드헬스는 빼 줘", "brief", {"brief_id": env.brief["brief_id"]})
    assert out["brief"]["universe"]["tickers"] == ["LLY", "NVO"]


def test_repeated_units_after_placeholders_are_removed(env):
    env.kiln.script["chat_turn"] = [{"intent": "question", "changes": None, "sentences": ["예산은 {budget} 원이고 현금은 {min_cash}% 남겨요."]}]
    out = env.chat.turn("W", "예산?", "brief", {"brief_id": env.brief["brief_id"]})
    assert out["reply_ko"] == "예산은 300만 원이고 현금은 10% 남겨요."


def test_brief_names_cover_excluded_tickers(env):
    env.kiln.script["chat_turn"] = [{"intent": "edit", "changes": {"exclude": ["UNH"]}, "sentences": []}]
    out = env.chat.turn("W", "유나이티드헬스는 빼 줘", "brief", {"brief_id": env.brief["brief_id"]})
    assert out["brief"]["names_ko"]["UNH"] == "유나이티드헬스" and "UNH" not in out["brief"]["universe"]["tickers"]


def test_restating_the_current_conditions_is_answered_without_a_retry(env):
    env.kiln.script["chat_turn"] = [{"intent": "edit", "changes": {"min_cash": "0.1"}, "sentences": []}]
    out = env.chat.turn("W", "현금은 10% 남겨 줘", "brief", {"brief_id": env.brief["brief_id"]})
    assert out["action"]["type"] == "none" and out["reply_ko"] == "이미 그 조건으로 되어 있어서 바꾼 게 없어요."
    assert len([c for c in env.kiln.calls if c[0] == "chat_turn"]) == 1
