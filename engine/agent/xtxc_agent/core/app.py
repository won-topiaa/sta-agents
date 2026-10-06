"""FastAPI application: wires storage, model, research, orders, chain and the web UI."""

from __future__ import annotations

import json
import os
import types
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from urllib.parse import parse_qs

from ..chain.client import ChainError, LocalChain
from . import i18n
from .i18n import tr
from .ask import Asker
from .briefs import BriefError, Briefs
from .chat import Chat, ChatError
from .paper import Paper
from .claims import Claims
from .config import load_settings
from .db import Database, dumps, new_id, now_iso
from .demo import COOKIE, SESSION_HOURS, DemoForbidden, DemoSessions, RateLimited, RateLimiter
from .execution import ExecutionError, Executor
from .forecasts import ForecastError, Forecaster, horizon_choices
from .kiln import Kiln, ModelOutputInvalid, ModelUnavailable
from .ledger import Ledger
from .orders import Planner
from .prices import closes_at
from .research_runner import ResearchRunner


def _research_namespace():
    from ..research import backtest, evaluator, execution_costs, marketdata, strategies, universe
    return types.SimpleNamespace(universe=universe, marketdata=marketdata, strategies=strategies, backtest=backtest,
                                 evaluator=evaluator, execution_costs=execution_costs)


