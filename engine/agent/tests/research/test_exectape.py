"""Execution tape recorder: polite HTTP (rate, 429 pause), storage, paging, quotes, one recorder at a time. No network."""
import threading

import pytest

from xtxc_agent.research import exectape as et


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def test_limiter_spaces_calls_and_pauses_after_429():
    c = Clock()
    lim = et.Limiter(6, clock=c, sleep=c.sleep)            # one call every 10 s
    for _ in range(3):
        lim.wait()
    assert c.t == pytest.approx(20)
    lim.pause(900)
    lim.wait()
    assert c.t >= 920


class FakeHttp(et.Http):
    def __init__(self, answers):
        super().__init__(1000, 1000)
        self.answers, self.seen = list(answers), []

    def _get(self, host, url, params):
        self.seen.append((host, url, dict(params or {})))
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


def test_retry_after_429_only_when_asked():
    h = FakeHttp([et.RateLimited("429"), {"ok": 1}])
    with pytest.raises(et.RateLimited):
        h.get("gecko", "u")
    h = FakeHttp([et.RateLimited("429"), {"ok": 1}])
    h.retries = 2
    assert h.get("gecko", "u") == {"ok": 1}


def test_bars_page_back_until_the_start_and_upsert(tmp_path):
    tape = et.Tape(tmp_path / "t.sqlite")
    page1 = [[1_000_000 + 3600 * i, 1, 1, 1, 1 + i / 100, 10] for i in range(9, 4, -1)]      # newest first
    page2 = [[1_000_000 + 3600 * i, 1, 1, 1, 1 + i / 100, 10] for i in range(4, -1, -1)]
    h = FakeHttp([{"data": {"attributes": {"ohlcv_list": page1}}}, {"data": {"attributes": {"ohlcv_list": page2}}}])
    n = et.fetch_bars(tape, h, "M", "P", "hour", since_ts=1_000_000, limit=5)
    assert n == 10 and h.seen[1][2]["before_timestamp"] == 1_000_000 + 3600 * 5 and h.seen[0][2]["token"] == "M"
    tape.save_bars("M", "P", "hour", [[1_000_000, 1, 1, 1, 2.5, 99]])                          # a refreshed bar replaces the old one
    assert tape.one("SELECT c, v_usd FROM token_bars WHERE ts = 1000000")["c"] == 2.5
    assert tape.status()["bars"]["hour"]["rows"] == 10


def test_quote_set_records_buys_and_sells_and_keeps_errors(tmp_path):
    tape = et.Tape(tmp_path / "t.sqlite")
    p = et.Product("MINT", "AAPL", "xStocks", "AAPLx")
    tape.sync_products([p])
    tape.execute("UPDATE products SET decimals = 8 WHERE mint = 'MINT'")
    buys = [{"outAmount": str(int(usd / 250 * 1e8)), "priceImpactPct": "0.001", "routePlan": [{"swapInfo": {"label": "X"}}]}
            for usd in et.BUY_TIERS_USD]
    sells = [{"outAmount": "99000000"}, {"error": "no route"}, {"outAmount": "9900000000"}]
    et.quote_set(tape, FakeHttp(buys + sells), p)
    rows = tape.all("SELECT side, usd, out_atoms, error FROM quotes ORDER BY id")
    assert [(r["side"], r["usd"]) for r in rows] == [("BUY", 100), ("BUY", 1000), ("BUY", 10000), ("BUY", 100000),
                                                      ("SELL", 100), ("SELL", 1000), ("SELL", 10000)]
    assert rows[5]["error"] == "no route" and rows[0]["out_atoms"] == 40_000_000


def test_only_one_recorder_holds_the_tape(tmp_path):
    a, b = et.Standby(tmp_path / "t.sqlite", "service"), et.Standby(tmp_path / "t.sqlite", "api", yield_to="service")
    assert a._try_lock() and not b._try_lock()
    a._release()                                                      # the service stops -> the standby can take over
    assert b._try_lock()
    b._release()


def test_the_api_standby_yields_while_the_service_is_alive(tmp_path):
    api = et.Standby(tmp_path / "t.sqlite", "api", yield_to="service")
    assert not api._other_wants()                                     # no service: the API records
    svc = et.Standby(tmp_path / "t.sqlite", "service")
    svc._announce()
    assert api._other_wants()                                         # the service is here: the API steps back
    import os
    old = __import__("time").time() - 200
    os.utime(svc._note("service"), (old, old))
    assert not api._other_wants()                                     # silent for 200 s: the API takes over again


def test_merge_adds_a_backfill_made_elsewhere_and_keeps_existing_rows(tmp_path):
    live, other = et.Tape(tmp_path / "live.sqlite"), et.Tape(tmp_path / "other.sqlite")
    p = et.Product("M", "AAPL", "xStocks", "AAPLx")
    live.sync_products([p]); other.sync_products([p])
    other.execute("UPDATE products SET decimals = 8")
    live.save_bars("M", "P", "hour", [[3600, 1, 1, 1, 9.0, 1]])                        # the live tape already has this hour
    other.save_bars("M", "P", "hour", [[3600, 1, 1, 1, 1.0, 1], [7200, 1, 1, 1, 2.0, 1]])
    q = {"set_id": "s1", "ts": "2026-09-29T00:00:00Z", "ticker": "AAPL", "mint": "M", "side": "BUY", "usd": 100.0, "in_atoms": 1, "out_atoms": 1,
         "impact_pct": 0, "route": "x", "network": "n", "source": "s", "error": None}
    other.executemany("INSERT INTO quotes(set_id, ts, ticker, mint, side, usd, in_atoms, out_atoms, impact_pct, route, network, source, error) "
                      "VALUES(:set_id,:ts,:ticker,:mint,:side,:usd,:in_atoms,:out_atoms,:impact_pct,:route,:network,:source,:error)", [q])
    assert et.merge(live, tmp_path / "other.sqlite") == {"products": 0, "pools": 0, "bars": 1, "quotes": 1}
    assert et.merge(live, tmp_path / "other.sqlite")["quotes"] == 0                   # merging twice adds nothing
    assert [r["c"] for r in live.all("SELECT c FROM token_bars ORDER BY ts")] == [9.0, 2.0]
    assert live.one("SELECT decimals FROM products")["decimals"] == 8
