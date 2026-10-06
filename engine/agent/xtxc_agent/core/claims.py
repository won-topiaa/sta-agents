"""AI 성적표: every number the agent tells the user is a claim that gets scored.

A claim is recorded when a plan is shown (predicted cost, token premium,
expected quantity). When the chain result arrives the claim is resolved
against what actually happened. Misses stay visible; nothing is deleted.
"""

from __future__ import annotations

from .db import Database, new_id, now_iso


class Claims:
    def __init__(self, db: Database):
        self.db = db

    def add(self, *, wallet: str, plan_id: str, subject: str, metric: str, predicted: float,
            tolerance: float, unit: str, statement_ko: str, ref: str | None = None) -> dict:
        claim_id = new_id("c")
        self.db.execute(
            "INSERT INTO claims(claim_id, wallet, plan_id, subject, metric, predicted, tolerance, unit, statement_ko, created_at, ref)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (claim_id, wallet, plan_id, subject, metric, float(predicted), float(tolerance), unit, statement_ko, now_iso(), ref),
        )
        return {"claim_id": claim_id, "subject": subject, "metric": metric, "predicted": predicted, "tolerance": tolerance, "unit": unit}

    def resolve(self, claim_id: str, actual: float) -> dict:
        row = self.db.one("SELECT * FROM claims WHERE claim_id = ?", (claim_id,))
        if row is None or row["verdict"] is not None:
            return dict(row) if row else {}
        if row["unit"].endswith(">="):   # one-sided promise: "at least"
            verdict = "hit" if float(actual) >= row["predicted"] - row["tolerance"] else "miss"
        else:
            verdict = "hit" if abs(float(actual) - row["predicted"]) <= row["tolerance"] else "miss"
        self.db.execute("UPDATE claims SET actual = ?, verdict = ?, resolved_at = ? WHERE claim_id = ?",
                        (float(actual), verdict, now_iso(), claim_id))
        return {**dict(row), "actual": float(actual), "verdict": verdict}

    def void(self, claim_id: str, reason: str) -> None:
        """Order never executed (cancelled/expired): the claim cannot be scored."""
        self.db.execute("UPDATE claims SET verdict = 'void', resolved_at = ?, ref = COALESCE(ref, '') || ? WHERE claim_id = ? AND verdict IS NULL",
                        (now_iso(), f" void:{reason}", claim_id))

    def for_plan(self, plan_id: str) -> list[dict]:
        return [dict(r) for r in self.db.all("SELECT * FROM claims WHERE plan_id = ? ORDER BY created_at", (plan_id,))]

    def scorecard(self, wallet: str | None = None) -> dict:
        where, params = ("WHERE wallet = ?", (wallet,)) if wallet else ("", ())
        rows = [dict(r) for r in self.db.all(f"SELECT * FROM claims {where} ORDER BY created_at DESC", params)]
        scored = [r for r in rows if r["verdict"] in ("hit", "miss")]
        by_metric: dict[str, dict] = {}
        for r in scored:
            m = by_metric.setdefault(r["metric"], {"total": 0, "hits": 0})
            m["total"] += 1
            m["hits"] += r["verdict"] == "hit"
        return {
            "total": len(scored), "hits": sum(r["verdict"] == "hit" for r in scored),
            "pending": sum(r["verdict"] is None for r in rows), "void": sum(r["verdict"] == "void" for r in rows),
            "by_metric": by_metric,
            "misses": [{k: r[k] for k in ("claim_id", "subject", "metric", "statement_ko", "predicted", "actual", "tolerance", "unit", "resolved_at")}
                       for r in scored if r["verdict"] == "miss"],
            "recent": [{k: r[k] for k in ("claim_id", "subject", "metric", "statement_ko", "predicted", "actual", "tolerance", "unit", "verdict")}
                       for r in rows[:30]],
        }