def create_app(start_watcher: bool = True) -> FastAPI:
    settings = load_settings()
    db = Database(settings.db_path)
    ledger = Ledger(db)
    claims = Claims(db)
    kiln = Kiln(settings, db)
    chain = LocalChain(settings.sidecar_url)
    research = _research_namespace()

    @lru_cache(maxsize=1)
    def universe_map():
        return {i.ticker: i for i in research.universe.load_universe()}

    def closes(snapshot_id: str, tickers: list[str], at: str | None = None):
        out, as_of = closes_at(research.marketdata.load_prices(snapshot_id, field="close"), tickers, at)
        missing = [t for t in tickers if t not in out]
        if missing:  # e.g. a stock still held but excluded from the new conditions
            extra_snap = research.marketdata.build_snapshot(sorted(missing))
            extra, _ = closes_at(research.marketdata.load_prices(extra_snap.snapshot_id, field="close"), missing, at)
            out.update(extra)
        return out, as_of

    briefs = Briefs(settings, db, ledger, kiln, universe_map)
    runner = ResearchRunner(settings, db, ledger, kiln, chain, research)
    planner = Planner(settings, db, ledger, claims, chain, universe_map, closes)
    executor = Executor(settings, db, ledger, claims, chain, planner, kiln)
    asker = Asker(db, ledger, kiln)
    paper = Paper(db, ledger, research)
    chat = Chat(db, ledger, kiln, briefs, runner, executor, asker)
    forecaster = Forecaster(settings, db, ledger, universe_map, claims=claims)
    if settings.mode in ("demo", "prod") or os.environ.get("XTXC_PRICE_SOURCE") == "quant":
        paper.daily = forecaster.models.daily         # paper runs move forward every session (tape continuation)

    app = FastAPI(title="XTXC Agent", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json")

    class LanguageMiddleware:
        """The whole request speaks the language in `X-Lang` (or `?lang=`): en (default), ko, zh."""

        def __init__(self, inner):
            self.inner = inner

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                return await self.inner(scope, receive, send)
            raw = dict(scope.get("headers") or []).get(b"x-lang", b"").decode("latin-1")
            if not raw:
                raw = parse_qs(scope.get("query_string", b"").decode("latin-1")).get("lang", [""])[0]
            token = i18n.set_lang(raw)
            try:
                await self.inner(scope, receive, send)
            finally:
                i18n._current.reset(token)

    app.add_middleware(LanguageMiddleware)
    app.state.settings, app.state.db, app.state.executor = settings, db, executor

    # ------------------------------------------------------------ demo guard
    demo = settings.mode == "demo"
    limiter = RateLimiter()
    sessions = DemoSessions(db, lambda: [w["wallet"] for w in chain.status()["wallets"] if w["role"] == "demo"]) if demo else None

    def client_ip(request: Request) -> str:
        # only nginx on loopback can reach the API; it sets X-Real-IP to the visitor's address
        return request.headers.get("x-real-ip") or (request.client.host if request.client else "?")

    def limit(request: Request, bucket: str, n: int | None = None, window_s: int = 600) -> None:
        if demo:
            limiter.hit(bucket, client_ip(request), n or settings.ai_requests_per_10min, window_s)

    def guard(request: Request, *wallets: str | None) -> str | None:
        """Demo: every wallet a request names (or the resource it touches belongs to) must be this visitor's."""
        if not demo:
            return wallets[0] if wallets else None
        mine = sessions.wallet_for(request.cookies.get(COOKIE))
        if not mine:
            raise DemoForbidden(tr("err.demo.connect_first"))
        if any(w and w != mine for w in wallets):
            raise DemoForbidden(tr("err.demo.not_your_wallet"))
        return mine

    @app.exception_handler(DemoForbidden)
    async def _forbidden(_: Request, exc: DemoForbidden):
        return JSONResponse({"detail_ko": str(exc)}, status_code=403)

    @app.exception_handler(RateLimited)
    async def _limited(_: Request, exc: RateLimited):
        return JSONResponse({"detail_ko": str(exc)}, status_code=429)

    @app.exception_handler(BriefError)
    async def _brief(_: Request, exc: BriefError):
        return JSONResponse({"detail_ko": str(exc)}, status_code=400)

    @app.exception_handler(ChatError)
    async def _chat(_: Request, exc: ChatError):
        return JSONResponse({"detail_ko": str(exc)}, status_code=400)

    @app.exception_handler(ForecastError)
    async def _forecast_err(_: Request, exc: ForecastError):
        return JSONResponse({"detail_ko": str(exc)}, status_code=400)

    @app.exception_handler(ModelUnavailable)
    async def _model(_: Request, exc: ModelUnavailable):
        return JSONResponse({"detail_ko": tr("err.ai_unavailable"), "detail": str(exc)}, status_code=503)

    @app.exception_handler(ModelOutputInvalid)
    async def _invalid(_: Request, exc: ModelOutputInvalid):
        return JSONResponse({"detail_ko": tr("err.ai_invalid"), "detail": str(exc)}, status_code=422)

    @app.exception_handler(ExecutionError)
    async def _exec(_: Request, exc: ExecutionError):
        return JSONResponse({"detail_ko": str(exc)}, status_code=409)

    @app.exception_handler(ChainError)
    async def _chain(_: Request, exc: ChainError):
        return JSONResponse({"detail_ko": tr("err.chain"), "detail": str(exc)}, status_code=502)

    async def body(request: Request) -> dict:
        try:
            return await request.json()
        except Exception:
            return {}

    # ---------------------------------------------------------------- basics
    @app.get("/api/health")
    def health():
        try:
            st = chain.status()
            chain_ok, genesis = True, st["genesis"]
        except ChainError:
            chain_ok, genesis = False, None
        sim = chain.market_status() if chain_ok and settings.dev_wallet else {"enabled": False}
        market_sim = None
        if sim.get("enabled"):
            market_sim = {"enabled": True, "delay_seconds": sim["delaySeconds"], "unsupported": sim.get("unsupported", []),
                          "note_ko": tr("sim.note", s=sim["delaySeconds"])}
        return {"ok": True, "mode": settings.mode, "lang": i18n.lang(), "langs": list(i18n.LANGS),
                "chain": chain.network, "chain_ok": chain_ok, "genesis": genesis,
                "model": settings.kiln_model if settings.kiln_configured else None, "dev_wallet": settings.dev_wallet,
                "limits": {"ai_requests_per_10min": settings.ai_requests_per_10min} if demo else None, "market_sim": market_sim,
                "recorder": recorder_health()}

    def recorder_health() -> dict:
        """Who records the execution tape right now (the dedicated service or this process), from its heartbeat."""
        from ..research.exectape import Tape
        out = {"standby": app.state.standby.health() if getattr(app.state, "standby", None) else None}
        try:
            if forecaster.tape_path.exists():
                hb = Tape(forecaster.tape_path).meta("heartbeat")
                if hb:
                    out["heartbeat"] = {k: hb.get(k) for k in ("who", "at", "last_bars_round", "last_quote", "quote_sets", "bars_rounds", "last_error")}
                out["tape"] = forecaster.models.tape.counts()
        except Exception as exc:  # health must answer even when the tape is busy or missing
            out["error"] = str(exc)[:120]
        return out

    @app.get("/api/universe")
    def universe():
        return [{"ticker": i.ticker, "name_ko": i.name_ko, "name_en": i.name_short_en or i.name_en, "name_zh": i.name_zh,
                 "name_legal": i.name_en, "sector": i.sector, "kind": i.kind,
                 "products": list(i.products)} for i in universe_map().values()]

    # ---------------------------------------------------------------- briefs
    @app.post("/api/briefs")
    async def create_brief(request: Request):
        b = await body(request)
        wallet = guard(request, b.get("wallet"))
        limit(request, "ai")
        return briefs.create(b.get("text", ""), wallet)

    @app.get("/api/briefs/{brief_id}")
    def get_brief(brief_id: str, request: Request):
        brief = briefs.get(brief_id)
        guard(request, brief.get("wallet"))
        return brief

    @app.patch("/api/briefs/{brief_id}")
    async def patch_brief(brief_id: str, request: Request):
        b = await body(request)
        wallet = guard(request, b.pop("wallet", None), briefs.get(brief_id).get("wallet"))
        limit(request, "write", 60)
        return briefs.patch(brief_id, b, wallet)

    @app.post("/api/briefs/{brief_id}/confirm")
    async def confirm_brief(brief_id: str, request: Request):
        wallet = guard(request, (await body(request)).get("wallet"), briefs.get(brief_id).get("wallet"))
        return briefs.confirm(brief_id, wallet)

    # -------------------------------------------------------------- research
    @app.post("/api/research")
    async def start_research(request: Request):
        b = await body(request)
        brief = briefs.get(b["brief_id"])
        guard(request, brief.get("wallet"))
        limit(request, "ai")
        return {"run_id": runner.start(brief)}

    @app.get("/api/research/{run_id}")
    def get_research(run_id: str):
        try:
            return runner.get(run_id)
        except KeyError:
            return JSONResponse({"detail_ko": tr("err.research_not_found")}, status_code=404)

    # ----------------------------------------------------------------- plans
    @app.post("/api/plans")
    async def create_plan(request: Request):
        b = await body(request)
        run = runner.get(b["run_id"])
        if run["status"] != "done":
            raise ExecutionError(tr("err.plan.research_running"))
        if run.get("verdict") == "fail":
            raise ExecutionError(tr("err.plan.research_failed"))
        brief = briefs.get(run["brief_id"], run["brief_version"])
        guard(request, b["wallet"], brief.get("wallet"))
        limit(request, "write", 60)
        current = db.one("SELECT MAX(version) v FROM briefs WHERE brief_id = ? AND status = 'confirmed'", (run["brief_id"],))["v"]
        if run["brief_version"] != current:
            executor.ledger.append("plan.rejected", tr("ledger.plan.rejected", old=run["brief_version"], cur=current),
                                   wallet=b["wallet"], ref=run["run_id"], payload={"run_version": run["brief_version"], "current_version": current})
            raise ExecutionError(tr("err.plan.conditions_changed"))
        # a new card from the same research replaces an unused older one (its quotes are stale)
        older = db.all("SELECT plan_id FROM plans WHERE run_id = ? AND wallet = ? AND status = 'shown'", (run["run_id"], b["wallet"]))
        plan = planner.build(run, brief, b["wallet"])
        for r in older:
            db.execute("UPDATE plans SET status = 'superseded', updated_at = ? WHERE plan_id = ?", (now_iso(), r["plan_id"]))
        if older:
            executor.ledger.append("plan.replaced", tr("ledger.plan.replaced"), wallet=b["wallet"],
                                   ref=plan["plan_id"], payload={"replaced": [r["plan_id"] for r in older]})
        return plan

    @app.get("/api/plans/{plan_id}")
    def get_plan(plan_id: str, request: Request):
        plan = executor.plan(plan_id)
        guard(request, plan["wallet"])
        return plan

    @app.post("/api/plans/{plan_id}/prepare")
    async def prepare(plan_id: str, request: Request):
        b = await body(request)
        guard(request, executor.plan(plan_id)["wallet"])
        return executor.prepare(plan_id, b.get("mode", "now"), b.get("condition"))

    @app.post("/api/plans/{plan_id}/submit")
    async def submit(plan_id: str, request: Request):
        guard(request, executor.plan(plan_id)["wallet"])
        return executor.submit(plan_id, (await body(request)).get("signed", []))

    @app.post("/api/stop")
    async def stop(request: Request):
        return executor.stop_all(guard(request, (await body(request))["wallet"]))

    @app.post("/api/stop/submit")
    async def stop_submit(request: Request):
        b = await body(request)
        return executor.submit_stop(guard(request, b["wallet"]), b.get("signed", []))

    # --------------------------------------------------------------- records
    @app.get("/api/records")
    def records(request: Request, wallet: str | None = None, limit: int = 100):
        return executor.ledger.events(guard(request, wallet), min(limit, 500))

    @app.get("/api/receipts/{receipt_id}")
    def receipt(receipt_id: str, request: Request):
        row = db.one("SELECT body, wallet FROM receipts WHERE receipt_id = ?", (receipt_id,))
        if not row:
            return JSONResponse({"detail_ko": tr("err.receipt_not_found")}, status_code=404)
        guard(request, row["wallet"])
        return json.loads(row["body"])

    @app.get("/api/receipts")
    def receipts(wallet: str, request: Request):
        wallet = guard(request, wallet)
        return [json.loads(r["body"]) for r in db.all("SELECT body FROM receipts WHERE wallet = ? ORDER BY created_at DESC LIMIT 50", (wallet,))]

    @app.get("/api/pending")
    def pending(wallet: str, request: Request):
        wallet = guard(request, wallet)
        rows = db.all("SELECT prep_id, plan_id, mode, status, body, created_at FROM prepared WHERE wallet = ? AND status IN "
                      "('presigned_waiting','notify_waiting','notify_ready') ORDER BY created_at DESC", (wallet,))
        out = []
        for r in rows:
            b = json.loads(r["body"])
            state = b.get("group_state") or []
            out.append({"prep_id": r["prep_id"], "plan_id": r["plan_id"], "mode": r["mode"], "status": r["status"],
                        "condition": b.get("condition"), "last_check": b.get("last_check"), "created_at": r["created_at"],
                        "deadline": (b.get("condition") or {}).get("deadline"),
                        "progress": {"rounds_total": len(state), "rounds_done": sum(1 for x in state if x == "filled"),
                                     "deadline": (b.get("condition") or {}).get("deadline"),
                                     "labels_ko": b.get("group_labels"), "offsets_min": b.get("offsets_min"),
                                     "started_at": b.get("started_at"), "next": b.get("last_wait")}})
        return out

    # ---------------------------------------------------------- conversation
    @app.get("/api/session")
    def session(wallet: str, request: Request):
        """Where this wallet is in the flow, so the conversation can be rebuilt when the browser forgot it."""
        wallet = guard(request, wallet)
        out = {"stage": "start", "brief_id": None, "run_id": None, "plan_id": None, "receipt_id": None}
        b = db.one("SELECT brief_id, created_at FROM briefs WHERE wallet = ? ORDER BY created_at DESC LIMIT 1", (wallet,))
        if not b:
            return out
        brief = briefs.get(b["brief_id"])
        out.update(brief_id=brief["brief_id"], stage="brief")
        run = db.one("SELECT run_id, status, brief_version FROM runs WHERE brief_id = ? ORDER BY created_at DESC LIMIT 1", (brief["brief_id"],))
        if run and run["brief_version"] == brief["version"] and brief["status"] == "confirmed":
            out.update(run_id=run["run_id"], stage="research")
            plan = db.one("SELECT plan_id, status FROM plans WHERE run_id = ? AND wallet = ? ORDER BY created_at DESC LIMIT 1", (run["run_id"], wallet))
            if plan:
                out.update(plan_id=plan["plan_id"], stage={"presigned": "waiting", "waiting": "waiting", "ready": "waiting",
                                                            "done": "receipt", "partial": "receipt"}.get(plan["status"], "plan"))
                rc = db.one("SELECT receipt_id FROM receipts WHERE plan_id = ? ORDER BY created_at DESC LIMIT 1", (plan["plan_id"],))
                if rc:
                    out["receipt_id"] = rc["receipt_id"]
        if db.one("SELECT 1 FROM prepared WHERE wallet = ? AND status IN ('presigned_waiting','notify_waiting','notify_ready')", (wallet,)):
            out["stage"] = "waiting"
        return out

    @app.get("/api/glossary")
    def glossary():
        """Plain definitions for the term chips in the conversation (no model call)."""
        return i18n.glossary()

    @app.post("/api/chat")
    async def chat_turn(request: Request):
        """One typed message = at most one model call (a new strategy is compiled by the brief flow instead).
        Buttons in the conversation use the ordinary endpoints and never call this."""
        b = await body(request)
        wallet = guard(request, b.get("wallet"))
        if not wallet:
            raise ChatError(tr("err.wallet_first"))
        refs = {k: b[k] for k in ("brief_id", "run_id", "plan_id", "receipt_id") if isinstance(b.get(k), str) and b.get(k)}
        if isinstance(b.get("forecast"), dict):     # what the agent already knows while it asks for stocks or a period
            refs["forecast"] = {"tickers": [str(t)[:12] for t in (b["forecast"].get("tickers") or [])][:5] if isinstance(b["forecast"].get("tickers"), list) else [],
                                "horizon": str(b["forecast"]["horizon"])[:8] if b["forecast"].get("horizon") else None}
        owners = []
        if refs.get("brief_id"):
            owners.append(briefs.get(refs["brief_id"]).get("wallet"))
        if refs.get("run_id"):
            try:
                owners.append(briefs.get(runner.get(refs["run_id"])["brief_id"]).get("wallet"))
            except KeyError:
                raise ChatError(tr("err.research_not_found"))
        if refs.get("plan_id"):
            owners.append(executor.plan(refs["plan_id"])["wallet"])
        if refs.get("receipt_id"):
            row = db.one("SELECT wallet FROM receipts WHERE receipt_id = ?", (refs["receipt_id"],))
            owners.append(row["wallet"] if row else None)
        if any(o != wallet for o in owners):
            raise DemoForbidden(tr("err.chat.other_wallet"))
        limit(request, "ai")
        return chat.turn(wallet, b.get("message", ""), b.get("stage", "start"), refs)

    # ---------------------------------------------------------------- 변동 예측 (no model call: chips and the card)
    @app.get("/api/forecast/horizons")
    def forecast_horizons():
        return {"choices": horizon_choices()}

    @app.post("/api/forecast")
    async def forecast(request: Request):
        """Tickers + horizon (a chip or what chat_turn understood) -> the forecast card. Code only, no model call."""
        b = await body(request)
        wallet = guard(request, b.get("wallet"))
        limit(request, "forecast", 30)
        brief = None
        if isinstance(b.get("brief_id"), str) and b["brief_id"]:
            try:
                brief = briefs.get(b["brief_id"])
            except Exception:
                brief = None
            if brief and demo and brief.get("wallet") != wallet:
                raise DemoForbidden(tr("err.chat.other_wallet"))
        size = b.get("size_usd")
        if size is not None and not isinstance(size, (int, float)):
            raise ForecastError(tr("fc.err.size"))
        return forecaster.forecast(wallet, b.get("tickers"), str(b.get("horizon") or ""),
                                   size_usd=size or forecaster.size_for(brief), fx=(brief or {}).get("fx_krw_per_usdc"))

    @app.get("/api/forecast/{forecast_id}")
    def forecast_get(forecast_id: str, request: Request):
        try:
            f = forecaster.get(forecast_id)
        except KeyError:
            raise HTTPException(404, tr("fc.err.not_found"))
        guard(request, f.get("wallet"))
        return f

    @app.post("/api/ask")
    async def ask(request: Request):
        b = await body(request)
        wallet = guard(request, b["wallet"])
        limit(request, "ai")
        try:
            return asker.ask(wallet, b.get("question", ""), b.get("receipt_id"))
        except ValueError as exc:
            return JSONResponse({"detail_ko": str(exc)}, status_code=400)

    @app.post("/api/paper")
    async def paper_start(request: Request):
        b = await body(request)
        wallet = guard(request, b["wallet"])
        limit(request, "write", 60)
        try:
            return paper.start(runner.get(b["run_id"]), wallet)
        except (KeyError, ValueError) as exc:
            return JSONResponse({"detail_ko": str(exc) if isinstance(exc, ValueError) else tr("err.research_not_found")}, status_code=400)

    @app.get("/api/paper")
    def paper_list(wallet: str, request: Request):
        return paper.list(guard(request, wallet))

    @app.get("/api/paper/{paper_id}")
    def paper_status(paper_id: str):
        try:
            return paper.status(paper_id)
        except KeyError:
            return JSONResponse({"detail_ko": tr("err.paper_not_found")}, status_code=404)

    @app.get("/api/scorecard")
    def scorecard(wallet: str | None = None):
        return claims.scorecard(wallet)

    @app.get("/api/usage")
    def usage(wallet: str | None = None):
        return kiln.usage(wallet)

    @app.get("/api/seal/{day}")
    def seal(day: str):
        return executor.verify_seal(day)

    @app.post("/api/seal/run")
    async def seal_run(request: Request):
        limit(request, "seal", 3)
        b = await body(request)
        return executor.seal_day(b.get("day") or now_iso()[:10])

    # ---------------------------------------------------------- wallet check
    @app.get("/api/walletcheck/tx")
    def walletcheck_tx(wallet: str, request: Request):
        wallet = guard(request, wallet)
        tx = chain.walletcheck_tx(wallet)
        check_id = new_id("wc")
        db.execute("INSERT INTO walletchecks(check_id, wallet, tx, network, created_at) VALUES (?,?,?,?,?)",
                   (check_id, wallet, tx["transaction"], tx["network"], now_iso()))
        return {"check_id": check_id, "transaction": tx["transaction"], "network": tx["network"]}

    @app.post("/api/walletcheck/result")
    async def walletcheck_result(request: Request):
        b = await body(request)
        row = db.one("SELECT * FROM walletchecks WHERE check_id = ?", (b["check_id"],))
        if not row:
            return JSONResponse({"detail_ko": tr("err.walletcheck_not_found")}, status_code=404)
        guard(request, row["wallet"])
        v = chain.verify(row["tx"], b["signed"])
        result = {"bytes_match": v["bytesMatch"], "signature_valid": v["signatureValid"], "added_instructions": v["addedInstructions"],
                  "recent_blockhash_changed": v["recentBlockhashChanged"], "warning_shown": b.get("warning_shown"), "note": b.get("note")}
        db.execute("UPDATE walletchecks SET result = ? WHERE check_id = ?", (dumps(result), b["check_id"]))
        executor.ledger.append("walletcheck", tr("ledger.walletcheck.same") if v["bytesMatch"] else tr("ledger.walletcheck.changed"),
                               wallet=row["wallet"], ref=b["check_id"], payload=result)
        return result

    # ------------------------------------------------------------- dev only
    if settings.dev_wallet:
        @app.get("/api/dev/wallet")
        def dev_wallet(request: Request):
            st = chain.status()
            if not demo:
                return next(w for w in st["wallets"] if w["role"] == "dev")
            limit(request, "session", 30)
            sid, wallet = sessions.assign(request.cookies.get(COOKIE))
            w = next(w for w in st["wallets"] if w["wallet"] == wallet)
            resp = JSONResponse({"wallet": w["wallet"], "role": "demo", "nonces": w["nonces"]})
            resp.set_cookie(COOKIE, sid, max_age=SESSION_HOURS * 3600, httponly=True, samesite="lax",
                            secure=settings.cookie_secure, path="/")
            return resp

        @app.post("/api/dev/sign")
        async def dev_sign(request: Request):
            b = await body(request)
            if demo:
                limit(request, "write", 60)
                return {"signed": chain.dev_sign(b.get("transactions", []), guard(request))}
            return {"signed": chain.dev_sign(b.get("transactions", []))}

        @app.post("/api/dev/market")
        async def dev_market(request: Request):
            if demo:
                guard(request)
                limit(request, "write", 60)
            executor.market_override = (await body(request)).get("open")
            return {"market_override": executor.market_override}

        @app.get("/api/dev/market-sim")
        def dev_market_sim(request: Request, tickers: str = ""):
            if demo:
                guard(request)
            return chain.market_status([t for t in tickers.split(",") if t][:10])

        @app.post("/api/dev/restore")
        async def dev_restore(request: Request):
            """Let the market simulator restore pools now instead of after its delay, then check waiting orders."""
            if demo:
                guard(request)
                limit(request, "write", 60)
            tickers = [t for t in (await body(request)).get("tickers", []) if isinstance(t, str)][:10]
            restored = chain.market_restore(tickers)
            return {"restored": restored.get("actions", []), "actions": executor.watch_once()}

        @app.post("/api/dev/advance")
        async def dev_advance(request: Request):
            """Make the next round of this wallet's sliced orders due now, then check waiting orders."""
            b = await body(request)
            wallet = guard(request, b.get("wallet")) if demo else b.get("wallet")
            if demo:
                limit(request, "write", 60)
            if not wallet:
                raise ExecutionError(tr("err.wallet_needed"))
            return {"moved": executor.fast_forward(wallet), "actions": executor.watch_once()}

        @app.post("/api/dev/watch")
        def dev_watch(request: Request):
            if demo:
                guard(request)
                limit(request, "write", 60)
            return {"actions": executor.watch_once()}

    web_dir = Path(__file__).resolve().parent.parent / "web"
    if (web_dir / "index.html").exists():
        app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")

    if start_watcher:
        executor.start_watcher()
        forecaster.warm()
        forecaster.start_scorer()
        if os.environ.get("XTXC_RECORDER", "1") != "0":
            # standby: records only while the dedicated recorder service is down (one lock file next to the tape)
            from ..research.exectape import Standby
            app.state.standby = Standby(forecaster.tape_path, "api", yield_to="service")
            app.state.standby.start()
    return app
