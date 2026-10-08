"""Research pipeline: conditions -> data -> backtests (underlying and XTXC-executable)
-> independent evaluation -> plain-Korean explanation. Runs in a worker thread;
progress lists only steps that actually completed, in completion order.

Shared research cache: identical (spec, data snapshot, engine, cost model) is
computed once for every user. The model is only called for explanations, and
identical explanation inputs hit the model cache (0 tokens).
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import traceback
from decimal import Decimal
from pathlib import Path

from .. import ENGINE_VERSION
from . import i18n
from .briefs import SECTOR_KO, TEMPLATE_KO
from .i18n import tr
from .config import Settings
from .db import Database, dumps, new_id, now_iso
from .kiln import Kiln, ModelOutputInvalid, ModelUnavailable
from .ledger import Ledger
from .orders import SLICE_COUNTS, SLICE_TARGET_BPS
from .prices import closes_at
from .prompts import counter_messages, explain_messages, fill, validate_sentences

VERDICT_KO = i18n.Names("verdict")     # names in the current display language
STEP_KO = i18n.Names("step")


def pct(x: float, signed: bool = True) -> str:
    v = x * 100
    text = f"{abs(v):.0f}" if abs(v) >= 10 else f"{abs(v):.1f}"
    sign = ("+" if v >= 0 else "−") if signed else ("−" if v < 0 else "")
    return f"{sign}{text}%"


def explain_inputs(brief: dict, rep: dict) -> tuple[dict, dict]:
    """Facts (no digits, placeholder names) and placeholder values for a finished report. Shared by the report
    explanation flows and the conversation turn."""
    mx, mu = rep["xtxc"]["metrics"], rep["underlying"]["metrics"]
    mb = rep["benchmark"]["metrics"] or {}
    values = {
        "years": i18n.years(rep["period"]["years"]), "total_return_xtxc": pct(mx["total_return"]), "total_return_underlying": pct(mu["total_return"]),
        "benchmark_return": pct(mb.get("total_return", 0.0)), "max_drawdown": pct(mx["max_drawdown"]),
        "drawdown_to": i18n.money(rep["drawdown_krw"]["to"], brief.get("fx_krw_per_usdc")),
        "budget": i18n.money(brief["budget_krw"], brief.get("fx_krw_per_usdc")),
        "holdout_strategy": pct(rep["holdout"]["strategy"] or 0.0), "holdout_benchmark": pct(rep["holdout"]["benchmark"] or 0.0),
        "cost_gap": tr("unit.pp", x=f"{abs(mu['total_return'] - mx['total_return']) * 100:.1f}"),
        "max_weight": pct(float(brief["max_weight"]), signed=False), "min_cash": pct(float(brief["min_cash"]), signed=False),
        "holdout_period": tr("unit.recent_year"),
    }
    facts = {
        "strategy": tr("fact.strategy", sectors=i18n.join(SECTOR_KO.get(s, s) for s in brief["universe"]["sectors"]) or tr("fact.chosen"),
                       template=TEMPLATE_KO.get(brief["template"], brief["template"]), period=tr(f"period.{brief['rebalance']}")),
        "past_period": "{years}",
        "result_if_bought_as_xtxc_tokens_with_measured_token_costs": "{total_return_xtxc}",
        "result_if_bought_as_ordinary_stocks_with_small_stock_costs": "{total_return_underlying}",
        "note_on_results": "both results already include trading costs; never call either one 'before fees'",
        "benchmark_qqq_buy_and_hold": "{benchmark_return}",
        "token_result_beat_benchmark": "yes" if mx["total_return"] > mb.get("total_return", 0.0) else "no",
        "stock_result_beat_benchmark": "yes" if mu["total_return"] > mb.get("total_return", 0.0) else "no",
        "worst_drop": "{max_drawdown}, budget {budget} would have fallen to {drawdown_to}",
        "recent_period_kept_out_of_strategy_design": "{holdout_period}: strategy {holdout_strategy} vs benchmark {holdout_benchmark}; still a past calculation, not real trading",
        "recent_period_beat_benchmark": "yes" if (rep["holdout"]["strategy"] or 0) > (rep["holdout"]["benchmark"] or 0) else "no",
        "token_cost_effect": "token trading costs lowered the result by {cost_gap} versus buying ordinary stocks",
        "stocks_excluded_because_not_buyable_on_xtxc_now": ", ".join(rep["execution"]["no_route"]) or "none",
        "warnings": ", ".join(c["label_ko"] for c in rep["checks"] if c["status"] != "pass") or "none",
        "concentration": "all holdings in one sector" if len(brief["universe"]["sectors"]) == 1 else "several sectors",
    }
    return facts, values


def downsample(dates: list, values: list, limit: int = 260) -> tuple[list, list]:
    if len(dates) <= limit:
        return dates, values
    step = (len(dates) - 1) / (limit - 1)
    idx = sorted({round(i * step) for i in range(limit)})
    return [dates[i] for i in idx], [values[i] for i in idx]


class ResearchRunner:
    def __init__(self, settings: Settings, db: Database, ledger: Ledger, kiln: Kiln, chain, research):
        self.s = settings
        self.db = db
        self.ledger = ledger
        self.kiln = kiln
        self.chain = chain
        self.r = research  # namespace with universe, marketdata, strategies, backtest, evaluator, execution_costs
        # AI-designed strategies run in the isolated runner; its service reads jobs from this spool when it is up
        self.spool = Path(os.environ.get("XTXC_SANDBOX_SPOOL") or Path(settings.data_dir).parent / "sandbox-spool")

    # --------------------------------------------------------------- api
    def start(self, brief: dict) -> str:
        if brief["status"] != "confirmed":
            raise ValueError("confirm the conditions first")
        run_id = new_id("r")
        self.db.execute("INSERT INTO runs(run_id, brief_id, brief_version, wallet, engine_version, status, progress, created_at) VALUES (?,?,?,?,?,?,?,?)",
                        (run_id, brief["brief_id"], brief["version"], brief.get("wallet"), ENGINE_VERSION, "queued", "[]", now_iso()))
        lang = i18n.lang()      # the research thread speaks the language of the person who started it

        def run():
            with i18n.speaking(lang):
                self._run(run_id, brief)
        threading.Thread(target=run, name=f"research-{run_id}", daemon=True).start()
        return run_id

    def get(self, run_id: str) -> dict:
        row = self.db.one("SELECT * FROM runs WHERE run_id = ?", (run_id,))
        if not row:
            raise KeyError(run_id)
        base = {"run_id": run_id, "brief_id": row["brief_id"], "brief_version": row["brief_version"], "status": row["status"],
                "progress": json.loads(row["progress"]), "cache_hit": bool(row["cache_hit"]), "spec_hash": row["spec_hash"],
                "snapshot_id": row["snapshot_id"]}
        if row["report"]:
            base.update(json.loads(row["report"]))
        if row["error"]:
            base["error"] = row["error"]
        return base

    # ----------------------------------------------------------- pipeline
    def _step(self, run_id: str, step: str, status: str = "done", detail: str | None = None) -> None:
        with self.db.write_lock:
            row = self.db.one("SELECT progress FROM runs WHERE run_id = ?", (run_id,))
            progress = json.loads(row["progress"])
            progress.append({"step": step, "label_ko": STEP_KO.get(step, step), "status": status, "detail_ko": detail, "at": now_iso()})
            self.db.execute("UPDATE runs SET progress = ?, status = 'running' WHERE run_id = ?", (dumps(progress), run_id))

    def _cache(self, key: str, compute):
        row = self.db.one("SELECT result FROM research_cache WHERE cache_key = ?", (key,))
        if row:
            self.db.execute("UPDATE research_cache SET hits = hits + 1 WHERE cache_key = ?", (key,))
            return json.loads(row["result"]), True
        value = compute()
        self.db.execute("INSERT OR REPLACE INTO research_cache(cache_key, spec_hash, snapshot_id, engine_version, result, created_at, hits) VALUES (?,?,?,?,?,?,0)",
                        (key, "", "", ENGINE_VERSION, dumps(value), now_iso()))
        return value, False

    def _run(self, run_id: str, brief: dict) -> None:
        try:
            self._pipeline(run_id, brief)
        except Exception as exc:
            self.db.execute("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE run_id = ?",
                            (f"{type(exc).__name__}: {exc}"[:500], now_iso(), run_id))
            self.ledger.append("research.failed", tr("ledger.research.failed", e=type(exc).__name__), wallet=brief.get("wallet"), ref=run_id,
                               payload={"trace": traceback.format_exc()[-1500:]})

    def _pipeline(self, run_id: str, brief: dict) -> None:
        r = self.r
        tickers = list(brief["universe"]["tickers"])
        self._step(run_id, "conditions", detail=tr("step.detail.conditions", v=brief["version"], n=len(tickers)))
        ai = brief["template"] == "ai"            # the AI designs the strategy (strategy_design + isolated runner)
        snapshot = r.marketdata.build_snapshot(sorted(set(tickers) | {"QQQ"} | ({"SPY"} if ai else set())))
        missing = [t for t in tickers if snapshot.coverage.get(t, {}).get("rows", 0) == 0]
        self._step(run_id, "data", detail=tr("step.detail.data", d=snapshot.as_of, src=snapshot.source)
                   + (tr("step.detail.data_missing", m=", ".join(missing)) if missing else ""))
        spec = {"template": "equal_weight" if ai else brief["template"], "params": {}, "universe": [t for t in tickers if t not in missing],
                "max_weight": brief["max_weight"], "min_cash": brief["min_cash"], "rebalance": brief["rebalance"],
                "exclude_leveraged": brief["exclude_leveraged"]}
        spec_hash = r.strategies.spec_hash(spec)
        self.db.execute("UPDATE runs SET spec_hash = ?, snapshot_id = ? WHERE run_id = ?", (spec_hash, snapshot.snapshot_id, run_id))

        # "Profit you can actually buy": measure every candidate on XTXC at the size this plan would trade.
        # A stock that cannot be bought sensibly right now is excluded from the research universe, with the reason.
        order_atoms = int(Decimal(brief["budget_usdc_atoms"]) * Decimal(brief["max_weight"]))
        token_costs, no_route, basis = self._measure_execution(spec["universe"], order_atoms, snapshot.snapshot_id)
        executable = [t for t in spec["universe"] if not token_costs[t].get("excluded_reason_ko")]
        umap = {i.ticker: i for i in r.universe.load_universe()}
        names = {t: i18n.stock_name(umap.get(t), t) for t in tickers}
        reasons = [f"{names.get(t, t)}: {token_costs[t]['excluded_reason_ko']}" for t in no_route]
        exec_check = {"id": "executable", "label_ko": tr("exec.label"),
                      "status": "pass" if not no_route else ("fail" if not executable else "warn"),
                      "detail_ko": (tr("exec.ok") if not no_route else tr("exec.excluded") + "; ".join(reasons))}
        sliced = [tr("exec.slice_name", name=names.get(t, t), n=token_costs[t]["slicing"]["count"]) for t in executable if token_costs[t].get("slicing")]
        if sliced:
            exec_check["detail_ko"] += tr("exec.sliced", names=i18n.join(sliced))
            if exec_check["status"] == "pass":
                exec_check["status"] = "warn"
        if not executable:
            self._step(run_id, "costs", detail=tr("step.detail.no_buyable"))
            report = {"title_ko": f"{brief['title_ko']} v{brief['version']}", "verdict": "fail", "checks": [exec_check],
                      "execution": {"token_costs": token_costs, "no_route": no_route, "price_basis": basis},
                      "names_ko": names, "summary_ko": tr("research.unbuyable"), "counter_opinions_ko": [],
                      "disclaimer_ko": tr("research.disclaimer"), "lang": i18n.lang()}
            self.db.execute("UPDATE runs SET status = 'done', report = ?, finished_at = ? WHERE run_id = ?", (dumps(report), now_iso(), run_id))
            self._step(run_id, "done")
            self.db.execute("UPDATE runs SET status = 'done' WHERE run_id = ?", (run_id,))
            self.ledger.append("research.blocked", tr("ledger.research.blocked", title=report["title_ko"]),
                               wallet=brief.get("wallet"), ref=run_id, payload={"reasons": reasons})
            return
        spec = {**spec, "universe": executable}
        spec_hash = r.strategies.spec_hash(spec)
        self.db.execute("UPDATE runs SET spec_hash = ? WHERE run_id = ?", (spec_hash, run_id))
        # Friction is bucketed to 5 bps: live quotes wiggle with every trade, and a sub-bucket change must not
        # defeat the shared research cache (the report still shows the measured value).
        cost_model_x = {"default_bps": 100.0,
                        "per_ticker_bps": {t: max(5.0, round(token_costs[t]["friction_bps"] / 5) * 5) for t in executable}}
        costs_detail = tr("step.detail.costs") + ", ".join(f"{t} {token_costs[t]['friction_bps']/100:.2f}%" for t in executable[:5])
        if no_route:
            costs_detail += tr("step.detail.costs_excluded") + ", ".join(f"{t}({token_costs[t]['excluded_reason_ko']})" for t in no_route)
        self._step(run_id, "costs", detail=costs_detail)

        design = None
        if ai:
            spec, design = self._design(run_id, brief, spec, snapshot, cost_model_x, names)
            spec_hash = r.strategies.spec_hash(spec)
            self.db.execute("UPDATE runs SET spec_hash = ? WHERE run_id = ?", (spec_hash, run_id))
            prices_ai = r.marketdata.load_prices(snapshot.snapshot_id)
            run_bt = lambda cm: self._isolated_backtest(spec, prices_ai, cm, snapshot.snapshot_id, design)
        else:
            run_bt = lambda cm: r.backtest.run_backtest(spec, snapshot.snapshot_id, cm)

        base_key = hashlib.sha256(f"u|{spec_hash}|{snapshot.snapshot_id}|{ENGINE_VERSION}".encode()).hexdigest()
        x_key = hashlib.sha256(f"x|{spec_hash}|{snapshot.snapshot_id}|{ENGINE_VERSION}|{dumps(cost_model_x)}".encode()).hexdigest()
        res_u, hit_u = self._cache(base_key, lambda: run_bt({"default_bps": 5.0, "per_ticker_bps": {}}))
        res_x, hit_x = self._cache(x_key, lambda: run_bt(cost_model_x))
        cache_hit = hit_u and hit_x
        self._step(run_id, "backtest", detail=(tr("step.detail.cache") if cache_hit else tr("step.detail.fresh"))
                   + (tr("step.detail.isolated_bt") if ai else ""))

        attempts = self.db.one("SELECT COUNT(*) n FROM runs WHERE brief_id = ?", (brief["brief_id"],))["n"]
        if ai:
            from ..research import sandbox
            lk = sandbox.run("leakage", {"spec": spec, "period": res_u.get("period")}, prices_ai, spool=self.spool)
            design["isolation"].append({**lk["isolation"], "task": "leakage"})
            variants = self._robustness(spec, prices_ai, cost_model_x, snapshot.snapshot_id, design)
            evaluation = r.evaluator.evaluate(spec, snapshot, res_u, res_x, attempts + len(design["candidates"]) - 1, leakage=lk["result"])
            from .strategy_design import design_checks
            evaluation["checks"] = evaluation["checks"] + design_checks(design["candidates"][design["chosen"]], res_x, variants,
                                                                        len(design["candidates"]))
            statuses = {c["status"] for c in evaluation["checks"]}
            evaluation["verdict"] = "fail" if "fail" in statuses else ("warn" if "warn" in statuses else "pass")
            design["variants"] = variants
        else:
            evaluation = r.evaluator.evaluate(spec, snapshot, res_u, res_x, attempts)
        evaluation["checks"] = evaluation["checks"] + [exec_check]
        if exec_check["status"] == "warn" and evaluation["verdict"] == "pass":
            evaluation["verdict"] = "warn"
        self._step(run_id, "evaluate", detail=tr("step.detail.verdict", v=VERDICT_KO[evaluation["verdict"]]))

        if ai:   # the AI's design is never evaluated in this process: the isolated run's checked target is used
            weights = dict(res_x["latest_target"]["weights"])
        else:
            prices = r.marketdata.load_prices(snapshot.snapshot_id)
            weights = r.strategies.target_weights(spec, prices, len(prices.index) - 1)
        report = self._assemble(brief, spec, snapshot, res_u, res_x, evaluation, weights, token_costs, no_route)
        report["execution"]["price_basis"] = basis
        if design:
            report["design"] = design
            chosen = design["candidates"][design["chosen"]]
            report["title_ko"] = f"{report['title_ko']} · {chosen['name']}"
        texts = self._explain(run_id, brief, report)
        report.update(texts)
        self._step(run_id, "explain", detail=tr("step.detail.ai") + (tr("step.detail.ai_cached") if texts.get("ai_cache_hit") else "")
                   if texts.get("ai") else tr("step.detail.no_ai"))
        self.db.execute("UPDATE runs SET status = 'done', cache_hit = ?, report = ?, finished_at = ? WHERE run_id = ?",
                        (int(cache_hit), dumps(report), now_iso(), run_id))
        self._step(run_id, "done")
        with self.db.write_lock:
            self.db.execute("UPDATE runs SET status = 'done' WHERE run_id = ?", (run_id,))
        m = report["xtxc"]["metrics"]
        self.ledger.append("research.done", tr("ledger.research.done", title=report["title_ko"], y=i18n.years(report["period"]["years"]),
                                               r=pct(m["total_return"]), v=VERDICT_KO[evaluation["verdict"]]),
                           wallet=brief.get("wallet"), ref=run_id,
                           payload={"spec_hash": spec_hash, "snapshot_id": snapshot.snapshot_id, "verdict": evaluation["verdict"], "cache_hit": cache_hit})

    # ------------------------------------------------------- AI-designed strategies
    def _design(self, run_id: str, brief: dict, spec: dict, snapshot, cost_model_x: dict, names: dict) -> tuple[dict, dict]:
        """The model proposes candidates; each is backtested in the isolated runner on the training years only."""
        from ..research import sandbox
        from ..research.backtest import HOLDOUT_DAYS, _resolve_period
        from .strategy_design import choose, describe, design_messages, validate_candidates
        umap = {i.ticker: i for i in self.r.universe.load_universe()}
        sectors = {t: SECTOR_KO.get(getattr(umap.get(t), "sector", ""), "") for t in spec["universe"]}
        try:
            res = self.kiln.complete_json("strategy_design", design_messages(brief, names, sectors, spec["universe"]), validate_candidates,
                                          thinking=False, max_tokens=1600, wallet=brief.get("wallet"), ref=run_id)
        except (ModelUnavailable, ModelOutputInvalid) as exc:
            raise RuntimeError(tr("design.ai_failed")) from exc
        # This runner has no official-statistics columns, so a guard could not act here: such candidates are left out.
        cands = [dict(c) for c in res.value["candidates"] if not c["design"].get("macro_off")]
        if not cands:
            raise RuntimeError(tr("design.ai_failed"))
        self._step(run_id, "design", detail=tr("step.detail.design", n=len(cands)))
        prices = self.r.marketdata.load_prices(snapshot.snapshot_id)
        i0, i1 = _resolve_period(prices.index, {"years": 5})
        h0 = i0 + (i1 - i0 + 1) - HOLDOUT_DAYS                  # first day of the untouched last year
        train = {"start": str(prices.index[i0].date()), "end": str(prices.index[h0 - 1].date())}
        runs = [{"spec": {**spec, "template": "custom", "params": {"design": c["design"]}, "period": train}, "cost_model": cost_model_x}
                for c in cands]
        out = sandbox.run("backtests", {"runs": runs, "snapshot_id": snapshot.snapshot_id}, prices, spool=self.spool)
        for c, rr in zip(cands, out["result"]["runs"]):
            c["training"] = {k: rr["metrics"].get(k) for k in ("sharpe", "total_return", "cagr", "max_drawdown", "volatility")}
            c["description"] = describe(c["design"])
        k = choose(cands)
        chosen = cands[k]
        design = {"candidates": cands, "chosen": k, "rejected": res.value.get("rejected", []),
                  "training_period": train, "holdout_start": str(prices.index[h0].date()),
                  "selection_rule": tr("design.rule"), "ai_call_id": res.call_id, "ai_cache_hit": res.cache_hit,
                  "isolation": [{**out["isolation"], "task": "training"}]}
        self._step(run_id, "isolated", detail=tr("step.detail.isolated", name=chosen["name"], n=len(cands),
                                                  mode=tr(f"dz.mode.{out['isolation']['mode']}"), s=out["isolation"]["seconds"]))
        self.ledger.append("strategy.designed", tr("ledger.strategy.designed", name=chosen["name"], n=len(cands)), wallet=brief.get("wallet"),
                           ref=run_id, payload={"designs": [c["design_hash"] for c in cands], "chosen": k, "ai_call_id": res.call_id,
                                                "implementation": out["isolation"]["implementation"], "isolation": out["isolation"]["mode"],
                                                "training": train})
        return {**spec, "template": "custom", "params": {"design": chosen["design"]}}, design

    def _isolated_backtest(self, spec: dict, prices, cost_model: dict, snapshot_id: str, design: dict) -> dict:
        from ..research import sandbox
        out = sandbox.run("backtests", {"runs": [{"spec": spec, "cost_model": cost_model, "full": True}], "snapshot_id": snapshot_id},
                          prices, spool=self.spool)
        res = out["result"]["runs"][0]
        sandbox.check_backtest(spec, res, set(spec["universe"]))       # the parent re-checks caps, floor and stocks
        design["isolation"].append({**out["isolation"], "task": "backtest"})
        return res

    def _robustness(self, spec: dict, prices, cost_model: dict, snapshot_id: str, design: dict) -> list[dict]:
        """The chosen design with every lookback a quarter shorter and a quarter longer (full period, XTXC costs)."""
        from ..research import sandbox
        from ..research.strategy_lang import scaled
        runs = [{"spec": {**spec, "params": {**spec["params"], "design": scaled(spec["params"]["design"], f)}}, "cost_model": cost_model}
                for f in (0.75, 1.25)]
        out = sandbox.run("backtests", {"runs": runs, "snapshot_id": snapshot_id}, prices, spool=self.spool)
        design["isolation"].append({**out["isolation"], "task": "robustness"})
        return [{"factor": f, **{k: rr["metrics"].get(k) for k in ("sharpe", "total_return", "max_drawdown")}}
                for f, rr in zip((0.75, 1.25), out["result"]["runs"])]

    MAX_IMPACT_BPS = 200.0

    def _measure_execution(self, tickers: list[str], order_atoms: int, snapshot_id: str) -> tuple[dict, list[str]]:
        """Per ticker: premium vs last close (tiny quote), price impact at order size, round-trip friction.

        friction_bps (one-way cost used by the XTXC backtest) = half of buy-then-sell round trip when a sell
        route exists, otherwise impact + 30 bps fee allowance. The premium is a level difference to the stock,
        not a per-trade cost, so it is reported and gated but not charged on every rebalance.
        """
        out: dict[str, dict] = {}
        quotes: dict[str, list] = {}
        raw: dict[str, dict] = {}
        for t in tickers:
            try:
                small = self.chain.quote(t, "BUY", max(1_000_000, order_atoms // 100))
                full = self.chain.quote(t, "BUY", order_atoms)
            except Exception as exc:
                small = full = {"available": False, "reason": str(exc)[:80]}
            raw[t] = {"small": small, "full": full}
            qs = []
            for q in (small, full):
                if q.get("available"):
                    qs.append({"input_atoms": q["inputAtoms"], "output_atoms": q["expectedOutAtoms"], "decimals": q["outputDecimals"],
                               "input_decimals": q["inputDecimals"], "ui_multiplier": q.get("stockUiMultiplier", 1),
                               "quoted_at": q["quotedAt"], "source": f"{q['network']}:{q['venue']}"})
            if qs:
                quotes[t] = qs
        # Compare token prices with the stock close that was current when the pool state was observed.
        state_times = sorted({q.get("stateTime") for v in raw.values() for q in v.values() if q.get("stateTime")})
        state_time = state_times[-1] if state_times else None
        closes, close_date = closes_at(self.r.marketdata.load_prices(snapshot_id, field="close"), tickers, state_time)
        basis = {"chain_state_time": state_time, "close_date": close_date}
        model = self.r.execution_costs.token_cost_model(tickers, order_atoms, quotes,
                                                        underlying_close={t: float(v) for t, v in closes.items()})
        for t in tickers:
            small, full = raw[t]["small"], raw[t]["full"]
            info = {"venue": full.get("venue") or small.get("venue"), "premium_bps": model[t].get("premium_bps"),
                    "flags": model[t].get("flags", []), "shortfall_vs_stock_bps": model[t].get("cost_bps"),
                    "impact_bps": None, "round_trip_bps": None, "friction_bps": 100.0, "friction_source": "default-conservative",
                    "excluded_reason_ko": None}
            if not small.get("available"):
                info["excluded_reason_ko"] = tr("excl.no_route")
            else:
                ps = Decimal(small["inputAtoms"]) / Decimal(small["expectedOutAtoms"])
                impact = None
                if full.get("available"):
                    pf = Decimal(full["inputAtoms"]) / Decimal(full["expectedOutAtoms"])
                    impact = float((pf / ps - 1) * 10_000)
                    info["impact_bps"] = round(impact, 1)
                trade_atoms = int(full["inputAtoms"]) if full.get("available") else order_atoms
                if impact is None or impact > self.MAX_IMPACT_BPS:
                    # Too thin (or no route) for one go: buyable only if time slices each move the price little.
                    sl = self._slice_probe(t, order_atoms, ps)
                    if sl:
                        info["slicing"] = sl
                        trade_atoms = sl["slice_atoms"]
                try:
                    rt_q = self.chain.round_trip(t, trade_atoms)
                except Exception:
                    rt_q = {"available": False}
                base_impact = info["slicing"]["slice_impact_bps"] if info.get("slicing") else (impact or 0.0)
                if rt_q.get("available"):
                    rt = float(rt_q["roundTripBps"])
                    info.update(round_trip_bps=round(rt, 1), friction_bps=round(max(rt, 0.0) / 2, 1), friction_source="round-trip")
                else:
                    info.update(friction_bps=round(max(base_impact, 0.0) + 30.0, 1), friction_source="impact+30bps")
                if info.get("slicing"):
                    info["friction_source"] += tr("friction.split", n=info["slicing"]["count"])
                prem = info["premium_bps"]
                if "price-ratio-suspect" in info["flags"]:
                    info["excluded_reason_ko"] = tr("excl.unit")
                elif impact is None and not info.get("slicing"):
                    info["excluded_reason_ko"] = tr("excl.no_route_split")
                elif impact is not None and impact > self.MAX_IMPACT_BPS and not info.get("slicing"):
                    info["excluded_reason_ko"] = tr("excl.thin", p=f"{impact/100:.1f}")
                elif prem is not None and abs(prem) > self.s.premium_block_bps:
                    info["excluded_reason_ko"] = tr("excl.premium", p=f"{prem/100:+.1f}")
                elif prem is None:
                    info["excluded_reason_ko"] = tr("excl.no_close")
            out[t] = info
        return out, [t for t in tickers if out[t]["excluded_reason_ko"]], basis

    def _slice_probe(self, ticker: str, order_atoms: int, ref_price: Decimal) -> dict | None:
        """Smallest time-slice count whose single slice moves the price <= SLICE_TARGET_BPS (same rule as the planner)."""
        for n in SLICE_COUNTS:
            each = order_atoms // n
            try:
                q = self.chain.quote(ticker, "BUY", each)
            except Exception:
                continue
            if not q.get("available"):
                continue
            impact = float((Decimal(q["inputAtoms"]) / Decimal(q["expectedOutAtoms"]) / ref_price - 1) * 10_000)
            if impact <= SLICE_TARGET_BPS:
                return {"count": n, "slice_atoms": each, "slice_impact_bps": round(impact, 1)}
        return None

    def _assemble(self, brief, spec, snapshot, res_u, res_x, evaluation, weights, token_costs, no_route) -> dict:
        umap = {i.ticker: i for i in self.r.universe.load_universe()}
        eq = res_x["equity"]
        bench = res_x["benchmark"]
        dates = [d for d, _ in eq]
        s0, b0 = eq[0][1], bench[0][1]
        strat = [round(v / s0 * 100, 2) for _, v in eq]
        bvals = {d: v for d, v in bench}
        bench_series = [round(bvals.get(d, float("nan")) / b0 * 100, 2) for d in dates]
        ds, sv = downsample(dates, strat)
        _, bv = downsample(dates, bench_series)
        mx = res_x["metrics"]
        budget = brief["budget_krw"]
        years = round((len(dates) - 1) / 252) or 1
        hold_x = res_x.get("holdout_metrics") or res_x["metrics"].get("holdout", {})
        hold_b = res_x.get("benchmark_holdout_metrics") or {}
        cash = 1 - sum(weights.values())
        return {
            "title_ko": f"{brief['title_ko']} v{brief['version']}", "spec": spec,
            "period": {"start": dates[0], "end": dates[-1], "holdout_start": res_x.get("holdout_start"), "years": years},
            "underlying": {"metrics": res_u["metrics"]}, "xtxc": {"metrics": mx},
            "benchmark": {"ticker": "QQQ", "metrics": res_x.get("benchmark_metrics", {})},
            "curve": {"dates": ds, "strategy": sv, "benchmark": bv},
            "drawdown_krw": {"from": budget, "to": int(budget * (1 + mx["max_drawdown"]))},
            "holdout": {"strategy": hold_x.get("total_return"), "benchmark": hold_b.get("total_return")},
            "checks": evaluation["checks"], "verdict": evaluation["verdict"],
            "target": {"weights": {t: round(w, 4) for t, w in weights.items() if w > 0}, "cash": round(cash, 4)},
            "names_ko": {t: i18n.stock_name(umap.get(t), t) for t in brief.get("names_ko", {})},
            "execution": {"token_costs": token_costs, "no_route": no_route,
                          "gap_total_return": (res_u["metrics"]["total_return"] - mx["total_return"])},
            "data": {"snapshot_id": snapshot.snapshot_id, "as_of": snapshot.as_of, "source": snapshot.source, "rights": snapshot.rights},
            "disclaimer_ko": tr("research.disclaimer"), "lang": i18n.lang(),
        }

    # ------------------------------------------------------- explanations
    def _explain(self, run_id: str, brief: dict, rep: dict) -> dict:
        facts, values = explain_inputs(brief, rep)
        allowed = set(values)
        out = {"ai": False, "ai_cache_hit": False, "ai_calls": [], "ai_errors": []}
        wallet = brief.get("wallet")
        # Each flow stands alone: a failure of one never skips the other; failures fall back to fixed text.
        try:
            summary = self.kiln.complete_json("report_explain", explain_messages(facts, sorted(allowed)),
                                              lambda a: validate_sentences(a, "sentences", allowed, 2, 3),
                                              thinking=False, max_tokens=350, wallet=wallet, ref=run_id)
            out["summary_ko"] = i18n.tidy(i18n.sentences(fill(summary.value, values)))
            out["ai_calls"].append(summary.call_id)
            out["ai_cache_hit"] = summary.cache_hit
            out["ai"] = True
        except (ModelUnavailable, ModelOutputInvalid) as exc:
            out["summary_ko"] = tr("fallback.summary", years=values["years"], r=values["total_return_xtxc"], b=values["benchmark_return"])
            out["ai_errors"].append({"flow": "report_explain", "error": str(exc)[:200]})
        try:
            counter = self.kiln.complete_json("counter_opinion", counter_messages(facts, sorted(allowed)),
                                              lambda a: validate_sentences(a, "risks", allowed, 2, 3),
                                              thinking=False, max_tokens=350, wallet=wallet, ref=run_id)
            out["counter_opinions_ko"] = [i18n.tidy(x) for x in fill(counter.value, values)]
            out["ai_calls"].append(counter.call_id)
            out["ai_cache_hit"] = out["ai_cache_hit"] and counter.cache_hit
            out["ai"] = True
        except (ModelUnavailable, ModelOutputInvalid) as exc:
            out["counter_opinions_ko"] = [tr("fallback.counter1"), tr("fallback.counter2")]
            out["ai_errors"].append({"flow": "counter_opinion", "error": str(exc)[:200]})
        return out
