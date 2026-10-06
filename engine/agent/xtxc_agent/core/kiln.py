"""Kiln (Bricksum) client for Qwen3 32B with per-flow token accounting.

Rules that make the model cheap and safe to use:
- Thinking is off unless a flow asks for it (measured: ~78% fewer output tokens).
- Identical (flow, model, messages) requests are answered from cache: 0 tokens.
- Output is a draft. Every answer passes a code validator; a bounded number of
  repair attempts is allowed, then the flow fails. No silent model fallback.
- The model never produces numbers shown to users (see prompts.py).
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable

from .config import Settings
from .db import Database, dumps, new_id, now_iso


class ModelUnavailable(RuntimeError):
    pass


class ModelOutputInvalid(RuntimeError):
    pass


@dataclass
class ModelResult:
    value: object
    call_id: str
    cache_hit: bool
    usage: dict


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def extract_json(text: str):
    """Qwen often wraps JSON in ``` fences or adds a leading newline."""
    cleaned = _FENCE.sub("", text.strip()).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end <= start:
            raise ModelOutputInvalid("no JSON object in model output")
        return json.loads(cleaned[start : end + 1])


class Kiln:
    def __init__(self, settings: Settings, db: Database, transport: Callable[[dict], dict] | None = None):
        self.settings = settings
        self.db = db
        self._transport = transport or self._http

    # ----------------------------------------------------------------- http
    def _http(self, body: dict) -> dict:
        if not self.settings.kiln_configured:
            raise ModelUnavailable("Kiln is not configured")
        req = urllib.request.Request(
            self.settings.kiln_base_url.rstrip("/") + "/chat/completions",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": "Bearer " + self.settings.kiln_api_key,
                "Content-Type": "application/json",
                # Cloudflare in front of Kiln rejects urllib's default agent (error 1010).
                "User-Agent": self.settings.kiln_user_agent,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                raw = resp.read(256_001)
        except urllib.error.HTTPError as exc:
            raise ModelUnavailable(f"HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise ModelUnavailable(type(exc).__name__) from exc
        if len(raw) > 256_000:
            raise ModelUnavailable("response too large")
        return json.loads(raw.decode("utf-8"))

    # ---------------------------------------------------------------- calls
    def complete_json(
        self,
        flow: str,
        messages: list[dict],
        validate: Callable[[object], object],
        *,
        thinking: bool = False,
        max_tokens: int = 700,
        repair_attempts: int = 2,
        wallet: str | None = None,
        ref: str | None = None,
        use_cache: bool = True,
    ) -> ModelResult:
        model = self.settings.kiln_model or "unconfigured"
        cache_key = hashlib.sha256(dumps({"flow": flow, "model": model, "thinking": thinking, "messages": messages}).encode()).hexdigest()
        prompt_sha = hashlib.sha256(dumps(messages).encode()).hexdigest()
        if use_cache:
            row = self.db.one("SELECT response, source_call FROM ai_cache WHERE cache_key = ?", (cache_key,))
            if row:
                try:
                    value = validate(json.loads(row["response"]))
                except Exception:  # stale cache entry against a newer validator
                    value = None
                if value is not None:
                    self.db.execute("UPDATE ai_cache SET hits = hits + 1 WHERE cache_key = ?", (cache_key,))
                    call_id = self._record(flow, model, thinking, prompt_sha, {}, 0, 0, "CACHE_HIT", True, wallet, ref)
                    return ModelResult(value, call_id, True, {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0})

        if self.settings.daily_token_budget:
            used = self.db.one("SELECT COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) n FROM ai_calls WHERE ts >= ?",
                               (now_iso()[:10],))["n"]
            if used >= self.settings.daily_token_budget:
                self._record(flow, model, thinking, prompt_sha, {}, 0, 0, "BUDGET_EXCEEDED", False, wallet, ref)
                raise ModelUnavailable("daily token budget reached")
        convo = list(messages)
        totals = {"input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "cached_tokens": 0, "cost_usd": 0.0}
        started = time.monotonic()
        last_error = "no attempt"
        for attempt in range(1, repair_attempts + 2):
            body = {"model": model, "temperature": 0, "max_tokens": max_tokens, "messages": convo,
                    "chat_template_kwargs": {"enable_thinking": thinking}}
            try:
                resp = self._transport(body)
            except ModelUnavailable as exc:
                self._record(flow, model, thinking, prompt_sha, totals, int((time.monotonic() - started) * 1000),
                             attempt, f"UNAVAILABLE:{exc}", False, wallet, ref)
                raise
            usage = resp.get("usage") or {}
            totals["input_tokens"] += int(usage.get("prompt_tokens") or 0)
            totals["output_tokens"] += int(usage.get("completion_tokens") or 0)
            totals["reasoning_tokens"] += int((usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0)
            totals["cached_tokens"] += int((usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
            totals["cost_usd"] += float(usage.get("cost") or 0.0)
            content = ((resp.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            try:
                parsed = extract_json(content)
                value = validate(parsed)
                latency = int((time.monotonic() - started) * 1000)
                call_id = self._record(flow, model, thinking, prompt_sha, totals, latency, attempt, "OK", False, wallet, ref)
                if use_cache:
                    self.db.execute(
                        "INSERT OR REPLACE INTO ai_cache(cache_key, flow, response, source_call, created_at, hits) VALUES (?,?,?,?,?,0)",
                        (cache_key, flow, dumps(parsed), call_id, now_iso()),  # raw answer; re-validated on every hit
                    )
                return ModelResult(value, call_id, False, dict(totals))
            except (ModelOutputInvalid, ValueError, KeyError, TypeError) as exc:
                last_error = str(exc)[:300]
                convo = convo + [
                    {"role": "assistant", "content": content[:2000]},
                    {"role": "user", "content": f"That answer was rejected by the validator: {last_error}. Reply again with only the corrected JSON object."},
                ]
        latency = int((time.monotonic() - started) * 1000)
        self._record(flow, model, thinking, prompt_sha, totals, latency, repair_attempts + 1, f"INVALID:{last_error[:120]}", False, wallet, ref)
        raise ModelOutputInvalid(last_error)

    def _record(self, flow, model, thinking, prompt_sha, totals, latency_ms, attempts, outcome, cache_hit, wallet, ref) -> str:
        call_id = new_id("ai")
        self.db.execute(
            "INSERT INTO ai_calls(call_id, ts, flow, model, thinking, prompt_sha, input_tokens, output_tokens, reasoning_tokens,"
            " cached_tokens, cost_usd, latency_ms, attempts, outcome, cache_hit, wallet, ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (call_id, now_iso(), flow, model, int(thinking), prompt_sha, totals.get("input_tokens", 0), totals.get("output_tokens", 0),
             totals.get("reasoning_tokens", 0), totals.get("cached_tokens", 0), totals.get("cost_usd", 0.0), latency_ms,
             attempts, outcome, int(cache_hit), wallet, ref),
        )
        return call_id

    # ---------------------------------------------------------------- usage
    def usage(self, wallet: str | None = None) -> dict:
        where, params = ("WHERE wallet = ?", (wallet,)) if wallet else ("", ())
        flows = self.db.all(
            f"SELECT flow, COUNT(*) calls, SUM(cache_hit) cache_hits, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,"
            f" SUM(reasoning_tokens) reasoning_tokens, SUM(cached_tokens) cached_tokens, SUM(cost_usd) cost_usd, AVG(latency_ms) avg_latency_ms,"
            f" SUM(CASE WHEN outcome LIKE 'INVALID%' THEN 1 ELSE 0 END) invalid FROM ai_calls {where} GROUP BY flow ORDER BY flow",
            params,
        )
        rows = [dict(r) for r in flows]
        total = {k: sum((r[k] or 0) for r in rows) for k in ("calls", "cache_hits", "input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens", "cost_usd", "invalid")}
        research = self.db.one("SELECT COUNT(*) runs, SUM(cache_hit) hits FROM runs" + (" WHERE wallet = ?" if wallet else ""), params)
        return {"model": self.settings.kiln_model, "flows": rows, "total": total,
                "research_runs": research["runs"] or 0, "research_cache_hits": research["hits"] or 0}
