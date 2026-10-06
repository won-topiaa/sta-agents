"""Execution tape: XTXC's own record of how tokenized stocks actually trade.

pre-trade   quotes      size-tiered buy and sell quotes (USDC <-> token) for every token product, taken read-only
                        from a public mainnet swap router: what a trade of $100 .. $100k would cost right now
            pools       where each token trades: pools, USD liquidity, 24h volume
post-trade  stockmesh_orders  XTXC's own real orders from the StockMesh order journal (research/stockmesh_journal.py):
                        quoted vs received on mainnet, sent / filled / expired
            token_bars  hourly bars of the real on-chain trades of each token -- around the clock,
                        including nights and weekends when the US market is closed
            (our own fills: the `claims` table of the agent DB, quoted vs actual cost per order)

Nothing here builds, signs or sends a transaction.

Sources (public, read-only, no key): GeckoTerminal API v2 (pools, OHLCV; the public API serves only the last 180
days, so the tape keeps everything it has seen and grows past that) and Jupiter lite-api swap/v1/quote. Both are
shared by everything on the host's address (the XTXC site's chart service calls GeckoTerminal too), so the recorder
stays far below the public limits (at most 1 and 6 calls a minute; GeckoTerminal answered 429 after a short burst in
testing) and pauses for 15 minutes after any 429.

CLI (operator):
  python -m xtxc_agent.research.exectape backfill --db PATH [--gecko-per-min 6]   # pools + 180 days of bars
  python -m xtxc_agent.research.exectape status --db PATH
  python -m xtxc_agent.research.exectape run --db PATH                           # the 24-hour recorder (systemd unit)
  python -m xtxc_agent.research.exectape merge --db PATH --source OTHER          # add a backfill made elsewhere

Around the clock: the recorder runs as its own service (deploy/xtxc-agent-recorder.service, Restart=always). The API
process starts a standby recorder too. One lock file next to the tape lets exactly one of them record; the service
announces itself every 20 s, the API records only while the service has been silent for 90 s and hands back at once.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import logging
import os
import signal
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

log = logging.getLogger("xtxc.exectape")

GECKO = "https://api.geckoterminal.com/api/v2"
JUPITER_QUOTE = "https://lite-api.jup.ag/swap/v1/quote"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDC_DECIMALS = 6
PRODUCTS_FILE = Path(__file__).with_name("token_products.json")
BUY_TIERS_USD = (100, 1_000, 10_000, 100_000)
SELL_TIERS_USD = (100, 1_000, 10_000)
PUBLIC_HISTORY_DAYS = 180
BACKOFF_429_S = 900
BACKOFF_ERROR_S = 120
BARS_EVERY_S = 3600
JOURNAL_EVERY_S = 600
TRACKED_POOLS = 3            # a token's biggest pool today is not always the one with the longest history
MIN_POOL_RESERVE_USD = 5_000
USER_AGENT = "xtxc-agent-research/1.0 (read-only)"

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
  mint TEXT PRIMARY KEY, ticker TEXT NOT NULL, issuer TEXT, symbol TEXT, decimals INTEGER);
CREATE TABLE IF NOT EXISTS pools (
  pool TEXT NOT NULL, mint TEXT NOT NULL, name TEXT, dex TEXT, reserve_usd REAL, volume_h24_usd REAL,
  created_at TEXT, seen_at TEXT NOT NULL, PRIMARY KEY (pool, seen_at));
CREATE TABLE IF NOT EXISTS token_bars (
  mint TEXT NOT NULL, pool TEXT NOT NULL, tf TEXT NOT NULL, ts INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v_usd REAL NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (mint, pool, tf, ts));
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, set_id TEXT NOT NULL, ts TEXT NOT NULL, ticker TEXT NOT NULL, mint TEXT NOT NULL,
  side TEXT NOT NULL, usd REAL NOT NULL, in_atoms INTEGER, out_atoms INTEGER, impact_pct REAL, route TEXT,
  network TEXT NOT NULL, source TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stockmesh_orders (
  order_id TEXT PRIMARY KEY, quote_id TEXT, instrument TEXT, side TEXT, product_id TEXT, execution TEXT,
  input_mint TEXT, output_mint TEXT, owner TEXT, input_atoms INTEGER, quoted_output INTEGER, minimum_output INTEGER,
  signature TEXT, phases TEXT NOT NULL, final_phase TEXT NOT NULL, first_seq INTEGER, last_seq INTEGER, attempts INTEGER,
  actual_output INTEGER, input_spent INTEGER, block_time INTEGER, slot INTEGER, tx_error TEXT, checked_at TEXT,
  source TEXT NOT NULL, imported_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS quotes_ticker_ts ON quotes(ticker, ts);
CREATE INDEX IF NOT EXISTS bars_mint_tf_ts ON token_bars(mint, tf, ts);
"""


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class Product:
    mint: str
    ticker: str
    issuer: str
    symbol: str


