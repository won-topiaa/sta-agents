"""대화형 진행: the conversation is a shell over the same code-driven flow (조건 → 검사 → 결재 → 체결 → 기록).

Buttons never call the model. A message the user TYPES costs exactly one model call (`chat_turn`): the model picks
what the user wants and, for a question, answers from the current stage's facts. It sees a short summary of where
the user is, never the whole conversation, so a turn stays about a thousand tokens however long the chat gets.

The model never approves or sends anything. 'proceed' only tells the screen which next step to offer; a money step
always goes through the approval card and a wallet signature. Numbers shown to the user come from code: the model
writes no digits in text and refers to values through placeholders that code fills.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal

from . import i18n
from .briefs import EDITABLE, FIELD_KO, SECTOR_KO, TEMPLATE_KO, BriefError, Briefs
from .i18n import tr
from .db import Database
from .kiln import Kiln, ModelOutputInvalid, ModelUnavailable
from .ledger import Ledger
from .orders import topic
from .prompts import (DIGIT, FORECAST_MAX_TICKERS, PLACEHOLDER, REBALANCE, TEMPLATES, fill, no_digits, validate_brief,
                      validate_forecast_request)
from .research_runner import VERDICT_KO, explain_inputs, pct

STAGES = ("start", "brief", "research", "plan", "waiting", "receipt", "forecast")
INTENTS = ("edit", "question", "proceed", "stop", "new", "forecast", "other")
TIER_KO = i18n.Names("tier")      # names in the current display language
MODE_KO = i18n.Names("mode")

# Plain definitions the model may use when the user asks what something means (no digits), in the display language.
def glossary() -> dict[str, str]:
    return i18n.glossary()


GLOSSARY = glossary          # kept for callers that import the name

CHAT_SYSTEM = (
    "You are the assistant inside XTXC, a phone app where a retail investor sets investment conditions, the "
    "app checks them on past data, and the investor approves orders for tokenized US stocks. The user is at stage: {stage}. "
    "Decide what the user's message asks for and reply with ONE JSON object with keys exactly "
    "intent, changes, sentences. intent is one of: "
    "\"edit\" (change the current conditions; put ONLY the changed fields in changes), "
    "\"question\" (answer it from the facts only; if the facts do not answer it say so), "
    "\"proceed\" (the user agrees or asks for the next step), "
    "\"stop\" (the user wants to stop, cancel or undo waiting orders), "
    "\"new\" (the user describes a different new investment instead of changing this one), "
    "\"forecast\" (the user asks how much stocks may rise and fall, swing, or what their risk or price range could be over "
    "some period; changes is then {{\"tickers\": [tickers named, empty for the stocks in the current conditions], "
    "\"horizon\": \"<n><unit>\" or null}} with unit h hours, d trading days, w weeks, m months, y years, e.g. a year -> \"1y\"; "
    "null when no period was stated), "
    "\"other\" (anything else: reply with one sentence that brings them back to their investment). "
    "changes is null unless intent is edit or forecast. Allowed keys in changes for edit: budget_krw (integer won; 만원 and 억 become won) or "
    "budget_usd (integer US dollars, when the user states dollars/USD/USDC/美元), "
    "max_weight (decimal string, 30% -> \"0.3\"), min_cash (decimal string), rebalance (\"weekly\"|\"monthly\"), "
    "template (\"momentum\"|\"low_vol\"|\"equal_weight\"|\"ai\"; ai = the AI designs a new strategy itself), exclude_leveraged "
    "(true|false), sectors (array of sector ids), "
    "tickers (array of tickers), exclude (array of tickers). For sectors, tickers and exclude give the FULL new list "
    "starting from the current one in the facts. To REMOVE a stock that comes from a sector, add it to exclude and keep the "
    "sectors; to ADD a stock, add it to tickers. Use only sector ids and tickers from the list below. "
    "sentences: plain {language}, at most three short sentences, whatever language the user wrote in; required for question and "
    "other, may be empty otherwise. "
    "In sentences you MUST NOT write any digit; refer to numbers only with these placeholders copied exactly: {ids}. "
    "Each placeholder already includes its unit (currency, %, years, rounds); never add a unit after it. No emoji. "
    "Never recommend buying or selling a particular stock, never promise returns, never say an order was sent."
)


FORECAST_SYSTEM = (
    "You are the assistant inside XTXC, a phone app for tokenized US stocks. The app is preparing a forecast of how much "
    "stocks may move over a period and asked the user {need}. Reply with ONE JSON object with keys exactly intent, tickers, "
    "horizon, sentences. intent is one of: \"forecast\" (the user answers or changes the forecast request: put the stocks "
    "they named in tickers, only tickers from the list, empty if they named none; put the period in horizon as "
    "\"<n><unit>\" with unit h hours, d trading days, w weeks, m months, y years, e.g. two years -> \"2y\", ten days -> "
    "\"10d\", a quarter -> \"3m\", or null if no period was given), \"new\" (the user describes an investment to make "
    "instead), \"cancel\" (the user no longer wants the forecast), \"other\" (anything else). sentences: plain "
    "{language}, at most two short sentences, no digits; required only for other, where it gently brings them back. "
    "Never recommend buying or selling, never promise returns."
)
FORECAST_NEED = {"tickers": "which stocks to look at", "horizon": "how long they plan to hold, i.e. the forecast period"}


class ChatError(RuntimeError):
    pass


def _tidy(text: str) -> str:
    """A placeholder already carries its unit; drop a unit the model repeated after it ('300만 원 원' -> '300만 원',
    '$2,158 dollars' -> '$2,158', '$2,158美元' -> '$2,158')."""
    text = re.sub(r"(원|%|년|차례|종목|年|轮)\s?\1", r"\1", text)
    text = re.sub(r"(\$[\d,]+(?:\.\d+)?)\s*(?:US dollars|dollars|USD|美元|元)", r"\1", text)
    return re.sub(r"%\s*(?:percent|个百分点)", "%", text)


class Chat:
    def __init__(self, db: Database, ledger: Ledger, kiln: Kiln, briefs: Briefs, runner, executor, asker):
        self.db = db
        self.ledger = ledger
        self.kiln = kiln
        self.briefs = briefs
        self.runner = runner
        self.executor = executor
        self.asker = asker

    # ---------------------------------------------------------------- facts
    def facts(self, stage: str, wallet: str, refs: dict) -> tuple[dict, dict]:
        """What the model may know right now: a summary of the user's current step, no digits, placeholders for values."""
        facts: dict[str, str] = {"stage": stage}
        values: dict[str, str] = {}
        brief = self.briefs.get(refs["brief_id"]) if refs.get("brief_id") else None
        if brief:
            names = self._names(brief)
            fx = brief.get("fx_krw_per_usdc")
            values.update(budget=i18n.money(brief["budget_krw"] or 0, fx), max_weight=pct(float(brief["max_weight"]), signed=False),
                          min_cash=pct(float(brief["min_cash"]), signed=False))
            facts["conditions"] = (f"budget {{budget}}; stocks {', '.join(names)}; sector ids {', '.join(brief['universe']['sectors']) or 'none'}; "
                                   f"excluded {', '.join(brief['universe']['exclude']) or 'none'}; one stock at most {{max_weight}}; "
                                   f"keep cash at least {{min_cash}}; strategy {TEMPLATE_KO.get(brief['template'], brief['template'])}; "
                                   f"rebalanced {brief['rebalance']}; "
                                   f"leveraged products {'excluded' if brief['exclude_leveraged'] else 'allowed'}")
            facts["conditions_status"] = "confirmed by the user" if brief["status"] == "confirmed" else "draft, not confirmed yet"
            if brief.get("guessed"):
                facts["values_the_app_guessed_please_confirm"] = ", ".join(FIELD_KO.get(g, g) for g in brief["guessed"])
            if brief.get("questions"):
                facts["open_questions_to_the_user"] = " / ".join(brief["questions"])
        run = None
        if refs.get("run_id"):
            try:
                run = self.runner.get(refs["run_id"])
            except KeyError:
                run = None
        if run and run.get("status") == "done":
            facts["check_result"] = VERDICT_KO.get(run.get("verdict"), run.get("verdict") or "")
            facts["checks"] = "; ".join(f"{c['label_ko']}: {VERDICT_KO.get(c['status'], c['status'])} ({no_digits(c.get('detail_ko', ''))[:90]})"
                                        for c in run.get("checks", []))
            if run.get("xtxc") and brief:
                f2, v2 = explain_inputs(self.briefs.get(run["brief_id"], run["brief_version"]), run)
                facts.update({f"past_{k}": v for k, v in f2.items() if k != "strategy"})
                values.update(v2)
            if run.get("counter_opinions_ko"):
                facts["when_it_could_lose"] = " / ".join(no_digits(x) for x in run["counter_opinions_ko"])
        plan = None
        if refs.get("plan_id"):
            try:
                plan = self.executor.plan(refs["plan_id"])
            except Exception:
                plan = None
        if plan:
            buys = sum(o["krw"] for o in plan["orders"] if o["side"] == "BUY")
            sells = sum(o["krw"] for o in plan["orders"] if o["side"] == "SELL")
            fx = plan.get("fx_krw_per_usdc")
            values.update(plan_buy=i18n.money(buys, fx), plan_sell=i18n.money(sells, fx), plan_cost=i18n.money(plan.get("cost_krw_est") or 0, fx),
                          cash_after=i18n.money(plan.get("cash_after_krw") or 0, fx), order_count=tr("unit.stocks", n=len(plan["orders"])))
            facts["order_plan"] = (f"{{order_count}}: buy {{plan_buy}}" + (", sell {plan_sell}" if sells else "")
                                   + "; estimated trading cost {plan_cost}; cash left {cash_after}")
            facts["stocks_in_order"] = ", ".join(f"{self._name(o['ticker'])} {'buy' if o['side'] == 'BUY' else 'sell'}"
                                                 + (" (split buying)" if o.get("slicing") else "") for o in plan["orders"])
            facts["approval_level"] = TIER_KO.get(plan["tier"], plan["tier"])
            facts["safety_lights"] = "; ".join(f"{l['label_ko']}: {l['status']} ({no_digits(l['detail_ko'])[:80]})" for l in plan["lights"])
            facts["ways_to_approve"] = ", ".join(MODE_KO.get(m, m) for m in plan["mode_options"]) or "none (blocked)"
            if plan.get("blocked_reasons_ko"):
                facts["why_blocked"] = no_digits("; ".join(plan["blocked_reasons_ko"]))
            if plan.get("slicing_note_ko"):
                facts["split_buying"] = no_digits(plan["slicing_note_ko"])
            im = plan.get("immediate")
            if im:
                values["extra_cost_at_once"] = i18n.money(im.get("extra_cost_krw") or 0, fx)
                facts["buying_all_at_once"] = ("allowed, costs about {extra_cost_at_once} more than split buying, needs the user's explicit check"
                                               if im["available"] else f"not allowed: {no_digits(im.get('reason_ko') or '')}")
            facts["how_approval_works"] = "the user checks the approval card, slides to approve, then signs in the wallet; the assistant cannot approve"
        if stage == "waiting":
            rows = self.db.all("SELECT mode, status, body FROM prepared WHERE wallet = ? AND status IN ('presigned_waiting','notify_waiting','notify_ready')", (wallet,))
            for tag, r in zip("abc", rows[:3]):          # placeholder names are letters only
                b = json.loads(r["body"])
                state = b.get("group_state") or []
                done = sum(1 for x in state if x == "filled")
                values[f"waiting_{tag}_done"], values[f"waiting_{tag}_total"] = tr("unit.rounds", n=done), tr("unit.rounds", n=len(state))
                nxt = (b.get("last_wait") or {}).get("reason_ko") or tr("chat.waiting.default")
                facts[f"waiting_order_{tag}"] = (f"{MODE_KO.get(r['mode'], r['mode'])}: {{waiting_{tag}_done}} of {{waiting_{tag}_total}} done; "
                                                 f"now: {no_digits(nxt)}")
            facts["how_to_stop"] = "the Stop all button voids every waiting signed order with one wallet signature"
        if refs.get("receipt_id") or stage == "receipt":
            f3, v3 = self.asker._facts(wallet, refs.get("receipt_id"))
            facts.update({f"receipt_{k}": v for k, v in f3.items()})
            values.update(v3)
        facts["glossary"] = " | ".join(f"{k}: {v}" for k, v in i18n.glossary().items())
        return facts, values

    def _name(self, ticker: str) -> str:
        universe, _ = self.briefs._index()
        return i18n.stock_name(universe.get(ticker), ticker)

    def _names(self, brief: dict) -> list[str]:
        return [f"{self._name(t)}({t})" for t in brief["universe"]["tickers"]]

    # ------------------------------------------------------------ validation
    def _validator(self, stage: str, brief: dict | None, allowed: set[str]):
        universe, index = self.briefs._index()

        def validate(answer):
            if not isinstance(answer, dict) or set(answer) != {"intent", "changes", "sentences"}:
                raise ValueError("reply must be exactly {\"intent\": ..., \"changes\": ..., \"sentences\": [...]}")
            intent = answer["intent"]
            if intent not in INTENTS:
                raise ValueError(f"intent must be one of {list(INTENTS)}")
            sentences = answer["sentences"]
            if not isinstance(sentences, list) or len(sentences) > 3 or not all(isinstance(s, str) and 2 <= len(s) <= 160 for s in sentences):
                raise ValueError("sentences must be an array of at most three short strings")
            if intent in ("question", "other") and not sentences:
                raise ValueError("a question or other message needs at least one sentence")
            for i, s in enumerate(sentences, 1):
                unknown = set(PLACEHOLDER.findall(s)) - allowed
                if unknown:
                    raise ValueError(f"sentence {i} uses unknown placeholders {sorted(unknown)}; use only the listed ones")
                digits = DIGIT.findall(PLACEHOLDER.sub("", s))
                if digits:
                    raise ValueError(f"digits are not allowed outside placeholders: sentence {i} contains {''.join(digits)!r}. "
                                     f"Rewrite it with a listed placeholder or plain words")
            changes = answer["changes"]
            if intent == "forecast":
                return {"intent": intent, "changes": validate_forecast_request(changes, set(universe)), "sentences": sentences}
            if intent != "edit":
                if changes not in (None, {}):
                    raise ValueError("changes must be null unless intent is edit")
                return {"intent": intent, "changes": None, "sentences": sentences}
            if not isinstance(changes, dict) or not changes:
                raise ValueError("an edit needs the changed fields in changes")
            if "budget_usd" in changes:              # code converts dollars to the internal won budget
                usd = changes.pop("budget_usd")
                if not isinstance(usd, int) or not 10 <= usd <= 10_000_000:
                    raise ValueError("budget_usd must be an integer between 10 and 10,000,000")
                changes["budget_krw"] = int(Decimal(usd) * Decimal(brief.get("fx_krw_per_usdc") or i18n.DEFAULT_FX))
            unknown = set(changes) - EDITABLE
            if unknown:
                raise ValueError(f"changes may only use {sorted(EDITABLE)}; not {sorted(unknown)}")
            if brief is None:
                raise ValueError("there are no conditions to edit yet; use intent new")
            fields = {"budget_krw": brief["budget_krw"], "sectors": brief["universe"]["sectors"], "tickers": brief["universe"]["explicit"],
                      "exclude": brief["universe"]["exclude"], "max_weight": brief["max_weight"], "min_cash": brief["min_cash"],
                      "rebalance": brief["rebalance"], "template": brief["template"], "exclude_leveraged": brief["exclude_leveraged"]}
            candidate = {**fields, **changes, "questions": []}
            validate_brief(candidate, set(universe), set(index))           # same rules as the first compile
            if candidate["rebalance"] not in REBALANCE or candidate["template"] not in TEMPLATES:
                raise ValueError("rebalance and template must be set")
            if set(changes) & {"tickers", "sectors", "exclude"}:
                # the stock list must actually change the way the user asked (e.g. removing a sector stock needs exclude)
                def final(f):
                    chosen = list(f["tickers"]) + [t for sec in f["sectors"] for t in index.get(sec, [])]
                    return sorted({t for t in chosen if t not in f["exclude"]})
                if final(candidate) == final(fields):
                    raise ValueError("these changes leave the stock list exactly as it is; to remove a stock that comes from a sector "
                                     "put it in exclude, to add one put it in tickers")
            same = [k for k in changes if changes[k] == fields.get(k) or str(changes[k]) == str(fields.get(k))]
            for k in same:
                changes.pop(k)
            # the user restated what is already set: nothing to change (answered by code, no retry)
            return {"intent": intent, "changes": changes, "sentences": sentences}

        return validate, index

    # ------------------------------------------------------------------ turn
    def turn(self, wallet: str, message: str, stage: str, refs: dict) -> dict:
        message = (message or "").strip()
        if not 1 <= len(message) <= 300:
            raise ChatError(tr("chat.err.length"))
        if stage not in STAGES:
            raise ChatError(tr("chat.err.stage"))
        if stage == "forecast":
            return self._forecast_turn(wallet, message, refs)
        if stage == "start" or not refs.get("brief_id"):
            return self._new(wallet, message, refs)
        brief = self.briefs.get(refs["brief_id"])
        facts, values = self.facts(stage, wallet, refs)
        allowed = set(values)
        validate, index = self._validator(stage, brief, allowed)
        ids = ", ".join("{" + v + "}" for v in sorted(allowed)) or "(none)"
        compact = "; ".join(f"{s}: {' '.join(t)}" for s, t in sorted(index.items()))
        messages = [
            {"role": "system", "content": CHAT_SYSTEM.format(stage=stage, ids=ids, language=i18n.LANG_NAME[i18n.lang()])
             + " Sector ids and tickers: " + compact},
            {"role": "user", "content": "Facts:\n" + "\n".join(f"- {k}: {no_digits(v)}" for k, v in facts.items())
             + f"\n\nUser message: {message}"},
        ]
        try:
            result = self.kiln.complete_json("chat_turn", messages, validate, thinking=False, max_tokens=350,
                                             wallet=wallet, ref=refs.get("plan_id") or refs.get("run_id") or refs["brief_id"])
        except (ModelUnavailable, ModelOutputInvalid):
            return {"intent": "unknown", "reply_ko": tr("chat.ai_down"), "action": {"type": "none"},
                    "ai": {"available": False}}
        value = result.value
        ai = {"call_id": result.call_id, "cache_hit": result.cache_hit, "input_tokens": result.usage.get("input_tokens", 0),
              "output_tokens": result.usage.get("output_tokens", 0), "cost_usd": result.usage.get("cost_usd", 0.0)}
        said = i18n.tidy(_tidy(i18n.sentences(fill(value["sentences"], values))))
        intent = value["intent"]
        if intent == "new":
            out = self._new(wallet, message)
            out["ai"] = {**out.get("ai", {}), "routed_by": ai}
            return out
        if intent == "forecast":
            return self._forecast(value["changes"]["tickers"], value["changes"]["horizon"], refs, ai)
        if intent == "edit":
            if not value["changes"]:
                return {"intent": "edit", "reply_ko": tr("chat.edit.same"), "action": {"type": "none"}, "ai": ai}
            return self._edit(wallet, stage, brief, value["changes"], said, ai)
        if intent == "question":
            self.ledger.append("ask", tr("ledger.ask", q=message[:60]), wallet=wallet, ref=refs.get("receipt_id") or refs.get("plan_id") or refs["brief_id"],
                               payload={"question": message, "answer": said, "stage": stage, "ai_call_id": result.call_id})
            return {"intent": intent, "reply_ko": said, "action": {"type": "none"}, "ai": ai}
        if intent == "stop":
            return {"intent": intent, "reply_ko": tr("chat.stop"),
                    "action": {"type": "confirm_stop"}, "ai": ai}
        if intent == "proceed":
            return {"intent": intent, **self._next(stage, refs), "ai": ai}
        return {"intent": "other", "reply_ko": said, "action": {"type": "none"}, "ai": ai}

    def _new(self, wallet: str, message: str, refs: dict | None = None) -> dict:
        try:
            brief = self.briefs.create(message, wallet, allow_forecast=True)
        except BriefError as exc:
            raise ChatError(str(exc)) from exc
        if brief.get("kind") == "forecast":
            ai = {"call_id": brief.get("ai_call_id"), "cache_hit": brief.get("ai_cache_hit")}
            return self._forecast(brief["forecast"]["tickers"], brief["forecast"]["horizon"], refs or {}, ai)
        guessed = [FIELD_KO.get(g, g) for g in brief.get("guessed", [])]
        reply = tr("chat.new")
        if guessed:
            reply += tr("chat.new.guessed", fields=topic(i18n.join(guessed)))
        return {"intent": "new", "reply_ko": reply, "action": {"type": "brief_created"}, "brief": brief,
                "ai": {"call_id": brief.get("ai_call_id"), "cache_hit": brief.get("ai_cache_hit")}}

    # ------------------------------------------------------------ 변동 예측: the agent asks for what is missing
    def _brief_tickers(self, refs: dict) -> list[str]:
        if not refs.get("brief_id"):
            return []
        try:
            b = self.briefs.get(refs["brief_id"])
        except Exception:
            return []
        return [t for t in b["universe"]["tickers"] if t not in b["universe"].get("exclude", [])]

    def _forecast(self, tickers: list[str], horizon: str | None, refs: dict, ai: dict) -> dict:
        from .forecasts import horizon_choices, horizon_label
        tickers = list(tickers or []) or self._brief_tickers(refs)
        note = ""
        if len(tickers) > FORECAST_MAX_TICKERS:
            tickers, note = tickers[:FORECAST_MAX_TICKERS], tr("fc.err.too_many", n=FORECAST_MAX_TICKERS) + " "
        if not tickers:
            return {"intent": "forecast", "reply_ko": tr("fc.ask.tickers", n=FORECAST_MAX_TICKERS),
                    "action": {"type": "forecast_ask", "need": "tickers", "tickers": [], "horizon": horizon}, "ai": ai}
        names = i18n.join(i18n.with_ticker(self._name(t), t) for t in tickers)
        if not horizon:
            return {"intent": "forecast", "reply_ko": note + tr("fc.ask.horizon", names=i18n.obj(names)),
                    "action": {"type": "forecast_ask", "need": "horizon", "tickers": tickers, "horizon": None,
                               "choices": horizon_choices()}, "ai": ai}
        return {"intent": "forecast", "reply_ko": note + tr("fc.ready", h=horizon_label(horizon)),
                "action": {"type": "forecast_ready", "tickers": tickers, "horizon": horizon}, "ai": ai}

    def _forecast_turn(self, wallet: str, message: str, refs: dict) -> dict:
        """The agent asked for stocks or a period; one model call reads the answer."""
        fc = refs.get("forecast") if isinstance(refs.get("forecast"), dict) else {}
        universe, index = self.briefs._index()
        known_t = [t for t in (fc.get("tickers") or []) if t in universe][:FORECAST_MAX_TICKERS]
        known_h = fc.get("horizon") if isinstance(fc.get("horizon"), str) else None
        need = "tickers" if not known_t and not self._brief_tickers(refs) else "horizon"

        def validate(answer):
            if not isinstance(answer, dict) or set(answer) != {"intent", "tickers", "horizon", "sentences"}:
                raise ValueError('reply must be exactly {"intent": ..., "tickers": [...], "horizon": ..., "sentences": [...]}')
            if answer["intent"] not in ("forecast", "new", "cancel", "other"):
                raise ValueError("intent must be forecast, new, cancel or other")
            sentences = answer["sentences"]
            if not isinstance(sentences, list) or len(sentences) > 2 or not all(isinstance(x, str) and 2 <= len(x) <= 160 for x in sentences):
                raise ValueError("sentences must be an array of at most two short strings")
            if answer["intent"] == "other" and not sentences:
                raise ValueError("other needs one sentence")
            for i, x in enumerate(sentences, 1):
                if DIGIT.findall(x):
                    raise ValueError(f"digits are not allowed: sentence {i}")
            got = validate_forecast_request({"tickers": answer["tickers"] or [], "horizon": answer["horizon"]}, set(universe))
            return {**answer, **got}

        compact = "; ".join(f"{s}: {' '.join(t)}" for s, t in sorted(index.items()))
        names = {t: getattr(i, "name_short_en", "") or getattr(i, "name_en", "") for t, i in universe.items()}
        pairs = " ".join(f"{t}={names[t]}" for t in sorted(universe) if names.get(t))
        messages = [
            {"role": "system", "content": FORECAST_SYSTEM.format(language=i18n.LANG_NAME[i18n.lang()],
                                                                 need=FORECAST_NEED[need]) + " Tickers: " + pairs + ". Sectors: " + compact},
            {"role": "user", "content": f"Known so far: stocks {', '.join(known_t) or 'none'}; period {known_h or 'none'}.\n"
                                        f"User message: {message}"},
        ]
        try:
            result = self.kiln.complete_json("forecast_turn", messages, validate, thinking=False, max_tokens=200, wallet=wallet,
                                             ref=refs.get("brief_id") or "forecast")
        except (ModelUnavailable, ModelOutputInvalid):
            return {"intent": "unknown", "reply_ko": tr("chat.ai_down"), "action": {"type": "none"}, "ai": {"available": False}}
        v = result.value
        ai = {"call_id": result.call_id, "cache_hit": result.cache_hit, "input_tokens": result.usage.get("input_tokens", 0),
              "output_tokens": result.usage.get("output_tokens", 0), "cost_usd": result.usage.get("cost_usd", 0.0)}
        if v["intent"] == "new":
            out = self._new(wallet, message, {k: x for k, x in refs.items() if k != "forecast"})
            out["ai"] = {**out.get("ai", {}), "routed_by": ai}
            return out
        if v["intent"] == "cancel":
            return {"intent": "forecast", "reply_ko": tr("fc.cancel"), "action": {"type": "forecast_cancel"}, "ai": ai}
        if v["intent"] == "other":
            again = self._forecast(known_t, known_h, refs, ai)
            again["reply_ko"] = i18n.sentences([i18n.sentences(v["sentences"]), again["reply_ko"]])
            again["intent"] = "other"
            return again
        return self._forecast(v["tickers"] or known_t, v["horizon"] or known_h, refs, ai)

    def _edit(self, wallet: str, stage: str, brief: dict, changes: dict, said: str, ai: dict) -> dict:
        if stage == "waiting":
            return {"intent": "edit", "reply_ko": tr("chat.edit.waiting"),
                    "action": {"type": "none"}, "ai": ai}
        try:
            updated = self.briefs.patch(brief["brief_id"], dict(changes), wallet)
        except BriefError as exc:
            return {"intent": "edit", "reply_ko": tr("chat.edit.refused", e=exc), "action": {"type": "none"}, "ai": ai}
        universe, _ = self.briefs._index()
        names = {t: i18n.stock_name(i, t) for t, i in universe.items()}
        diff = [self._diff(k, brief, updated, names) for k in sorted(changes)]
        reply = tr("chat.edit.done", diff=i18n.join(d for d in diff if d))
        if stage != "brief":
            reply += tr("chat.edit.recheck")
        return {"intent": "edit", "reply_ko": reply, "action": {"type": "brief_updated", "recheck": stage != "brief",
                                                               "changed": sorted(changes)}, "brief": updated, "ai": ai}

    @staticmethod
    def _diff(key: str, old: dict, new: dict, names: dict) -> str:
        label = FIELD_KO.get(key, key)
        if key == "budget_krw":
            fx = new.get("fx_krw_per_usdc")
            return f"{label} {i18n.money(old['budget_krw'] or 0, fx)} → {i18n.money(new['budget_krw'] or 0, fx)}"
        if key in ("max_weight", "min_cash"):
            return f"{label} {Decimal(old[key]) * 100:.0f}% → {Decimal(new[key]) * 100:.0f}%"
        if key == "rebalance":
            return f"{label} {tr('period.' + new[key])}"
        if key == "template":
            return f"{label} {TEMPLATE_KO.get(new[key], new[key])}"
        if key == "exclude_leveraged":
            return f"{label} {tr('word.on') if new[key] else tr('word.off')}"
        if key == "sectors":
            return f"{label} {i18n.join(SECTOR_KO.get(s, s) for s in new['universe']['sectors']) or tr('word.none')}"
        if key == "tickers":
            return f"{label} {i18n.join(names.get(t, t) for t in new['universe']['tickers'])}"
        if key == "exclude":
            return f"{label} {i18n.join(names.get(t, t) for t in new['universe']['exclude']) or tr('word.none')}"
        return label

    @staticmethod
    def _next(stage: str, refs: dict) -> dict:
        """What 'proceed' means at each stage. Nothing here sends an order."""
        if stage == "brief":
            return {"reply_ko": tr("chat.next.brief"), "action": {"type": "confirm_and_research"}}
        if stage == "research":
            return {"reply_ko": tr("chat.next.research"), "action": {"type": "make_plan"}}
        if stage == "plan":
            return {"reply_ko": tr("chat.next.plan"),
                    "action": {"type": "open_approval"}}
        if stage == "waiting":
            return {"reply_ko": tr("chat.next.waiting"), "action": {"type": "show_progress"}}
        return {"reply_ko": tr("chat.next.receipt"), "action": {"type": "new_strategy"}}
