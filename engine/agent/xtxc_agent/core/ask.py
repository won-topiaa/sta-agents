"""'왜 이렇게 됐어?' — answers questions about the user's own records only.

The model sees the recorded facts (no digits) and placeholder names; code fills
the numbers. Every question and answer is itself recorded in the ledger.
"""

from __future__ import annotations

import json

from .db import Database
from .kiln import Kiln
from .ledger import Ledger
from . import i18n
from .i18n import tr
from .prompts import QA_SYSTEM, no_digits, validate_sentences

STATUS_KO = i18n.Names("status")


class Asker:
    def __init__(self, db: Database, ledger: Ledger, kiln: Kiln):
        self.db = db
        self.ledger = ledger
        self.kiln = kiln

    def _facts(self, wallet: str, receipt_id: str | None) -> tuple[dict, dict]:
        facts: dict[str, str] = {}
        values: dict[str, str] = {}
        if receipt_id:
            row = self.db.one("SELECT body FROM receipts WHERE receipt_id = ? AND wallet = ?", (receipt_id, wallet))
            if row:
                rc = json.loads(row["body"])
                plan = json.loads(self.db.one("SELECT body FROM plans WHERE plan_id = ?", (rc["plan_id"],))["body"])
                facts["strategy"] = rc.get("strategy", "")
                facts["plan"] = plan.get("headline_ko", "")
                facts["approval_tier"] = i18n.label("tier", plan["tier"])
                facts["checks_at_approval"] = "; ".join(f"{l['label_ko']}: {l['status']}" for l in plan["lights"])
                facts["results"] = ", ".join(f"{r['name_ko']} {STATUS_KO.get(r['status'], r['status'])}" for r in rc["results"])
                facts["total_cost_vs_stock_price"] = "{cost_krw}"
                facts["approved_at"] = "{approved_at}"
                facts["transaction_record"] = "plan hash written inside the trade as a memo" if rc["chain"].get("memo_on_chain") else "no memo found"
                values.update(cost_krw=i18n.money(rc["cost_krw"], plan.get("fx_krw_per_usdc")), approved_at=rc["approved_at"][:16].replace("T", " ") + " UTC")
                for i, r in enumerate(rc["results"]):
                    key = f"order_{i}_min_received_kept"
                    if r.get("received_atoms") and r.get("min_out_atoms"):
                        facts[key] = f"{r['name_ko']}: received at least the promised minimum = {int(r['received_atoms']) >= int(r['min_out_atoms'])}"
        events = self.db.all("SELECT type, summary_ko FROM events WHERE wallet = ? ORDER BY seq DESC LIMIT 12", (wallet,))
        facts["recent_records_newest_first"] = " | ".join(f"{e['type']}: {e['summary_ko']}" for e in events)
        return facts, values

    def ask(self, wallet: str, question: str, receipt_id: str | None = None) -> dict:
        question = (question or "").strip()
        if not 2 <= len(question) <= 300:
            raise ValueError(tr("err.ask.length"))
        facts, values = self._facts(wallet, receipt_id)
        allowed = set(values)
        ids = ", ".join("{" + v + "}" for v in sorted(allowed)) or "(none)"
        messages = [
            {"role": "system", "content": QA_SYSTEM.replace("{language}", i18n.LANG_NAME[i18n.lang()]).replace("{\"answer\": \"...\"}", "{\"sentences\": [\"...\"]}")
             + f" Placeholders you may copy exactly: {ids}. Write one to three sentences."},
            {"role": "user", "content": "Facts:\n" + "\n".join(f"- {k}: {no_digits(v)}" for k, v in facts.items())
             + f"\n\nQuestion: {no_digits(question)}"},
        ]
        result = self.kiln.complete_json("answer_question", messages, lambda a: validate_sentences(a, "sentences", allowed, 1, 3),
                                         thinking=False, max_tokens=300, wallet=wallet, ref=receipt_id)
        from .prompts import fill
        answer = i18n.tidy(i18n.sentences(fill(result.value, values)))
        self.ledger.append("ask", tr("ledger.ask", q=question[:60]), wallet=wallet, ref=receipt_id,
                           payload={"question": question, "answer": answer, "ai_call_id": result.call_id})
        return {"answer_ko": answer, "grounded_on": sorted(facts), "ai_call_id": result.call_id, "cache_hit": result.cache_hit}
