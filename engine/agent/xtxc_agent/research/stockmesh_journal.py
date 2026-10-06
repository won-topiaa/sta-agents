"""StockMesh order journal (read-only): XTXC's own post-trade record of real orders on Solana mainnet.

Format: framed records, each = u32 little-endian body length, u32 CRC-32 of the body, JSON body ``{"seq", "entry"}``.
Every entry is an order's state after one step: Prepared -> Unknown -> Submitted -> Finalized -> Reconciled, or
ExpiredUnsent (never sent) / {"ExpiredNoFill": {...}} (sent, not filled before it expired). A frame that is still being
written at the end of the file is ignored; a frame whose CRC does not match is counted and skipped.

Only trade facts are kept: ids, instrument, side, product, route kind, input, quoted and minimum output, owner, the
phase timeline and the transaction signature. Wire bytes, message hashes and account resources are not stored.

Actual fills: a finalized transaction is read from a public mainnet RPC (getTransaction, read-only). The owner's balance
change of the output token is what was received; against the quote it is the post-trade slippage.

The journal itself is readable only by the trading service; a root timer (deploy/xtxc-agent-journal-sync.*) copies it
read-only into the agent's private data folder, and the 24-hour recorder imports the copy.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import struct
import zlib
from pathlib import Path

PUBLIC_RPC = "https://api.mainnet-beta.solana.com"
FILLED = ("Finalized", "Reconciled")
SENT = ("Submitted", "Finalized", "Reconciled", "ExpiredNoFill")
MIN_FILLS_FOR_CALIBRATION = 20

def phase_name(p) -> str:
    if isinstance(p, dict) and p:
        return str(next(iter(p)))
    return str(p)


def parse(data: bytes) -> tuple[list[dict], dict]:
    recs, bad, i = [], 0, 0
    while i + 8 <= len(data):
        n, crc = struct.unpack("<II", data[i:i + 8])
        body = data[i + 8:i + 8 + n]
        if len(body) < n:
            break                                                     # still being written
        i += 8 + n
        if zlib.crc32(body) != crc:
            bad += 1
            continue
        try:
            recs.append(json.loads(body))
        except ValueError:
            bad += 1
    return recs, {"frames": len(recs), "crc_bad": bad, "partial_bytes": len(data) - i}


def fold(records: list[dict]) -> dict[str, dict]:
    orders: dict[str, dict] = {}
    for r in sorted(records, key=lambda x: x.get("seq", 0)):
        e = r.get("entry") or {}
        oid = e.get("id")
        if not oid:
            continue
        s = e.get("expected_swap") or {}
        t = s.get("trade") or {}
        o = orders.setdefault(oid, {"order_id": oid, "phases": [], "first_seq": r.get("seq")})
        o.update(quote_id=e.get("quote_id"), instrument=t.get("instrument"), side=t.get("side"), product_id=t.get("product_id"),
                 execution=t.get("execution"), input_mint=s.get("input_mint"), output_mint=s.get("output_mint"), owner=s.get("owner"),
                 input_atoms=s.get("input"), quoted_output=s.get("quoted_output"), minimum_output=s.get("minimum_output"),
                 signature=e.get("signature"), attempts=e.get("attempts"), last_seq=r.get("seq"))
        name = phase_name(e.get("phase"))
        o["phases"].append({"seq": r.get("seq"), "phase": name})
        o["final_phase"] = name
    return orders


def _balance(entries, owner, mint) -> int:
    return sum(int(x["uiTokenAmount"]["amount"]) for x in entries or [] if x.get("owner") == owner and x.get("mint") == mint)


def fetch_fill(client, rpc: str, order: dict) -> dict:
    """What the owner really received and paid in the finalized transaction."""
    body = {"jsonrpc": "2.0", "id": 1, "method": "getTransaction",
            "params": [order["signature"], {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0, "commitment": "finalized"}]}
    r = client.post(rpc, json=body, timeout=20)
    r.raise_for_status()
    tx = r.json().get("result")
    if not tx:
        return {"tx_error": "not found yet"}
    meta = tx.get("meta") or {}
    pre, post = meta.get("preTokenBalances"), meta.get("postTokenBalances")
    return {"actual_output": _balance(post, order["owner"], order["output_mint"]) - _balance(pre, order["owner"], order["output_mint"]),
            "input_spent": _balance(pre, order["owner"], order["input_mint"]) - _balance(post, order["owner"], order["input_mint"]),
            "block_time": tx.get("blockTime"), "slot": tx.get("slot"), "tx_error": json.dumps(meta.get("err")) if meta.get("err") else None}


def sync(tape, folder: Path, *, client=None, rpc: str = PUBLIC_RPC, max_lookups: int = 20) -> dict:
    """Import every copied journal in ``folder`` into the tape and look up fills not yet known."""
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    stats = {"files": 0, "orders": 0, "frames": 0, "crc_bad": 0, "looked_up": 0, "errors": []}
    for path in sorted(Path(folder).glob("*.orders.jsonl")):
        data = path.read_bytes()
        recs, st = parse(data)
        stats["files"] += 1
        stats["frames"] += st["frames"]
        stats["crc_bad"] += st["crc_bad"]
        source = f"{path.name} sha256:{hashlib.sha256(data).hexdigest()[:16]}"
        for o in fold(recs).values():
            stats["orders"] += 1
            tape.execute(
                "INSERT INTO stockmesh_orders(order_id, quote_id, instrument, side, product_id, execution, input_mint, output_mint, owner, "
                "input_atoms, quoted_output, minimum_output, signature, phases, final_phase, first_seq, last_seq, attempts, source, imported_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET phases = excluded.phases, "
                "final_phase = excluded.final_phase, last_seq = excluded.last_seq, attempts = excluded.attempts, signature = excluded.signature, "
                "source = excluded.source, imported_at = excluded.imported_at",
                (o["order_id"], o.get("quote_id"), o.get("instrument"), o.get("side"), o.get("product_id"), o.get("execution"),
                 o.get("input_mint"), o.get("output_mint"), o.get("owner"), o.get("input_atoms"), o.get("quoted_output"),
                 o.get("minimum_output"), o.get("signature"), json.dumps(o["phases"]), o["final_phase"], o.get("first_seq"),
                 o.get("last_seq"), o.get("attempts"), source, now))
    todo = tape.all("SELECT * FROM stockmesh_orders WHERE final_phase IN ('Finalized', 'Reconciled') AND actual_output IS NULL "
                    "AND signature IS NOT NULL LIMIT ?", (max_lookups,))
    if todo:
        import httpx
        own = client is None
        client = client or httpx.Client(headers={"User-Agent": "xtxc-agent-research/1.0 (read-only)"})
        try:
            for row in todo:
                try:
                    f = fetch_fill(client, rpc, dict(row))
                except Exception as exc:  # retried on the next round
                    stats["errors"].append(f"{row['order_id'][:12]}: {type(exc).__name__}")
                    continue
                tape.execute("UPDATE stockmesh_orders SET actual_output = ?, input_spent = ?, block_time = ?, slot = ?, tx_error = ?, "
                             "checked_at = ? WHERE order_id = ?", (f.get("actual_output"), f.get("input_spent"), f.get("block_time"),
                                                                    f.get("slot"), f.get("tx_error"), now, row["order_id"]))
                stats["looked_up"] += 1
        finally:
            if own:
                client.close()
    tape.set_meta("stockmesh_sync", {"at": now, **{k: v for k, v in stats.items() if k != "errors"}, "errors": stats["errors"][:5]})
    return stats


def summary(rows: list[dict], instrument: str | None = None) -> dict:
    """Post-trade facts of real XTXC orders: how many were sent and filled, and received vs quoted."""
    rows = [r for r in rows if instrument is None or r["instrument"] == instrument]
    final = [r["final_phase"] for r in rows]
    fills = [r for r in rows if r["final_phase"] in FILLED and r.get("actual_output") is not None and r.get("quoted_output")]
    slip = sorted((r["actual_output"] / r["quoted_output"] - 1) * 1e4 for r in fills)
    sent = sum(1 for p in final if p in SENT)
    out = {"orders": len(rows), "sent": sent, "filled": sum(1 for p in final if p in FILLED),
           "expired_unsent": final.count("ExpiredUnsent"), "expired_no_fill": final.count("ExpiredNoFill"),
           "measured": len(fills), "network": "solana-mainnet", "source": "stockmesh order journal",
           "used_in_forecast": len(fills) >= MIN_FILLS_FOR_CALIBRATION}
    if slip:
        out.update(median_slippage_bps=slip[len(slip) // 2], worst_slippage_bps=slip[0],
                   p10_slippage_bps=slip[max(0, int(len(slip) * 0.1) - 1)] if len(slip) >= 10 else slip[0],
                   below_minimum=sum(1 for r in fills if r["actual_output"] < (r.get("minimum_output") or 0)))
    return out
