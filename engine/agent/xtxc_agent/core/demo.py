"""Public demo protections (XTXC_MODE=demo).

- Every visitor gets a session cookie and one of the sidecar's demo wallets (loopback chain, test tokens only).
  The server signs only for that wallet, and every request that names a wallet must name that one.
- Requests that call the model are rate limited per client IP; the daily token budget lives in kiln.py.
In dev mode none of this applies.
"""

from __future__ import annotations

import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from .db import Database, now_iso
from .i18n import tr

COOKIE = "xtxc_session"
SESSION_HOURS = 6


class DemoForbidden(RuntimeError):
    pass


class RateLimited(RuntimeError):
    pass


class RateLimiter:
    def __init__(self):
        self._hits: dict[tuple[str, str], deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, bucket: str, key: str, limit: int, window_s: int) -> None:
        now = time.monotonic()
        with self._lock:
            q = self._hits[(bucket, key)]
            while q and now - q[0] > window_s:
                q.popleft()
            if len(q) >= limit:
                wait_min = max(1, int((window_s - (now - q[0])) // 60) + 1)
                raise RateLimited(tr("err.rate", m=wait_min))
            q.append(now)


class DemoSessions:
    def __init__(self, db: Database, demo_wallets_fn):
        self.db = db
        self.demo_wallets_fn = demo_wallets_fn      # () -> [wallet address] of the sidecar's demo wallets
        self._lock = threading.Lock()

    def wallet_for(self, session_id: str | None) -> str | None:
        if not session_id:
            return None
        row = self.db.one("SELECT wallet, last_seen FROM demo_sessions WHERE session_id = ?", (session_id,))
        if not row:
            return None
        self.db.execute("UPDATE demo_sessions SET last_seen = ? WHERE session_id = ?", (now_iso(), session_id))
        return row["wallet"]

    def assign(self, session_id: str | None) -> tuple[str, str]:
        """(session_id, wallet). Keeps the visitor's wallet while the sidecar still has it; otherwise hands out the
        demo wallet idle the longest (a fresh one if any is unused)."""
        with self._lock:
            wallets = self.demo_wallets_fn()
            if not wallets:
                raise DemoForbidden(tr("err.demo.wallets_not_ready"))
            current = self.wallet_for(session_id)
            if current in wallets:
                return session_id, current
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=SESSION_HOURS)).isoformat()
            last = {w: None for w in wallets}
            for r in self.db.all("SELECT wallet, MAX(last_seen) seen FROM demo_sessions GROUP BY wallet"):
                if r["wallet"] in last:
                    last[r["wallet"]] = r["seen"]
            free = [w for w in wallets if last[w] is None or last[w] < cutoff]
            pool = free or wallets
            wallet = min(pool, key=lambda w: last[w] or "")
            sid = secrets.token_urlsafe(32)          # never adopt an id the client made up
            self.db.execute("INSERT OR REPLACE INTO demo_sessions(session_id, wallet, created_at, last_seen) VALUES (?,?,?,?)",
                            (sid, wallet, now_iso(), now_iso()))
            return sid, wallet
