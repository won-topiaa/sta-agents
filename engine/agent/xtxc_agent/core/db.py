"""SQLite (WAL) storage. One connection per thread; writes are short."""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS briefs (
  brief_id TEXT NOT NULL, version INTEGER NOT NULL, wallet TEXT, status TEXT NOT NULL,
  body TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (brief_id, version));
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, brief_id TEXT NOT NULL, brief_version INTEGER NOT NULL, wallet TEXT,
  spec_hash TEXT, snapshot_id TEXT, engine_version TEXT, status TEXT NOT NULL, cache_hit INTEGER DEFAULT 0,
  progress TEXT NOT NULL DEFAULT '[]', report TEXT, error TEXT, created_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE IF NOT EXISTS research_cache (
  cache_key TEXT PRIMARY KEY, spec_hash TEXT, snapshot_id TEXT, engine_version TEXT,
  result TEXT NOT NULL, created_at TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, run_id TEXT NOT NULL, wallet TEXT NOT NULL,
  body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prepared (
  prep_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, wallet TEXT NOT NULL, mode TEXT NOT NULL,
  body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, wallet TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, wallet TEXT,
  type TEXT NOT NULL, summary_ko TEXT NOT NULL, ref TEXT, payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS seals (
  day TEXT PRIMARY KEY, root TEXT NOT NULL, event_count INTEGER NOT NULL, first_seq INTEGER, last_seq INTEGER,
  memo TEXT NOT NULL, signature TEXT, network TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seal_parts (
  day TEXT NOT NULL, part INTEGER NOT NULL, root TEXT NOT NULL, event_count INTEGER NOT NULL, first_seq INTEGER, last_seq INTEGER,
  memo TEXT NOT NULL, signature TEXT, network TEXT, created_at TEXT NOT NULL, PRIMARY KEY (day, part));
CREATE TABLE IF NOT EXISTS ai_calls (
  call_id TEXT PRIMARY KEY, ts TEXT NOT NULL, flow TEXT NOT NULL, model TEXT, thinking INTEGER NOT NULL,
  prompt_sha TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
  cached_tokens INTEGER, cost_usd REAL, latency_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 1,
  outcome TEXT NOT NULL, cache_hit INTEGER NOT NULL DEFAULT 0, wallet TEXT, ref TEXT);
CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key TEXT PRIMARY KEY, flow TEXT NOT NULL, response TEXT NOT NULL, source_call TEXT,
  created_at TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY, wallet TEXT, plan_id TEXT, subject TEXT NOT NULL, metric TEXT NOT NULL,
  predicted REAL NOT NULL, tolerance REAL NOT NULL, unit TEXT NOT NULL, statement_ko TEXT NOT NULL,
  created_at TEXT NOT NULL, actual REAL, verdict TEXT, resolved_at TEXT, ref TEXT);
CREATE TABLE IF NOT EXISTS walletchecks (
  check_id TEXT PRIMARY KEY, wallet TEXT, tx TEXT NOT NULL, network TEXT NOT NULL,
  created_at TEXT NOT NULL, result TEXT);
CREATE TABLE IF NOT EXISTS paper_runs (
  paper_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, wallet TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS demo_sessions (
  session_id TEXT PRIMARY KEY, wallet TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS forecasts (
  forecast_id TEXT PRIMARY KEY, wallet TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_wallet ON events(wallet, seq);
CREATE INDEX IF NOT EXISTS events_day ON events(day, seq);
CREATE INDEX IF NOT EXISTS claims_wallet ON claims(wallet);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self.write_lock = threading.RLock()
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    def connect(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=30, isolation_level=None, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.conn = conn
        return conn

    def execute(self, sql: str, params=()) -> sqlite3.Cursor:
        with self.write_lock:
            return self.connect().execute(sql, params)

    def one(self, sql: str, params=()) -> sqlite3.Row | None:
        return self.connect().execute(sql, params).fetchone()

    def all(self, sql: str, params=()) -> list[sqlite3.Row]:
        return self.connect().execute(sql, params).fetchall()
