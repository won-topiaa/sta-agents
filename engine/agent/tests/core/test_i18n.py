"""English (default), Korean and Chinese: catalog completeness, money, plans, conversation and the X-Lang header."""
import json
import re

import pytest

from xtxc_agent.core import i18n
from xtxc_agent.core.i18n import tr

HANGUL = re.compile(r"[가-힣]")


def test_every_message_exists_in_all_three_languages_with_the_same_params():
    assert i18n.missing_translations() == []
    for lang in i18n.LANGS:
        with i18n.speaking(lang):
            for key in i18n.M:
                assert tr(key, n=2, s="s", m=1, p="1.0", c="1.0", name="X", names="X", amount="$1", title="T", v=1, fields="F",
                          e="E", q="Q", date="D", day="D", headline="H", label="L", reasons="R", parts="P", t="T", f=1, ru="1", rx="1",
                          cu="1", cx="1", hx="1", hb="1", bench="B", tot="1", mw="1", mc="1", budget="B", old=1, cur=2, sec=45,
                          x="1", note="N", done="D", verb="v", verb_if="v", ger="G", stem="s", extra="E", cost="C", d="D",
                          src="S", y="Y", r="R", b="B", years="Y", diff="D", sectors="S", template="T", period="P", opts="O",
                          dir="D", k=1, h="H", lo="L", hi="H", lop="L", hip="H", cov="C", c0="C", w0="W", c1="C", w1="W",
                          y0="Y", y1="Y", typ="T", bad="B", size="S", bps="B", money="M", age="A", o="O", now="N", as_of="A",
                          bars="B", quotes="Q", first="F", last="L", net="N", move="M", at="A", base="B", method="M", d0="D", d1="D", s0="S", s1="S", span="S", fast="F", sig="S", w="W", mode="M", a="A", u="U", med="M", worst="W", sent="1") is not None


def test_money_is_won_in_korean_and_dollars_otherwise():
    with i18n.speaking("ko"):
        assert i18n.money(1_860_000, "1390") == "186만 원" and i18n.money(9_600) == "9,600원"
    for lang in ("en", "zh"):
        with i18n.speaking(lang):
            assert i18n.money(1_860_000, "1390") == "$1,338" and i18n.money(9_600, "1390") == "$6.91"


def test_default_language_is_english_and_unknown_values_fall_back():
    assert i18n.lang() in i18n.LANGS
    assert i18n.norm(None) == "en" and i18n.norm("fr") == "en" and i18n.norm("zh-CN") == "zh" and i18n.norm("KO") == "ko"


@pytest.mark.parametrize("lang,head", [("en", "Buy "), ("zh", "买入"), ("ko", "종목을")])
def test_plan_text_follows_the_language_and_tickers_stay_as_they_are(tmp_path, lang, head):
    from test_orders_exec import FakeChain, setup
    chain = FakeChain(depth={"AAA": 120_000 * 10**6})
    with i18n.speaking(lang):
        db, planner, ex, brief, run = setup(tmp_path, chain)
        plan = planner.build(run, brief, "W")
    assert head in plan["headline_ko"] and plan["lang"] == lang
    assert {o["ticker"] for o in plan["orders"]} == {"AAA", "BBB"}            # tickers are never translated
    shown = json.dumps({k: plan[k] for k in ("headline_ko", "lights", "slicing_note_ko", "immediate", "wallet_preview")}, ensure_ascii=False)
    if lang != "ko":
        assert not HANGUL.search(shown), shown[:400]
    if lang == "en":
        assert "$" in plan["headline_ko"] and plan["lights"][0]["label_ko"] == "My conditions"


