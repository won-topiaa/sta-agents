"""Chain backend client.

`LocalChain` talks to the loopback sidecar (captured StockMesh routes on a
solana-test-validator). A production adapter must implement the same methods
against the StockMesh quote/prepare/submit API plus the durable-nonce and memo
extensions described in docs/EXPERIMENT_PRESIGN_20260929.md; it is not wired
here because production signing/submission is not authorised in this phase.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request


class ChainError(RuntimeError):
    pass


class LocalChain:
    network = "local"

    def __init__(self, base_url: str):
        self.base = base_url.rstrip("/")

    def _call(self, method: str, path: str, body: dict | None = None, timeout: float = 120):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            try:
                detail = json.loads(exc.read()).get("error")
            except Exception:
                detail = str(exc)
            raise ChainError(detail) from exc
        except urllib.error.URLError as exc:
            raise ChainError(f"chain sidecar unavailable: {exc.reason}") from exc

    def status(self) -> dict:
        return self._call("GET", "/status", timeout=10)

    def quote(self, ticker: str, side: str, input_atoms: int, wallet: str | None = None) -> dict:
        body = {"ticker": ticker, "side": side, "input": str(input_atoms)}
        if wallet:
            body["wallet"] = wallet
        return self._call("POST", "/quote", body)

    def round_trip(self, ticker: str, input_atoms: int) -> dict:
        return self._call("POST", "/roundtrip", {"ticker": ticker, "input": str(input_atoms)})

    def holdings(self, wallet: str) -> list[dict]:
        return self._call("GET", f"/holdings?wallet={wallet}")

    def prepare(self, wallet: str, orders: list[dict], plan_hash: str, mode: str, deadline_seconds: int | None = None) -> dict:
        return self._call("POST", "/prepare", {"wallet": wallet, "orders": orders, "planHash": plan_hash, "mode": mode,
                                               "deadlineSeconds": deadline_seconds})

    def verify(self, unsigned: str, signed: str) -> dict:
        return self._call("POST", "/verify", {"unsigned": unsigned, "signed": signed})

    def submit(self, signed: str, preflight: bool = True) -> dict:
        return self._call("POST", "/submit", {"signed": signed, "preflight": preflight})

    def simulate(self, signed: str) -> dict:
        return self._call("POST", "/simulate", {"signed": signed})

    def cancel_tx(self, wallet: str) -> dict | None:
        return self._call("POST", "/cancel", {"wallet": wallet})

    def release(self, nonces: list[str]) -> dict:
        return self._call("POST", "/release", {"nonces": nonces}) if nonces else {"released": []}

    def seal(self, memo: str) -> dict:
        return self._call("POST", "/seal", {"memo": memo})

    def devnet_status(self) -> dict:
        try:
            return self._call("GET", "/devnet", timeout=5)
        except ChainError:
            return {"enabled": False}

    def devnet_record(self, memo: str) -> dict:
        return self._call("POST", "/devnet/record", {"memo": memo}, timeout=90)

    def market_status(self, tickers: list[str] | None = None) -> dict:
        """Demo market simulator (plays the other traders who bring a pool back after a trade)."""
        try:
            return self._call("GET", "/market?tickers=" + ",".join(tickers or []), timeout=60)
        except ChainError:
            return {"enabled": False}

    def market_restore(self, tickers: list[str] | None = None) -> dict:
        return self._call("POST", "/market/restore", {"tickers": tickers or []}, timeout=120)

    def devnet_memo(self, signature: str) -> str | None:
        return self._call("GET", f"/devnet/memo?signature={signature}", timeout=30).get("memo")

    def memo_of(self, signature: str) -> str | None:
        return self._call("GET", f"/memo?signature={signature}").get("memo")

    def dev_sign(self, transactions: list[str], wallet: str | None = None) -> list[str]:
        return self._call("POST", "/devsign", {"transactions": transactions, "wallet": wallet})["signed"]

    def walletcheck_tx(self, wallet: str) -> dict:
        return self._call("GET", f"/walletcheck?wallet={wallet}")
