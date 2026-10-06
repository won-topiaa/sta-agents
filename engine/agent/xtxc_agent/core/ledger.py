"""Hash-chained event log and daily seals.

Every event stores the hash of the previous event, so rewriting history breaks
the chain. Once a day the event hashes of that (UTC) day are folded into one
Merkle root; the root goes on chain as a memo. Anyone holding the events can
recompute the root and compare it with the chain.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from .db import Database, dumps, now_iso

GENESIS = "0" * 64


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def event_hash(prev_hash: str, ts: str, wallet: str | None, type_: str, summary_ko: str, ref: str | None, payload: dict) -> str:
    body = dumps({"prev": prev_hash, "ts": ts, "wallet": wallet, "type": type_, "summary": summary_ko, "ref": ref, "payload": payload})
    return _sha(body)


def merkle_root(hashes: list[str]) -> str:
    if not hashes:
        return _sha("xtxc:empty-day")
    level = [bytes.fromhex(h) for h in hashes]
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [hashlib.sha256(level[i] + level[i + 1]).digest() for i in range(0, len(level), 2)]
    return level[0].hex()


class Ledger:
    def __init__(self, db: Database):
        self.db = db

    def append(self, type_: str, summary_ko: str, *, wallet: str | None = None, ref: str | None = None, payload: dict | None = None) -> dict:
        payload = payload or {}
        with self.db.write_lock:
            last = self.db.one("SELECT hash FROM events ORDER BY seq DESC LIMIT 1")
            prev = last["hash"] if last else GENESIS
            ts = now_iso()
            day = ts[:10]
            h = event_hash(prev, ts, wallet, type_, summary_ko, ref, payload)
            cur = self.db.execute(
                "INSERT INTO events(ts, day, wallet, type, summary_ko, ref, payload, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)",
                (ts, day, wallet, type_, summary_ko, ref, dumps(payload), prev, h),
            )
            return {"seq": cur.lastrowid, "ts": ts, "type": type_, "wallet": wallet, "summary_ko": summary_ko,
                    "ref": ref, "hash": h, "prev_hash": prev}

    def events(self, wallet: str | None = None, limit: int = 200) -> list[dict]:
        if wallet:
            rows = self.db.all("SELECT * FROM events WHERE wallet = ? OR wallet IS NULL ORDER BY seq DESC LIMIT ?", (wallet, limit))
        else:
            rows = self.db.all("SELECT * FROM events ORDER BY seq DESC LIMIT ?", (limit,))
        return [self._row(r) for r in rows]

    @staticmethod
    def _row(r) -> dict:
        return {"seq": r["seq"], "ts": r["ts"], "type": r["type"], "wallet": r["wallet"], "summary_ko": r["summary_ko"],
                "ref": r["ref"], "payload": json.loads(r["payload"]), "hash": r["hash"], "prev_hash": r["prev_hash"]}

    def verify_chain(self) -> dict:
        """Recompute every hash from the stored fields. Returns the first break, if any."""
        prev = GENESIS
        count = 0
        for r in self.db.all("SELECT * FROM events ORDER BY seq ASC"):
            expected = event_hash(prev, r["ts"], r["wallet"], r["type"], r["summary_ko"], r["ref"], json.loads(r["payload"]))
            if r["prev_hash"] != prev or r["hash"] != expected:
                return {"ok": False, "broken_at": r["seq"], "events_checked": count}
            prev = r["hash"]
            count += 1
        return {"ok": True, "events_checked": count, "head": prev}

    def day_root(self, day: str, first_seq: int | None = None, last_seq: int | None = None) -> dict:
        """Merkle root over the day's events, optionally limited to a sealed [first_seq, last_seq] part."""
        rows = self.db.all("SELECT seq, hash FROM events WHERE day = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC",
                           (day, first_seq or 0, last_seq if last_seq is not None else 2**62))
        hashes = [r["hash"] for r in rows]
        return {"day": day, "root": merkle_root(hashes), "event_count": len(hashes),
                "first_seq": rows[0]["seq"] if rows else None, "last_seq": rows[-1]["seq"] if rows else None}

    def unsealed(self, day: str) -> dict:
        """Events of `day` not yet covered by any seal part (a day can be sealed in several parts)."""
        last = self.db.one("SELECT MAX(last_seq) s FROM seal_parts WHERE day = ?", (day,))["s"]
        return self.day_root(day, (last or 0) + 1, None)

    def next_part(self, day: str) -> int:
        return (self.db.one("SELECT COUNT(*) n FROM seal_parts WHERE day = ?", (day,))["n"] or 0) + 1

    @staticmethod
    def seal_memo(day: str, part: int, root: str) -> str:
        return f"xtxc:seal:v1:{day}:{part}:{root}"

    def record_seal(self, day: str, root_info: dict, signature: str | None, network: str) -> dict:
        part = (self.db.one("SELECT COUNT(*) n FROM seal_parts WHERE day = ?", (day,))["n"] or 0) + 1
        memo = self.seal_memo(day, part, root_info["root"])
        self.db.execute(
            "INSERT INTO seal_parts(day, part, root, event_count, first_seq, last_seq, memo, signature, network, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (day, part, root_info["root"], root_info["event_count"], root_info["first_seq"], root_info["last_seq"], memo,
             signature, network, now_iso()),
        )
        return {**root_info, "part": part, "memo": memo, "signature": signature, "network": network}

    def seal(self, day: str) -> dict | None:
        parts = self.db.all("SELECT * FROM seal_parts WHERE day = ? ORDER BY part", (day,))
        if not parts:
            return None
        out = []
        for r in parts:
            current = self.day_root(day, r["first_seq"], r["last_seq"])
            out.append({"part": r["part"], "first_seq": r["first_seq"], "last_seq": r["last_seq"], "root": r["root"],
                        "event_count": r["event_count"], "memo": r["memo"], "signature": r["signature"], "network": r["network"],
                        "created_at": r["created_at"], "recomputed_root": current["root"],
                        "matches": current["root"] == r["root"] and current["event_count"] == r["event_count"]})
        last = out[-1]
        return {"day": day, "parts": out, "matches": all(p["matches"] for p in out),
                "event_count": sum(p["event_count"] for p in out), "last_seq": last["last_seq"],
                "root": last["root"], "recomputed_root": last["recomputed_root"], "memo": last["memo"],
                "signature": last["signature"], "network": last["network"], "created_at": last["created_at"],
                "unsealed_after": self.unsealed(day)["event_count"]}

    @staticmethod
    def today() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")