def test_conversation_in_english_understands_dollars_and_replies_in_english(tmp_path):
    from test_chat import UNIVERSE, FakeKiln
    from types import SimpleNamespace
    from xtxc_agent.core.briefs import Briefs
    from xtxc_agent.core.chat import Chat
    from xtxc_agent.core.config import Settings
    from xtxc_agent.core.db import Database
    from xtxc_agent.core.ledger import Ledger
    s = Settings(db_path=tmp_path / "t.db")
    db = Database(s.db_path)
    ledger, kiln = Ledger(db), FakeKiln()
    for t, n in (("LLY", "Eli Lilly"), ("NVO", "Novo Nordisk"), ("UNH", "UnitedHealth")):
        UNIVERSE[t].name_short_en = n
    briefs = Briefs(s, db, ledger, kiln, lambda: UNIVERSE)
    none = SimpleNamespace(get=lambda rid: (_ for _ in ()).throw(KeyError(rid)), plan=lambda pid: None)
    chat = Chat(db, ledger, kiln, briefs, none, none, SimpleNamespace(_facts=lambda w, r: ({}, {})))
    kiln.script["brief_compile"] = [{"budget_krw": None, "budget_usd": 3000, "sectors": ["healthcare"], "tickers": [], "exclude": [],
                                     "max_weight": None, "min_cash": "0.1", "rebalance": None, "template": None, "exclude_leveraged": None,
                                     "questions": []}]
    with i18n.speaking("en"):
        first = chat.turn("W", "Invest $3,000 in healthcare, keep 10% cash", "start", {})
        assert first["brief"]["budget_krw"] == 3000 * 1390 and first["reply_ko"].startswith("Here's what I understood")
        assert "English" in kiln.calls[0][1][0]["content"]                        # questions asked in the display language
        kiln.script["chat_turn"] = [{"intent": "edit", "changes": {"exclude": ["UNH"]}, "sentences": []}]
        out = chat.turn("W", "drop UnitedHealth", "brief", {"brief_id": first["brief"]["brief_id"]})
        assert out["reply_ko"] == "Conditions updated: Excluded stocks UnitedHealth."
        kiln.script["chat_turn"] = [{"intent": "question", "changes": None, "sentences": ["Your budget is {budget} dollars."]}]
        out = chat.turn("W", "what's my budget?", "brief", {"brief_id": first["brief"]["brief_id"]})
        assert out["reply_ko"] == "Your budget is $3,000."                          # repeated unit removed
        assert "English" in kiln.calls[-1][1][0]["content"]
        kiln.script["chat_turn"] = [{"intent": "edit", "changes": {"budget_usd": 5000}, "sentences": []}]
        out = chat.turn("W", "make it $5,000", "brief", {"brief_id": first["brief"]["brief_id"]})
        assert out["brief"]["budget_krw"] == 5000 * 1390 and "Budget $3,000 → $5,000" in out["reply_ko"]
    with i18n.speaking("zh"):
        kiln.script["chat_turn"] = [{"intent": "proceed", "changes": None, "sentences": []}]
        out = chat.turn("W", "好的，继续", "brief", {"brief_id": first["brief"]["brief_id"]})
        assert out["reply_ko"] == "好的，我会确认这些条件并用历史数据回测。"


def test_the_x_lang_header_sets_the_language_of_each_request(api):
    alice, _, _ = api
    zh = {"X-Lang": "zh"}
    assert alice.get("/api/health", headers=zh).json()["lang"] == "zh"
    assert alice.get("/api/health", headers={"X-Lang": "xx"}).json()["lang"] == "en"
    assert "分批买入" in alice.get("/api/glossary", headers=zh).json()
    assert "Split buying" in alice.get("/api/glossary", headers={"X-Lang": "en"}).json()
    r = alice.get("/api/records?wallet=someone", headers={"X-Lang": "en"})
    assert r.status_code == 403 and r.json()["detail_ko"] == "Connect the demo wallet first."


from test_demo import api  # noqa: E402,F401  (fixture reuse)


def test_a_dollar_budget_alone_is_enough():
    from xtxc_agent.core.prompts import validate_brief
    out = validate_brief({"budget_usd": 3000, "sectors": ["healthcare"], "tickers": [], "exclude": [], "max_weight": "0.35",
                          "min_cash": "0.10", "rebalance": None, "template": None, "exclude_leveraged": None, "questions": []},
                         {"LLY"}, {"healthcare"})
    assert out["budget_krw"] == 3000 * 1390
    with pytest.raises(ValueError):
        validate_brief({"budget_usd": 3000, "budget_krw": 1_000_000, "sectors": [], "tickers": [], "exclude": [], "max_weight": None,
                        "min_cash": None, "rebalance": None, "template": None, "exclude_leveraged": None, "questions": []}, set(), set())


def test_repeated_words_around_placeholders_are_tidied():
    assert i18n.tidy("最近最近一年策略+5.7%") == "最近一年策略+5.7%"
    assert i18n.tidy("Over the last the last year it made +5%") == "Over the last year it made +5%"
    assert i18n.tidy("최근 최근 1년") == "최근 1년"
    for lang, want in (("en", "1.0 pp"), ("ko", "1.0%p"), ("zh", "1.0个百分点")):
        with i18n.speaking(lang):
            assert tr("unit.pp", x="1.0") == want
