"""Investment conditions (투자 조건). The model drafts; code applies defaults,
marks every guessed field, validates, and versions. Only the user confirms."""

from __future__ import annotations

import json
from decimal import Decimal

from .config import Settings
from .db import Database, dumps, new_id, now_iso
from .kiln import Kiln
from .ledger import Ledger
from . import i18n
from .i18n import tr
from .orders import krw_to_usdc_atoms
from .prompts import BRIEF_DEFAULTS, REBALANCE, TEMPLATES, brief_messages, validate_brief

# Name tables in the current display language (historical names kept for the modules that import them).
SECTOR_KO = i18n.Names("sector")
TEMPLATE_KO = i18n.Names("template")
FIELD_KO = i18n.Names("field")
EDITABLE = {"budget_krw", "sectors", "tickers", "exclude", "max_weight", "min_cash", "rebalance", "template", "exclude_leveraged"}


class BriefError(RuntimeError):
    pass


class Briefs:
    def __init__(self, settings: Settings, db: Database, ledger: Ledger, kiln: Kiln, universe_fn):
        self.s = settings
        self.db = db
        self.ledger = ledger
        self.kiln = kiln
        self.universe_fn = universe_fn  # () -> {ticker: Instrument}

    def _index(self):
        universe = self.universe_fn()
        index: dict[str, list[str]] = {}
        for t, inst in universe.items():
            index.setdefault(inst.sector, []).append(t)
        return universe, {k: sorted(v) for k, v in index.items()}

    def _resolve(self, fields: dict, guessed: list[str], questions: list[str], source_text: str) -> dict:
        universe, index = self._index()
        explicit = list(dict.fromkeys(fields.get("tickers") or []))
        sectors = list(dict.fromkeys(fields.get("sectors") or []))
        exclude = list(dict.fromkeys(fields.get("exclude") or []))
        chosen = list(dict.fromkeys(explicit + [t for s in sectors for t in index.get(s, [])]))
        removed_leveraged = []
        if fields.get("exclude_leveraged"):
            removed_leveraged = [t for t in chosen if getattr(universe.get(t), "kind", "") == "leveraged_etf"]
        final = [t for t in chosen if t not in exclude and t not in removed_leveraged]
        questions = list(questions)
        if not final:
            questions.append(tr("brief.q.what"))
        if fields.get("budget_krw") is None:
            questions.append(tr("brief.q.budget"))
        mw, mc = Decimal(fields["max_weight"]), Decimal(fields["min_cash"])
        if final and mw * len(final) < (1 - mc) - Decimal("0.0001"):
            questions.append(tr("brief.q.cap", n=len(final), mw=f"{mw * 100:.0f}", tot=f"{(mw * len(final)) * 100:.0f}"))
        budget = fields.get("budget_krw")
        return {
            "source_text": source_text, "budget_krw": budget, "fx_krw_per_usdc": self.s.fx_krw_per_usdc,
            "budget_usdc_atoms": str(krw_to_usdc_atoms(budget, self.s.fx_krw_per_usdc)) if budget else None,
            "universe": {"sectors": sectors, "tickers": final, "exclude": exclude, "explicit": explicit, "removed_leveraged": removed_leveraged},
            # names for every ticker the card mentions: chosen, explicitly named and excluded
            "names_ko": {t: i18n.stock_name(universe.get(t), t) for t in dict.fromkeys(final + explicit + exclude + removed_leveraged)},
            "lang": i18n.lang(),
            "max_weight": fields["max_weight"], "min_cash": fields["min_cash"], "rebalance": fields["rebalance"],
            "template": fields["template"], "exclude_leveraged": bool(fields["exclude_leveraged"]), "benchmark": "QQQ",
            "guessed": sorted(set(guessed)), "questions": list(dict.fromkeys(questions))[:3],
            "title_ko": self.title(sectors, [i18n.stock_name(universe.get(t), t) for t in explicit], fields["template"]),
        }

    @staticmethod
    def title(sectors, explicit_names, template) -> str:
        if sectors:
            head = " · ".join(SECTOR_KO.get(s, s) for s in sectors)
        elif explicit_names:
            head = " · ".join(explicit_names[:3]) + (tr("brief.title.more") if len(explicit_names) > 3 else "")
        else:
            head = tr("brief.title.mine")
        return f"{head} {TEMPLATE_KO.get(template, template)}"

    def _store(self, brief_id: str, version: int, wallet: str | None, status: str, body: dict) -> dict:
        body = {**body, "brief_id": brief_id, "version": version, "status": status, "wallet": wallet}
        self.db.execute("INSERT INTO briefs(brief_id, version, wallet, status, body, created_at) VALUES (?,?,?,?,?,?)",
                        (brief_id, version, wallet, status, dumps(body), now_iso()))
        return body

    def get(self, brief_id: str, version: int | None = None) -> dict:
        if version is None:
            row = self.db.one("SELECT body, status FROM briefs WHERE brief_id = ? ORDER BY version DESC LIMIT 1", (brief_id,))
        else:
            row = self.db.one("SELECT body, status FROM briefs WHERE brief_id = ? AND version = ?", (brief_id, version))
        if not row:
            raise BriefError("brief not found")
        return {**json.loads(row["body"]), "status": row["status"]}

    # ------------------------------------------------------------ actions
    def create(self, text: str, wallet: str | None, *, allow_forecast: bool = False) -> dict:
        """A new draft. With allow_forecast, a "how much could it move" question comes back as
        {"kind": "forecast", "forecast": {...}} instead (nothing is stored)."""
        text = (text or "").strip()
        if not 2 <= len(text) <= 1000:
            raise BriefError(tr("err.brief.length"))
        universe, index = self._index()
        brief_id = new_id("b")
        result = self.kiln.complete_json(
            "brief_compile", brief_messages(text, index, {t: getattr(i, "name_short_en", "") or getattr(i, "name_en", "")
                                                          for t, i in universe.items()}),
            lambda a: validate_brief(a, set(universe), set(index)),
            thinking=False, max_tokens=400, wallet=wallet, ref=brief_id,
        )
        answer = dict(result.value)
        if "forecast" in answer:
            if not allow_forecast:
                raise BriefError(tr("err.brief.is_forecast"))
            return {"kind": "forecast", "forecast": answer["forecast"], "ai_call_id": result.call_id, "ai_cache_hit": result.cache_hit}
        guessed = [k for k, v in BRIEF_DEFAULTS.items() if answer.get(k) is None]
        for k, v in BRIEF_DEFAULTS.items():
            if answer.get(k) is None:
                answer[k] = v
        body = self._resolve(answer, guessed, answer.get("questions", []), text)
        body["ai_call_id"] = result.call_id
        body["ai_cache_hit"] = result.cache_hit
        brief = self._store(brief_id, 1, wallet, "draft", body)
        self.ledger.append("brief.drafted", tr("ledger.brief.drafted", title=brief["title_ko"]), wallet=wallet, ref=brief_id,
                           payload={"version": 1, "guessed": brief["guessed"], "ai_call_id": result.call_id})
        return brief

    def patch(self, brief_id: str, changes: dict, wallet: str | None) -> dict:
        current = self.get(brief_id)
        unknown = set(changes) - EDITABLE
        if unknown:
            raise BriefError(tr("err.brief.not_editable", fields=", ".join(sorted(unknown))))
        universe, index = self._index()
        fields = {k: current[k] for k in ("budget_krw", "max_weight", "min_cash", "rebalance", "template", "exclude_leveraged")}
        fields.update({"sectors": current["universe"]["sectors"], "tickers": current["universe"]["explicit"], "exclude": current["universe"]["exclude"]})
        fields.update(changes)
        candidate = {"budget_krw": fields["budget_krw"], "sectors": fields["sectors"], "tickers": fields["tickers"], "exclude": fields["exclude"],
                     "max_weight": fields["max_weight"], "min_cash": fields["min_cash"], "rebalance": fields["rebalance"],
                     "template": fields["template"], "exclude_leveraged": fields["exclude_leveraged"], "questions": []}
        try:
            checked = validate_brief(candidate, set(universe), set(index))
        except ValueError as exc:
            raise BriefError(str(exc)) from exc
        if checked["rebalance"] not in REBALANCE or checked["template"] not in TEMPLATES:
            raise BriefError(tr("err.brief.pick"))
        guessed = [g for g in current["guessed"] if g not in changes]
        body = self._resolve(checked, guessed, [], current["source_text"])
        body["edited_fields"] = sorted(changes)
        version = current["version"] + 1
        brief = self._store(brief_id, version, wallet, "draft", body)
        self.ledger.append("brief.edited", tr("ledger.brief.edited", fields=i18n.join(FIELD_KO.get(c, c) for c in sorted(changes))),
                           wallet=wallet, ref=brief_id,
                           payload={"version": version, "changes": changes})
        return brief

    def confirm(self, brief_id: str, wallet: str | None) -> dict:
        brief = self.get(brief_id)
        if not brief["budget_krw"] or not brief["universe"]["tickers"]:
            raise BriefError(tr("err.brief.need_budget"))
        self.db.execute("UPDATE briefs SET status = 'confirmed', body = json_set(body, '$.status', 'confirmed') WHERE brief_id = ? AND version = ?",
                        (brief_id, brief["version"]))
        brief["status"] = "confirmed"
        superseded = self.db.all("SELECT plan_id FROM plans WHERE json_extract(body,'$.brief_id') = ? AND json_extract(body,'$.brief_version') < ?"
                                 " AND status IN ('shown','waiting','ready')", (brief_id, brief["version"]))
        for r in superseded:
            self.db.execute("UPDATE plans SET status = 'superseded', updated_at = ? WHERE plan_id = ?", (now_iso(), r["plan_id"]))
        summary = tr("ledger.brief.confirmed", v=brief["version"], budget=i18n.money(brief["budget_krw"], brief.get("fx_krw_per_usdc")),
                     n=len(brief["universe"]["tickers"]), mw=f"{Decimal(brief['max_weight']) * 100:.0f}",
                     mc=f"{Decimal(brief['min_cash']) * 100:.0f}")
        self.ledger.append("brief.confirmed", summary, wallet=wallet, ref=brief_id,
                           payload={"version": brief["version"], "conditions": {k: brief[k] for k in ("budget_krw", "max_weight", "min_cash", "rebalance", "template", "exclude_leveraged")},
                                    "tickers": brief["universe"]["tickers"], "superseded_plans": [r["plan_id"] for r in superseded]})
        return brief