def load_products(path: Path = PRODUCTS_FILE) -> list[Product]:
    raw = json.loads(path.read_text())["products"]
    return sorted((Product(m, v["ticker"], v.get("issuer", ""), v.get("symbol", "")) for m, v in raw.items()),
                  key=lambda p: (p.ticker, p.issuer))


# ------------------------------------------------------------------ storage
class Tape:
    """SQLite file owned by the recorder; readers open their own connection (WAL)."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, timeout=30, isolation_level=None, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(SCHEMA)

    def execute(self, sql: str, params=()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, params)

    def executemany(self, sql: str, rows) -> None:
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                self._conn.executemany(sql, rows)
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def all(self, sql: str, params=()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def one(self, sql: str, params=()) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, params).fetchone()

    def set_meta(self, k: str, v) -> None:
        self.execute("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", (k, json.dumps(v)))

    def meta(self, k: str, default=None):
        r = self.one("SELECT v FROM meta WHERE k = ?", (k,))
        return json.loads(r["v"]) if r else default

    def sync_products(self, products: list[Product]) -> None:
        self.executemany("INSERT INTO products(mint, ticker, issuer, symbol) VALUES(?,?,?,?) ON CONFLICT(mint) DO UPDATE SET "
                         "ticker = excluded.ticker, issuer = excluded.issuer, symbol = excluded.symbol",
                         [(p.mint, p.ticker, p.issuer, p.symbol) for p in products])

    def primary_pool(self, mint: str) -> str | None:
        """The pool with the most USD liquidity at the latest pool scan."""
        r = self.one("SELECT pool FROM pools WHERE mint = ? AND seen_at = (SELECT MAX(seen_at) FROM pools WHERE mint = ?) "
                     "ORDER BY reserve_usd DESC LIMIT 1", (mint, mint))
        return r["pool"] if r else None

    def top_pools(self, mint: str, n: int = TRACKED_POOLS, min_reserve_usd: float = MIN_POOL_RESERVE_USD) -> list[str]:
        rows = self.all("SELECT pool FROM pools WHERE mint = ? AND seen_at = (SELECT MAX(seen_at) FROM pools WHERE mint = ?) "
                        "AND reserve_usd >= ? ORDER BY reserve_usd DESC LIMIT ?", (mint, mint, min_reserve_usd, n))
        return [r["pool"] for r in rows]

    def history_pool(self, mint: str) -> str | None:
        """The pool with the longest hourly history -- the one the models follow."""
        r = self.one("SELECT pool FROM token_bars WHERE mint = ? AND tf = 'hour' GROUP BY pool ORDER BY COUNT(*) DESC LIMIT 1", (mint,))
        return r["pool"] if r else None

    def last_bar_ts(self, mint: str, pool: str, tf: str) -> int | None:
        r = self.one("SELECT MAX(ts) AS ts FROM token_bars WHERE mint = ? AND pool = ? AND tf = ?", (mint, pool, tf))
        return r["ts"] if r and r["ts"] is not None else None

    def save_bars(self, mint: str, pool: str, tf: str, bars: list[list]) -> int:
        now = iso(utcnow())
        rows = [(mint, pool, tf, int(b[0]), float(b[1]), float(b[2]), float(b[3]), float(b[4]), float(b[5] or 0), now)
                for b in bars if len(b) >= 6 and all(x is not None for x in b[:5]) and float(b[4]) > 0]
        self.executemany("INSERT INTO token_bars(mint, pool, tf, ts, o, h, l, c, v_usd, fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?) "
                         "ON CONFLICT(mint, pool, tf, ts) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, "
                         "v_usd=excluded.v_usd, fetched_at=excluded.fetched_at", rows)
        return len(rows)

    def status(self) -> dict:
        bars = self.all("SELECT tf, COUNT(*) n, COUNT(DISTINCT mint) mints, MIN(ts) first, MAX(ts) last FROM token_bars GROUP BY tf")
        q = self.one("SELECT COUNT(*) n, COUNT(DISTINCT ticker) tickers, MIN(ts) first, MAX(ts) last, "
                     "SUM(error IS NOT NULL) errors FROM quotes")
        pools = self.one("SELECT COUNT(DISTINCT mint) mints, MAX(seen_at) last FROM pools")
        fmt = lambda t: iso(dt.datetime.fromtimestamp(t, dt.timezone.utc)) if t else None
        return {"bars": {r["tf"]: {"rows": r["n"], "mints": r["mints"], "first": fmt(r["first"]), "last": fmt(r["last"])} for r in bars},
                "quotes": {"rows": q["n"], "tickers": q["tickers"], "first": q["first"], "last": q["last"], "errors": q["errors"] or 0},
                "pools": {"mints": pools["mints"], "last_scan": pools["last"]},
                "backfill": self.meta("backfill")}


# ------------------------------------------------------------------ polite HTTP
class Paused(RuntimeError):
    pass


class RateLimited(RuntimeError):
    pass


class Limiter:
    """At most `per_min` calls a minute to one host; after a 429 nothing for BACKOFF_429_S seconds."""

    def __init__(self, per_min: float, clock=time.monotonic, sleep=time.sleep):
        self.gap = 60.0 / max(per_min, 0.01)
        self.clock, self.sleep = clock, sleep
        self.next_at = 0.0
        self.paused_until = 0.0
        self._lock = threading.Lock()

    def wait(self, stop: threading.Event | None = None) -> None:
        while True:
            with self._lock:
                now = self.clock()
                if now < self.paused_until:
                    delay = self.paused_until - now
                elif now < self.next_at:
                    delay = self.next_at - now
                else:
                    self.next_at = now + self.gap
                    return
            if stop is not None:
                if stop.wait(min(delay, 5.0)):
                    raise Paused("stopping")
            else:
                self.sleep(min(delay, 5.0))

    def pause(self, seconds: float) -> None:
        with self._lock:
            self.paused_until = max(self.paused_until, self.clock() + seconds)


class Http:
    """`retries` > 0 (operator backfill only): after a 429, wait `backoff_429_s` and try the same call again."""

    def __init__(self, gecko_per_min: float, jupiter_per_min: float, client: httpx.Client | None = None,
                 stop: threading.Event | None = None, *, retries: int = 0, backoff_429_s: float = BACKOFF_429_S):
        self.client = client or httpx.Client(timeout=20, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        self.limits = {"gecko": Limiter(gecko_per_min), "jupiter": Limiter(jupiter_per_min)}
        self.stop = stop
        self.retries, self.backoff_429_s = retries, backoff_429_s
        self.calls = {"gecko": 0, "jupiter": 0}
        self.rate_limited = {"gecko": 0, "jupiter": 0}

    def get(self, host: str, url: str, params: dict | None = None) -> dict:
        for attempt in range(self.retries + 1):
            try:
                return self._get(host, url, params)
            except RateLimited:
                if attempt == self.retries:
                    raise
        raise AssertionError("unreachable")

    def _get(self, host: str, url: str, params: dict | None) -> dict:
        lim = self.limits[host]
        lim.wait(self.stop)
        self.calls[host] += 1
        try:
            r = self.client.get(url, params=params)
        except httpx.HTTPError as exc:
            lim.pause(BACKOFF_ERROR_S)
            raise RuntimeError(f"{host}: {type(exc).__name__}") from exc
        if r.status_code == 429:
            self.rate_limited[host] += 1
            lim.pause(self.backoff_429_s)
            raise RateLimited(f"{host}: 429 rate limited; pausing {self.backoff_429_s:.0f}s")
        if r.status_code >= 500:
            lim.pause(BACKOFF_ERROR_S)
            raise RuntimeError(f"{host}: HTTP {r.status_code}")
        try:
            body = r.json()
        except ValueError as exc:
            raise RuntimeError(f"{host}: HTTP {r.status_code}, not JSON") from exc
        if r.status_code >= 400:
            raise RuntimeError(f"{host}: HTTP {r.status_code}: {str(body)[:160]}")
        return body


# ------------------------------------------------------------------ GeckoTerminal (post-trade tape + pools)
def scan_pools(tape: Tape, http: Http, product: Product) -> list[dict]:
    body = http.get("gecko", f"{GECKO}/networks/solana/tokens/{product.mint}/pools",
                    {"page": 1, "include": "base_token,quote_token,dex"})
    seen = iso(utcnow())
    decimals = None
    for inc in body.get("included") or []:
        a = inc.get("attributes") or {}
        if inc.get("type") == "token" and a.get("address") == product.mint and a.get("decimals") is not None:
            decimals = int(a["decimals"])
    if decimals is not None:
        tape.execute("UPDATE products SET decimals = ? WHERE mint = ?", (decimals, product.mint))
    out = []
    for p in body.get("data") or []:
        a = p.get("attributes") or {}
        rel = p.get("relationships") or {}
        out.append({"pool": a.get("address") or p["id"].split("_", 1)[-1], "name": a.get("name"),
                    "dex": ((rel.get("dex") or {}).get("data") or {}).get("id"),
                    "reserve_usd": float(a.get("reserve_in_usd") or 0), "volume_h24_usd": float((a.get("volume_usd") or {}).get("h24") or 0),
                    "created_at": a.get("pool_created_at")})
    tape.executemany("INSERT OR REPLACE INTO pools(pool, mint, name, dex, reserve_usd, volume_h24_usd, created_at, seen_at) "
                     "VALUES(?,?,?,?,?,?,?,?)", [(x["pool"], product.mint, x["name"], x["dex"], x["reserve_usd"],
                                                  x["volume_h24_usd"], x["created_at"], seen) for x in out])
    return out


def fetch_bars(tape: Tape, http: Http, mint: str, pool: str, tf: str, *, since_ts: int | None = None, limit: int = 1000) -> int:
    """Bars (timestamp, open, high, low, close, USD volume) of `mint` priced in USD, newest first, paging back to `since_ts`."""
    total, before = 0, None
    while True:
        params = {"limit": limit, "currency": "usd", "token": mint}
        if before is not None:
            params["before_timestamp"] = before
        body = http.get("gecko", f"{GECKO}/networks/solana/pools/{pool}/ohlcv/{tf}", params)
        bars = ((body.get("data") or {}).get("attributes") or {}).get("ohlcv_list") or []
        if not bars:
            break
        total += tape.save_bars(mint, pool, tf, bars)
        oldest = min(int(b[0]) for b in bars)
        if since_ts is None or oldest <= since_ts or len(bars) < limit:
            break
        before = oldest
    return total


def backfill(tape: Tape, http: Http, products: list[Product], days: int = PUBLIC_HISTORY_DAYS) -> dict:
    """Pools for every product, then hourly bars of its top pools as far back as the public API allows."""
    tape.sync_products(products)
    since = int((utcnow() - dt.timedelta(days=days - 1)).timestamp())
    done, errors = {}, {}
    for p in products:
        try:
            if not scan_pools(tape, http, p):
                errors[p.mint] = "no pool"
                continue
            pools = tape.top_pools(p.mint) or [tape.primary_pool(p.mint)]
            got = {pool: fetch_bars(tape, http, p.mint, pool, "hour", since_ts=since) for pool in pools}
            done[p.mint] = {"ticker": p.ticker, "pools": got, "history_pool": tape.history_pool(p.mint)}
            log.info("backfill %s %s: %s", p.ticker, p.symbol, ", ".join(f"{k[:6]} {v}h" for k, v in got.items()))
        except Paused:
            raise
        except Exception as exc:  # one product failing never stops the others
            errors[p.mint] = str(exc)[:200]
            log.warning("backfill %s failed: %s", p.symbol, exc)
    summary = {"at": iso(utcnow()), "days": days, "products": len(products), "ok": len(done), "errors": errors,
               "source": "geckoterminal public api v2", "pools_per_product": TRACKED_POOLS}
    tape.set_meta("backfill", summary)
    return summary


def merge(tape: Tape, other: Path) -> dict:
    """Add another tape's rows (e.g. a backfill made on another machine) while the recorder keeps running.
    Rows already here win; nothing is deleted or changed except a missing token precision."""
    with tape._lock:
        c = tape._conn
        c.execute("ATTACH DATABASE ? AS o", (str(other),))
        try:
            c.execute("BEGIN")
            n = {"products": c.execute("INSERT OR IGNORE INTO products SELECT mint, ticker, issuer, symbol, decimals FROM o.products").rowcount}
            c.execute("UPDATE products SET decimals = (SELECT p.decimals FROM o.products p WHERE p.mint = products.mint) WHERE decimals IS NULL")
            n["pools"] = c.execute("INSERT OR IGNORE INTO pools SELECT pool, mint, name, dex, reserve_usd, volume_h24_usd, created_at, seen_at "
                                   "FROM o.pools").rowcount
            n["bars"] = c.execute("INSERT OR IGNORE INTO token_bars SELECT mint, pool, tf, ts, o, h, l, c, v_usd, fetched_at "
                                  "FROM o.token_bars").rowcount
            n["quotes"] = c.execute(
                "INSERT INTO quotes(set_id, ts, ticker, mint, side, usd, in_atoms, out_atoms, impact_pct, route, network, source, error) "
                "SELECT set_id, ts, ticker, mint, side, usd, in_atoms, out_atoms, impact_pct, route, network, source, error FROM o.quotes q "
                "WHERE NOT EXISTS (SELECT 1 FROM quotes x WHERE x.set_id = q.set_id AND x.side = q.side AND x.usd = q.usd)").rowcount
            bf = c.execute("SELECT v FROM o.meta WHERE k = 'backfill'").fetchone()
            if bf:
                c.execute("INSERT INTO meta(k, v) VALUES('backfill', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", (bf[0],))
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
        finally:
            c.execute("DETACH DATABASE o")
    return n


# ------------------------------------------------------------------ Jupiter (pre-trade quotes)
def quote_set(tape: Tape, http: Http, product: Product) -> int:
    """Buy at each USD tier, then sell the token amounts worth each sell tier at the small-buy price."""
    dec = tape.one("SELECT decimals FROM products WHERE mint = ?", (product.mint,))
    decimals = dec["decimals"] if dec and dec["decimals"] is not None else None
    set_id = f"{product.mint[:8]}-{int(time.time())}"
    rows, unit_price = [], None
    for usd in BUY_TIERS_USD:
        rows.append(_quote(http, set_id, product, "BUY", usd, USDC_MINT, product.mint, usd * 10 ** USDC_DECIMALS))
        r = rows[-1]
        if unit_price is None and r["out_atoms"] and decimals is not None:
            unit_price = usd / (r["out_atoms"] / 10 ** decimals)
    if unit_price and decimals is not None:
        for usd in SELL_TIERS_USD:
            atoms = int(usd / unit_price * 10 ** decimals)
            rows.append(_quote(http, set_id, product, "SELL", usd, product.mint, USDC_MINT, atoms))
    tape.executemany("INSERT INTO quotes(set_id, ts, ticker, mint, side, usd, in_atoms, out_atoms, impact_pct, route, network, source, error) "
                     "VALUES(:set_id,:ts,:ticker,:mint,:side,:usd,:in_atoms,:out_atoms,:impact_pct,:route,:network,:source,:error)", rows)
    return sum(1 for r in rows if not r["error"])


def _quote(http: Http, set_id: str, product: Product, side: str, usd: float, input_mint: str, output_mint: str, amount: int) -> dict:
    row = {"set_id": set_id, "ts": iso(utcnow()), "ticker": product.ticker, "mint": product.mint, "side": side, "usd": float(usd),
           "in_atoms": int(amount), "out_atoms": None, "impact_pct": None, "route": None, "network": "solana-mainnet",
           "source": "jupiter-lite:swap/v1/quote", "error": None}
    try:
        body = http.get("jupiter", JUPITER_QUOTE, {"inputMint": input_mint, "outputMint": output_mint, "amount": int(amount),
                                                   "slippageBps": 50, "restrictIntermediateTokens": "true"})
        if "outAmount" not in body:
            row["error"] = str(body.get("error") or body)[:160]
        else:
            row.update(out_atoms=int(body["outAmount"]), impact_pct=float(body.get("priceImpactPct") or 0),
                       route=" > ".join(str(x.get("swapInfo", {}).get("label", "?")) for x in body.get("routePlan") or []))
    except Paused:
        raise
    except Exception as exc:
        row["error"] = str(exc)[:160]
    return row


# ------------------------------------------------------------------ background recorder
class Recorder:
    """Keeps the tape growing: new hourly bars of every product each hour (about one GeckoTerminal call a minute), a pool
    scan once a day, quotes round-robin (a set of seven quotes per token product, about hourly per product)."""

    def __init__(self, tape: Tape, products: list[Product] | None = None, *, gecko_per_min: float = 1, jupiter_per_min: float = 6,
                 quotes: bool = True, journal_dir: Path | None = None):
        self.tape = tape
        # copies of the StockMesh order journal (root timer xtxc-agent-journal-sync) next to the tape's folder
        self.journal_dir = Path(journal_dir) if journal_dir else self.tape.path.parent.parent / "stockmesh"
        self.products = products or load_products()
        self.stop = threading.Event()
        self.http = Http(gecko_per_min, jupiter_per_min, stop=self.stop)
        self.quotes = quotes
        self.state = {"started_at": iso(utcnow()), "bars_rounds": 0, "quote_sets": 0, "last_error": None}
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        self.tape.sync_products(self.products)
        self._threads = [threading.Thread(target=self._loop, args=(self._bars_round, BARS_EVERY_S), name="tape-bars", daemon=True)]
        if self.quotes:
            self._threads.append(threading.Thread(target=self._loop, args=(self._quote_round, 60), name="tape-quotes", daemon=True))
        self._threads.append(threading.Thread(target=self._loop, args=(self._journal_round, JOURNAL_EVERY_S), name="tape-journal", daemon=True))
        for t in self._threads:
            t.start()

    def close(self) -> None:
        self.stop.set()

    def _loop(self, step, every_s: float) -> None:
        while not self.stop.is_set():
            began = time.monotonic()
            try:
                step()
            except Paused:
                return
            except Exception as exc:
                self.state["last_error"] = f"{iso(utcnow())} {str(exc)[:200]}"
                log.warning("tape %s: %s", step.__name__, exc)
            if self.stop.wait(max(5.0, every_s - (time.monotonic() - began))):
                return

    def _bars_round(self) -> None:
        """Every round: new bars of the pool with the longest history. Once a day: pool scan and the other top pools."""
        today = utcnow().date().isoformat()
        daily = self.tape.meta("pools_scanned_on") != today
        for p in self.products:
            if self.stop.is_set():
                return
            try:
                if daily or self.tape.primary_pool(p.mint) is None:
                    scan_pools(self.tape, self.http, p)
                pools = [self.tape.history_pool(p.mint) or self.tape.primary_pool(p.mint)]
                if daily:
                    pools += [x for x in self.tape.top_pools(p.mint) if x not in pools]
                for pool in filter(None, pools):
                    last = self.tape.last_bar_ts(p.mint, pool, "hour")
                    since = last - 3 * 3600 if last else int((utcnow() - dt.timedelta(days=PUBLIC_HISTORY_DAYS - 1)).timestamp())
                    hours_back = (time.time() - since) / 3600
                    fetch_bars(self.tape, self.http, p.mint, pool, "hour", since_ts=since, limit=min(1000, max(24, int(hours_back) + 2)))
            except Paused:
                raise
            except Exception as exc:
                self.state["last_error"] = f"{iso(utcnow())} {p.symbol}: {str(exc)[:160]}"
        if daily:
            self.tape.set_meta("pools_scanned_on", today)
        self.state["bars_rounds"] += 1
        self.state["last_bars_round"] = iso(utcnow())

    def _journal_round(self) -> None:
        """Real XTXC orders (post-trade): import the journal copies, look up fills on mainnet (read-only)."""
        from .stockmesh_journal import sync
        if self.journal_dir.is_dir():
            st = sync(self.tape, self.journal_dir)
            self.state["journal"] = {"at": iso(utcnow()), "orders": st["orders"], "looked_up": st["looked_up"]}

    def _quote_round(self) -> None:
        for p in self.products:
            if self.stop.is_set():
                return
            quote_set(self.tape, self.http, p)
            self.state["quote_sets"] += 1
            self.state["last_quote"] = iso(utcnow())

    def health(self) -> dict:
        return {**self.state, "alive": any(t.is_alive() for t in self._threads), "calls": dict(self.http.calls),
                "rate_limited": dict(self.http.rate_limited)}


class Standby:
    """Records only while holding `<tape>.lock`. The dedicated service is the main recorder: it announces itself every
    20 s in `<tape>.want-service` (also while waiting for the lock); a standby started with `yield_to="service"` (the API)
    records only while that note is older than YIELD_AFTER_S and hands the lock back as soon as it is fresh again.
    A heartbeat in the tape's meta table says who records."""

    WANT_EVERY_S = 20
    YIELD_AFTER_S = 90

    def __init__(self, tape_path: Path, who: str, *, retry_s: float = 10, yield_to: str | None = None, **recorder_kw):
        self.tape_path = Path(tape_path)
        self.who = who
        self.retry_s = retry_s
        self.yield_to = yield_to
        self.kw = recorder_kw
        self.stop = threading.Event()
        self.recorder: Recorder | None = None
        self._fd = None
        self._thread: threading.Thread | None = None
        self.handovers = 0

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"tape-standby-{self.who}", daemon=True)
        self._thread.start()

    def close(self) -> None:
        self.stop.set()
        if self.recorder:
            self.recorder.close()

    def join(self) -> None:
        while self._thread and self._thread.is_alive():
            self._thread.join(1.0)

    def _note(self, who: str) -> Path:
        return Path(f"{self.tape_path}.want-{who}")

    def _announce(self) -> None:
        try:
            self._note(self.who).write_text(iso(utcnow()))
        except OSError as exc:
            log.warning("tape note: %s", exc)

    def _other_wants(self) -> bool:
        if not self.yield_to:
            return False
        try:
            age = time.time() - self._note(self.yield_to).stat().st_mtime
        except OSError:
            return False
        return age < self.YIELD_AFTER_S

    def _try_lock(self) -> bool:
        self.tape_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(self.tape_path) + ".lock", os.O_RDWR | os.O_CREAT, 0o660)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return False
        self._fd = fd
        return True

    def _release(self) -> None:
        if self.recorder:
            self.recorder.close()
            for t in self.recorder._threads:
                t.join(30)
            self.recorder = None
        if self._fd is not None:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
            os.close(self._fd)
            self._fd = None

    def _run(self) -> None:
        last_note = 0.0
        while not self.stop.is_set():
            if not self.yield_to and time.monotonic() - last_note >= self.WANT_EVERY_S:
                self._announce()
                last_note = time.monotonic()
            if self.recorder is None:
                if not self._other_wants() and self._try_lock():
                    tape = Tape(self.tape_path)
                    self.recorder = Recorder(tape, **self.kw)
                    self.recorder.start()
                    log.info("tape recorder running (%s, pid %d)", self.who, os.getpid())
                elif self.stop.wait(self.retry_s):
                    break
                continue
            if self._other_wants():
                log.info("tape recorder: handing over to %s", self.yield_to)
                self._release()
                self.handovers += 1
                continue
            try:
                self.recorder.tape.set_meta("heartbeat", {"who": self.who, "pid": os.getpid(), "at": iso(utcnow()), **self.recorder.health()})
            except Exception as exc:  # the heartbeat is informational
                log.warning("tape heartbeat: %s", exc)
            if self.stop.wait(self.WANT_EVERY_S):
                break
        self._release()

    def health(self) -> dict:
        return {"who": self.who, "recording": self.recorder is not None, "handovers": self.handovers,
                **({"recorder": self.recorder.health()} if self.recorder else {})}


