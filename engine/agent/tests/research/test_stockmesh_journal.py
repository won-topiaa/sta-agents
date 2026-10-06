"""StockMesh order journal: framed records -> orders -> real fills (read-only). Synthetic journal, no network."""
import json
import struct
import zlib

from xtxc_agent.research import exectape as et
from xtxc_agent.research import stockmesh_journal as sj

USDC, NVDAX = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "XsNVDA"


def frame(obj, crc_ok=True) -> bytes:
    body = json.dumps(obj).encode()
    crc = zlib.crc32(body) if crc_ok else 0
    return struct.pack("<II", len(body), crc) + body


def entry(seq, oid, phase, *, inp=2_000_000, quoted=866216, minimum=864473, sig="SIG1"):
    return {"seq": seq, "entry": {"id": oid, "quote_id": "q" + oid, "signature": sig, "wire": [1, 2], "message_hash": [3],
                                  "resources": [[1]], "last_valid_height": 1, "attempts": 1, "phase": phase,
                                  "expected_swap": {"owner": "OWNER", "input_mint": USDC, "output_mint": NVDAX, "input": inp,
                                                    "quoted_output": quoted, "minimum_output": minimum,
                                                    "trade": {"side": "BUY", "instrument": "NVDA", "product_id": "p", "execution": "GRAPH"}}}}


def journal() -> bytes:
    recs = [entry(1, "A", "Prepared", sig="SA"), entry(2, "A", "ExpiredUnsent", sig="SA"),
            entry(3, "B", "Prepared", sig="SB"), entry(4, "B", {"ExpiredNoFill": {"finalized_slot": 9}}, sig="SB"),
            entry(5, "C", "Prepared", sig="SC"), entry(6, "C", "Submitted", sig="SC"), entry(7, "C", "Finalized", sig="SC"),
            entry(8, "C", "Reconciled", sig="SC")]
    data = b"".join(frame(r) for r in recs) + frame(entry(9, "D", "Prepared"), crc_ok=False)
    return data + frame(entry(10, "E", "Prepared"))[:20]                 # a frame still being written


def test_parse_and_fold_keep_trade_facts_only():
    recs, st = sj.parse(journal())
    assert st == {"frames": 8, "crc_bad": 1, "partial_bytes": 20}
    orders = sj.fold(recs)
    assert {k: o["final_phase"] for k, o in orders.items()} == {"A": "ExpiredUnsent", "B": "ExpiredNoFill", "C": "Reconciled"}
    c = orders["C"]
    assert [p["phase"] for p in c["phases"]] == ["Prepared", "Submitted", "Finalized", "Reconciled"]
    assert c["quoted_output"] == 866216 and c["instrument"] == "NVDA" and "wire" not in c and "message_hash" not in c


class FakeRpc:
    def __init__(self):
        self.calls = []

    def post(self, url, json=None, timeout=None):
        self.calls.append(json["params"][0])
        tb = lambda owner, mint, amount: {"owner": owner, "mint": mint, "uiTokenAmount": {"amount": str(amount), "decimals": 8}}
        result = {"slot": 123, "blockTime": 1790000000, "meta": {"err": None,
                  "preTokenBalances": [tb("OWNER", NVDAX, 1000), tb("OWNER", USDC, 5_000_000)],
                  "postTokenBalances": [tb("OWNER", NVDAX, 1000 + 865000), tb("OWNER", USDC, 3_000_000)]}}
        return type("R", (), {"raise_for_status": lambda self: None, "json": lambda self: {"result": result}})()


def test_sync_imports_copies_and_measures_real_fills(tmp_path):
    folder = tmp_path / "stockmesh"
    folder.mkdir()
    (folder / "stock-trade-58-20260929.orders.jsonl").write_bytes(journal())
    tape = et.Tape(tmp_path / "exectape" / "tape.sqlite")
    rpc = FakeRpc()
    st = sj.sync(tape, folder, client=rpc)
    assert st["orders"] == 3 and st["looked_up"] == 1 and rpc.calls == ["SC"]          # only the filled order is looked up
    assert sj.sync(tape, folder, client=rpc)["looked_up"] == 0                          # once known, never again
    rows = [dict(r) for r in tape.all("SELECT * FROM stockmesh_orders")]
    s = sj.summary(rows)
    assert (s["orders"], s["sent"], s["filled"], s["expired_unsent"], s["expired_no_fill"], s["measured"]) == (3, 2, 1, 1, 1, 1)
    assert round(s["median_slippage_bps"], 1) == round((865000 / 866216 - 1) * 1e4, 1) and s["below_minimum"] == 0
    assert not s["used_in_forecast"] and tape.meta("stockmesh_sync")["orders"] == 3
    assert sj.summary(rows, "TQQQ")["orders"] == 0