def _main(argv=None) -> None:  # pragma: no cover - operator CLI
    ap = argparse.ArgumentParser(prog="exectape")
    ap.add_argument("command", choices=["backfill", "status", "quotes-once", "run", "merge"])
    ap.add_argument("--db", required=True)
    ap.add_argument("--gecko-per-min", type=float, default=6)
    ap.add_argument("--jupiter-per-min", type=float, default=30)
    ap.add_argument("--days", type=int, default=PUBLIC_HISTORY_DAYS)
    ap.add_argument("--source", help="merge: the other tape file")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    if a.command == "run":
        sb = Standby(Path(a.db), "service")
        signal.signal(signal.SIGTERM, lambda *_: sb.close())
        sb.start()
        try:
            sb.join()
        except KeyboardInterrupt:
            sb.close()
        return
    tape = Tape(Path(a.db))
    if a.command == "merge":
        print(json.dumps(merge(tape, Path(a.source)), indent=1))
        return
    if a.command == "status":
        print(json.dumps(tape.status(), indent=1))
        return
    http = Http(a.gecko_per_min, a.jupiter_per_min, retries=6, backoff_429_s=75)
    products = load_products()
    if a.command == "backfill":
        print(json.dumps(backfill(tape, http, products, a.days), indent=1))
    else:
        tape.sync_products(products)
        print(sum(quote_set(tape, http, p) for p in products), "quotes")


if __name__ == "__main__":  # pragma: no cover
    _main()
