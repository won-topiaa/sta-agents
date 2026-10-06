"""변동 예측: how far a stock may move over the horizon the user picked, and what trading its token costs.

The agent asks for the horizon in the conversation (chat.py); this module turns the research models
(research/volforecast.py) into the card the user sees. Every number is computed here -- the model writes none.
Each forecast is stored (table `forecasts`) and logged in the hash-chained ledger with its range and due time, so it
can be checked against what really happened.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import threading
from decimal import Decimal
from pathlib import Path

from . import i18n
from .db import Database, dumps, new_id, now_iso
from .i18n import tr
from .ledger import Ledger
from .research_runner import pct

MAX_TICKERS = 5
MIN_CALIBRATION = 20            # real fills needed before they widen the cost range (stockmesh_journal)


def pd_ts(x):
    import pandas as pd
    return pd.Timestamp(x)
DEFAULT_SIZE_USD = 1000
TAPE_FILE = Path("exectape") / "tape.sqlite"


class ForecastError(ValueError):
    pass


def horizon_label(code: str) -> str:
    from ..research.volforecast import parse_horizon
    h = parse_horizon(code)
    if h.code == "1d":
        return tr("hz.1d")
    return tr(f"hz.{h.unit}", n=h.n)


def horizon_choices() -> list[dict]:
    from ..research.volforecast import CHOICES
    return [{"code": c, "label": horizon_label(c)} for c in CHOICES]


def _bps(x: float | None) -> str:
    return "—" if x is None else pct(x / 1e4, signed=False)


def _price(x: float) -> str:
    return f"${x:,.2f}" if x < 1000 else f"${x:,.0f}"


def _clock(iso: str) -> str:
    """A time in the reader's zone: Seoul for Korean, Beijing for Chinese, UTC for English."""
    from zoneinfo import ZoneInfo
    t = dt.datetime.fromisoformat(iso)
    zone, tag = {"ko": ("Asia/Seoul", "KST"), "zh": ("Asia/Shanghai", "北京时间")}.get(i18n.lang(), ("UTC", "UTC"))
    return t.astimezone(ZoneInfo(zone)).strftime("%m-%d %H:%M ") + tag


def _ago(minutes: int) -> str:
    return tr("unit.minutes", n=minutes) if minutes < 120 else tr("unit.hours", n=round(minutes / 60))


class Forecaster:
    def __init__(self, settings, db: Database, ledger: Ledger, universe_map, *, claims=None, tape_path: Path | None = None,
                 root: Path | None = None):
        from ..research.volforecast import Models
        self.settings = settings
        self.db = db
        self.ledger = ledger
        self.claims = claims
        self.universe_map = universe_map
        self.tape_path = tape_path or Path(settings.data_dir) / TAPE_FILE
        self.models = Models(self.tape_path, root)
        self._lock = threading.Lock()

    # ------------------------------------------------------------ helpers
    def _name(self, t: str) -> str:
        return i18n.stock_name(self.universe_map().get(t), t)

    def size_for(self, brief: dict | None) -> float:
        """Per-stock amount of the user's conditions (budget less cash, split evenly), else a thousand dollars."""
        if not brief or not brief.get("budget_krw"):
            return float(DEFAULT_SIZE_USD)
        fx = Decimal(brief.get("fx_krw_per_usdc") or i18n.DEFAULT_FX)
        n = max(1, len([t for t in brief["universe"]["tickers"] if t not in brief["universe"].get("exclude", [])]))
        per = Decimal(brief["budget_krw"]) * (1 - Decimal(brief.get("min_cash") or "0")) / fx / n
        return float(max(Decimal(10), min(per, Decimal(1_000_000))).quantize(Decimal(1)))

    def check_tickers(self, tickers) -> list[str]:
        if not isinstance(tickers, list) or not tickers:
            raise ForecastError(tr("fc.err.tickers"))
        uni = self.universe_map()
        out = []
        for t in tickers:
            t = str(t).strip().upper()
            if t not in uni:
                raise ForecastError(tr("fc.err.unknown", t=t[:12]))
            if t not in out:
                out.append(t)
        if len(out) > MAX_TICKERS:
            raise ForecastError(tr("fc.err.too_many", n=MAX_TICKERS))
        return out

    def warm(self) -> None:
        """Fit the chip horizons in the background so the first user does not wait."""
        from ..research.volforecast import CHOICES, parse_horizon

        def run():
            for c in CHOICES:
                h = parse_horizon(c)
                try:
                    if h.hours:
                        self.models.token(h.hours)
                    else:
                        self.models.price(h.days)
                        if h.days <= 21:
                            self.models.offhours(h.days)
                except Exception:  # a missing release or empty tape only means "not ready yet"
                    pass
        threading.Thread(target=run, name="forecast-warm", daemon=True).start()

    # ------------------------------------------------------------ forecast
    def forecast(self, wallet: str | None, tickers: list[str], horizon: str, *, size_usd: float | None = None,
                 fx: str | None = None, now: dt.datetime | None = None) -> dict:
        from ..research import volforecast as vf
        tickers = self.check_tickers(tickers)
        try:
            h = vf.parse_horizon(horizon)
        except ValueError as exc:
            raise ForecastError(tr("fc.err.horizon")) from exc
        size = float(size_usd or DEFAULT_SIZE_USD)
        if not 10 <= size <= 1_000_000:
            raise ForecastError(tr("fc.err.size"))
        now = now or dt.datetime.now(dt.timezone.utc)
        try:
            daily = self.models.daily()
        except Exception as exc:
            raise ForecastError(tr("fc.err.no_prices")) from exc
        sessions = self.models.sessions()
        counts = self.models.tape.counts()
        from ..research.stockmesh_journal import summary
        sm_rows = self.models.tape.stockmesh_orders()
        self._stockmesh_cache = summary(sm_rows) if sm_rows else None
        items = [self._item(t, h, size, fx, daily, sessions, now) for t in tickers]
        fid = new_id("fc")
        body = {
            "forecast_id": fid, "created_at": now_iso(), "lang": i18n.lang(), "wallet": wallet,
            "horizon": {"code": h.code, "label": horizon_label(h.code), "hours": h.hours, "days": h.days,
                        "due": self._due(h, now, sessions)},
            "size_usd": size, "size_label": i18n.money(int(Decimal(str(size)) * Decimal(fx or i18n.DEFAULT_FX)), fx),
            "items": items,
            "data": {"prices": {"source": "xtxc-quant-store/verified-v1", "as_of": daily.as_of, "release_id": daily.release_id},
                     "tape": counts, "own_fills": self._own_fills(tickers)},
            "text": {"data": tr("fc.data", as_of=self._release_as_of(daily), bars=f"{counts.get('bars', 0):,}", quotes=f"{counts.get('quotes', 0):,}",
                                first=(counts.get("bars_first") or "—")[:10], last=(counts.get("bars_last") or "—")[:10]),
                     "disclaimer": tr("fc.disclaimer")},
        }
        ext = daily.provenance.get("_extension")
        if ext:
            body["data"]["prices"]["extended"] = ext
            body["text"]["extended"] = tr("fc.extended", d0=ext["from"], d1=ext["to"], n=ext["sessions"])
        own = body["data"]["own_fills"]
        if own["n"]:
            body["text"]["own_fills"] = tr("fc.own_fills", n=own["n"], net=own["network_label"])
        sm = own.get("stockmesh")
        if sm and sm["orders"]:
            txt = tr("fc.stockmesh", n=sm["orders"], sent=sm["sent"], f=sm["filled"], u=sm["expired_unsent"], x=sm["expired_no_fill"])
            if sm.get("median_slippage_bps") is not None:
                txt += tr("fc.stockmesh.slip", m=sm["measured"], med=f"{sm['median_slippage_bps']:+.1f}", worst=f"{sm['worst_slippage_bps']:+.1f}")
            txt += tr("fc.stockmesh.used") if sm["used_in_forecast"] else tr("fc.stockmesh.not_yet", m=sm["measured"], k=MIN_CALIBRATION)
            body["text"]["stockmesh"] = txt
        for it in items:                                            # the stock's own real orders, if any
            s1 = own["stockmesh_by_ticker"].get(it["ticker"])
            if s1 and s1.get("median_slippage_bps") is not None:
                it.setdefault("text", {})["stockmesh"] = tr("fc.stockmesh.ticker", t=it["ticker"], m=s1["measured"],
                                                            med=f"{s1['median_slippage_bps']:+.1f}")
        self.db.execute("INSERT INTO forecasts(forecast_id, wallet, body, created_at) VALUES(?,?,?,?)",
                        (fid, wallet, dumps(body), body["created_at"]))
        if self.claims is not None:           # AI 성적표: scored when the horizon is over (score_due)
            for it in items:
                r = it.get("range")
                if not r:
                    continue
                self.claims.add(wallet=wallet, plan_id=fid, subject=it["ticker"], metric="forecast_range",
                                predicted=(r["low"] + r["high"]) / 2, tolerance=(r["high"] - r["low"]) / 2, unit="USD",
                                statement_ko=tr("fc.claim", name=i18n.with_ticker(it["name"], it["ticker"]), h=body["horizon"]["label"],
                                                lo=_price(r["low"]), hi=_price(r["high"])),
                                ref=json.dumps({"due": body["horizon"]["due"], "hours": h.hours, "days": h.days,
                                                "basis": "token" if h.hours else "close"}))
        self.ledger.append("forecast.made", tr("ledger.forecast", names=i18n.join(i18n.with_ticker(self._name(t), t) for t in tickers),
                                               h=body["horizon"]["label"]), wallet=wallet, ref=fid,
                           payload={"horizon": h.code, "due": body["horizon"]["due"],
                                    "ranges": {i["ticker"]: i.get("range") for i in items}, "models": {i["ticker"]: i["model"]["kind"] for i in items}})
        return body

    # ------------------------------------------------------------ scoring (24 hours)
    def score_due(self, now: dt.datetime | None = None) -> dict:
        """Resolve forecast claims whose horizon is over: inside the range = hit. Hours are scored on the token price
        (the tape), days on the session close. A claim with no price a week after its due time is voided."""
        from ..research import volforecast as vf
        if self.claims is None:
            return {"scored": 0}
        now = now or dt.datetime.now(dt.timezone.utc)
        rows = self.db.all("SELECT claim_id, subject, ref FROM claims WHERE metric = 'forecast_range' AND verdict IS NULL")
        done = {"scored": 0, "void": 0, "waiting": 0}
        daily = None
        mints = None
        for r in rows:
            try:
                meta = json.loads(r["ref"] or "{}")
            except ValueError:
                continue
            actual = None
            if meta.get("hours"):
                due = dt.datetime.fromisoformat(meta["due"])
                if due.tzinfo is None:
                    due = due.replace(tzinfo=dt.timezone.utc)
                if now < due + dt.timedelta(minutes=70):
                    done["waiting"] += 1
                    continue
                mints = mints if mints is not None else self.models.tape.primary_mints()
                bars = self.models.tape.hourly(mints[r["subject"]]) if r["subject"] in mints else None
                if bars is not None and not bars.empty:
                    after = bars[bars.index >= vf.pd.Timestamp(due)]
                    if not after.empty and after.index[0] <= vf.pd.Timestamp(due) + vf.pd.Timedelta(hours=2):
                        actual = float(after["c"].iloc[0])
                late = now > due + dt.timedelta(days=7)
            else:
                due_day = dt.date.fromisoformat(meta["due"][:10])
                if now.date() <= due_day:
                    done["waiting"] += 1
                    continue
                daily = daily or self.models.daily()
                col = daily.raw.get(r["subject"])
                if col is not None:
                    x = col.dropna()
                    x = x[x.index.date == due_day]
                    if len(x):
                        actual = float(x.iloc[-1])
                late = now.date() > due_day + dt.timedelta(days=7)
            if actual is not None:
                self.claims.resolve(r["claim_id"], actual)
                done["scored"] += 1
            elif late:
                self.claims.void(r["claim_id"], "no price at due time")
                done["void"] += 1
            else:
                done["waiting"] += 1
        return done

    def start_scorer(self, interval: float = 600.0) -> threading.Thread:
        stop = threading.Event()

        def loop():
            while not stop.wait(interval):
                try:
                    self.score_due()
                except Exception:  # scoring is retried on the next round
                    pass
        t = threading.Thread(target=loop, name="forecast-scorer", daemon=True)
        t.start()
        self._scorer_stop = stop
        return t

    def get(self, forecast_id: str) -> dict:
        row = self.db.one("SELECT body FROM forecasts WHERE forecast_id = ?", (forecast_id,))
        if not row:
            raise KeyError(forecast_id)
        return json.loads(row["body"])

    @staticmethod
    def _release_as_of(daily) -> str:
        ext = daily.provenance.get("_extension")
        if not ext:
            return daily.as_of
        return str(daily.adj.index[daily.adj.index < pd_ts(ext["from"])].max().date())

    @staticmethod
    def _due(h, now: dt.datetime, sessions: set[dt.date]) -> str:
        if h.hours:
            return (now + dt.timedelta(hours=h.hours)).isoformat(timespec="minutes")
        d, left = now.astimezone(dt.timezone.utc).date(), h.days
        while left > 0:
            d += dt.timedelta(days=1)
            if d in sessions or (d.weekday() < 5 and d > max(sessions)):
                left -= 1
        return d.isoformat()

    def _own_fills(self, tickers: list[str]) -> dict:
        """Our own post-trade data: the demo's fills (claims, local chain) and XTXC's real orders (StockMesh journal, mainnet)."""
        from ..research.stockmesh_journal import summary
        rows = self.db.all("SELECT subject, predicted, actual FROM claims WHERE metric = 'cost_bps' AND actual IS NOT NULL")
        diffs = [r["actual"] - r["predicted"] for r in rows]
        net = "localnet" if self.settings.mode in ("demo", "dev") else "mainnet"
        sm = self.models.tape.stockmesh_orders()
        return {"n": len(diffs), "network": net, "network_label": tr(f"fc.net.{net}"),
                "median_diff_bps": (sorted(diffs)[len(diffs) // 2] if diffs else None), "used_in_forecast": False,
                "stockmesh": summary(sm) if sm else None,
                "stockmesh_by_ticker": {t: summary(sm, t) for t in tickers if any(r["instrument"] == t for r in sm)}}

    def _item(self, t: str, h, size: float, fx, daily, sessions, now) -> dict:
        from ..research import volforecast as vf
        item = {"ticker": t, "name": self._name(t), "notes": []}
        prem = vf.premium_profile(daily, self.models.tape, t)
        cost = vf.cost_profile(self.models.tape, t, size, sessions, now=now)
        if h.hours:
            tm = self.models.token(h.hours)
            q = cost.get("now") or {}
            L = vf.token_live(tm, t, sessions, now=now, price_now=(q.get("mid"), q.get("at")) if q.get("age_min", 999) < 90 else None)
            if not L:
                item.update(model={"kind": "none", "label": tr("fc.model.none")}, text={"headline": tr("fc.no_token_data", name=self._name(t))})
                return item
            ref, sigma, k = L["price"], L["sigma"], L["k"]
            center = 0.0
            item["price"] = {"ref": ref, "kind": "token", "at": L["at"], "label": tr("fc.ref.token", at=_clock(L["at"]))}
            if L["traded_24h"] < 6:
                item["notes"].append(tr("fc.thin", n=L["traded_24h"]))
            bt = tm["backtest"]
            item["model"] = {"kind": "token", "label": tr("fc.model.token"), "uses_exec": True}
            item["backtest"] = self._bt_simple(bt, "model", "baseline", tr("fc.method.ewma_token"))
        else:
            pm = self.models.price(h.days)
            P = pm["live"].get(t)
            if not P:
                item.update(model={"kind": "none", "label": tr("fc.model.none")}, text={"headline": tr("fc.no_price_data", name=self._name(t))})
                return item
            close = float(daily.raw[t].dropna().iloc[-1])
            sigma, k, center = P["sigma"], pm["k"], 0.0
            ref, kind = close, "close"
            ref_label = tr("fc.ref.close", d=P["as_of"])
            model = {"kind": "price", "label": tr("fc.model.price", method=tr(f"fc.method.{pm['method']}")), "uses_exec": False}
            om = self.models.offhours(h.days) if h.days <= vf.EXEC_MAX_DAYS else None
            live = vf.offhours_live(om, pm, daily, self.models.tape, [t], now=now).get(t) if om else None
            if om is not None:
                item["exec_test"] = self._bt_exec(om)
            if P.get("short_history"):
                item["notes"].append(tr("fc.short_history", n=P["days"]))
            if om and om.get("use") and live and live.get("in_window") and live.get("sigma"):
                center, sigma, k = live["center"], live["sigma"], om["k"]
                ref, kind = close * math.exp(center), "token_implied"
                ref_label = tr("fc.ref.implied", d=P["as_of"], move=pct(live["g"]))
                model = {"kind": "offhours", "label": tr("fc.model.offhours"), "uses_exec": True}
            elif live and live.get("g") is not None and not live.get("in_window"):
                # the price history is older than the last session: continue it with the token's trades since then
                ref, kind = close * math.exp(live["g"]), "token_implied"
                ref_label = tr("fc.ref.implied", d=P["as_of"], move=pct(live["g"]))
                item["notes"].append(tr("fc.stale", d=P["as_of"]))
            item["price"] = {"ref": ref, "kind": kind, "label": ref_label, "close": close, "close_day": P["as_of"]}
            item["model"] = model
            item["backtest"] = self._bt_price(pm, t, h)
            if h.days >= 21:
                item["dip"] = {"typical": math.exp(pm["dd50"] * sigma) - 1, "bad": math.exp(pm["dd10"] * sigma) - 1,
                               "bad_rate": pm["backtest"].get("dip_bad_rate")}
        lo, hi = ref * math.exp(-k * sigma), ref * math.exp(k * sigma)
        item["range"] = {"low": lo, "high": hi, "low_pct": lo / ref - 1, "high_pct": hi / ref - 1, "cover": vf.COVER, "sigma": sigma, "k": k}
        item["cost"] = self._cost(cost, h, size, fx)
        sm_all = self._stockmesh_cache if hasattr(self, "_stockmesh_cache") else None
        if sm_all and sm_all.get("used_in_forecast") and item["cost"].get("buy"):
            gap = max(0.0, -float(sm_all.get("p10_slippage_bps") or 0))       # received less than quoted, bad case
            item["cost"]["fill_gap_bps"] = gap
        item["premium"] = prem
        item["text"] = self._texts(item, h, size, fx)
        return item

    # ------------------------------------------------------------ evidence
    @staticmethod
    def _bt_simple(bt: dict, mk: str, bk: str, base_label: str) -> dict:
        if not bt.get("tests"):
            return {"tests": 0}
        m, b = bt[mk], bt[bk]
        return {"tests": bt["tests"], "coverage": m["coverage"], "width": m["width"], "base_label": base_label,
                "base_coverage": b["coverage"], "base_width": b["width"], "better": m["score"] <= b["score"],
                "first": bt.get("first"), "last": bt.get("last")}

    @staticmethod
    def _bt_exec(om: dict) -> dict:
        bt = om.get("backtest") or {}
        if not bt.get("tests"):
            return {"tests": 0, "rows": om.get("rows", 0)}
        return {"tests": bt["tests"], "use": om["use"], "exec": bt["exec"], "price": bt["price"], "first": bt["first"],
                "last": bt["last"], "beta": om.get("beta")}

    @staticmethod
    def _bt_price(pm: dict, t: str, h) -> dict:
        """The chosen method's backtest, compared with the simplest one (last year's swings), or with the day-to-year
        model when the simple one won."""
        bt = pm["backtest"]
        if not bt.get("tests") or "scores" not in bt:
            return {"tests": bt.get("tests", 0)}
        best = bt["best"]
        base = "hist" if best != "hist" else "har"
        m, b = bt["scores"][best], bt["scores"][base]
        own = bt["per_ticker"].get(t, {})
        return {"tests": bt["tests"], "method": best, "method_label": tr(f"fc.method.{best}"), "coverage": m["coverage"], "width": m["width"],
                "ticker_tests": own.get("tests"), "ticker_coverage": own.get("coverage"), "first": bt["first"][:4], "last": bt["last"][:4],
                "independent": bt["independent"], "vol_error": bt["vol_error"], "base": base, "base_label": tr(f"fc.method.{base}"),
                "base_coverage": b["coverage"], "base_width": b["width"], "better": m["score"] <= b["score"],
                "dip_bad_rate": bt.get("dip_bad_rate"), "dip_tests": bt.get("dip_tests")}

    # ------------------------------------------------------------ cost
    @staticmethod
    def _cost(c: dict, h, size: float, fx) -> dict:
        out = {"samples": c.get("samples", 0), "size_usd": size}
        if not c.get("samples"):
            return out
        now = c["now"]
        out.update(buy_now_bps=now["buy_bps"], sell_now_bps=now["sell_bps"], age_min=now["age_min"], extrapolated=now["extrapolated"],
                   spread_bps=now["spread_bps"], buy=c["buy"], sell=c["sell"], first=c["first"])
        hold = h.days >= 21
        if hold and now["buy_bps"] is not None:
            s = c["sell"]["all"]
            sell_mid = s.get("p50", now["sell_bps"])
            out["round_trip_bps"] = (now["buy_bps"] or 0) + (sell_mid or 0)
            out["round_trip_hi_bps"] = (now["buy_bps"] or 0) + (s.get("p90", sell_mid) or 0)
        return out

    # ------------------------------------------------------------ sentences (numbers from code, words from the catalog)
    def _texts(self, it: dict, h, size: float, fx) -> dict:
        name, r = i18n.with_ticker(it["name"], it["ticker"]), it["range"]
        hl = horizon_label(h.code)
        out = {"headline": tr("fc.headline", name=name, h=hl, lo=_price(r["low"]), hi=_price(r["high"]),
                              lop=pct(r["low_pct"]), hip=pct(r["high_pct"]))}
        bt = it.get("backtest") or {}
        ex = it.get("exec_test")
        if it["model"]["kind"] == "offhours" and ex and ex.get("tests"):
            # the forecast shown comes from the execution-data model: its own out-of-sample check leads
            out["backtest"] = tr("fc.bt.cover_offhours", n=f"{ex['tests']:,}", cov=pct(ex["exec"]["coverage"], signed=False))
        elif bt.get("tests"):
            out["backtest"] = tr("fc.bt.cover", n=f"{bt['tests']:,}", cov=pct(bt["coverage"], signed=False))
        if bt.get("tests"):
            if it["model"]["kind"] == "price" and bt.get("method"):
                out["baseline"] = tr("fc.bt.base", base=bt["base_label"], c0=pct(bt["base_coverage"], signed=False),
                                     w0=pct(bt["base_width"], signed=False), c1=pct(bt["coverage"], signed=False), w1=pct(bt["width"], signed=False))
                if bt["method"] in ("hist", "ewma"):
                    out["baseline"] += " " + tr("fc.bt.simple_won")
                if it.get("dip") and bt.get("dip_bad_rate") is not None:
                    out["dip_check"] = tr("fc.dip.check", r=pct(bt["dip_bad_rate"], signed=False), n=f"{bt['dip_tests']:,}")
                if h.days >= 63:
                    out["overlap"] = tr("fc.bt.overlap", h=hl, n=f"{bt['independent']:,}", y0=bt["first"], y1=bt["last"])
            elif it["model"]["kind"] == "token":
                out["baseline"] = tr("fc.bt.base", base=bt["base_label"], c0=pct(bt["base_coverage"], signed=False),
                                     w0=pct(bt["base_width"], signed=False), c1=pct(bt["coverage"], signed=False), w1=pct(bt["width"], signed=False))
        if "backtest" not in out:
            out["backtest"] = tr("fc.bt.none")
        if ex is not None:
            if ex.get("tests"):
                out["exec"] = tr("fc.exec.compare", n=f"{ex['tests']:,}", c0=pct(ex["price"]["coverage"], signed=False),
                                 w0=pct(ex["price"]["width"], signed=False), c1=pct(ex["exec"]["coverage"], signed=False),
                                 w1=pct(ex["exec"]["width"], signed=False), s0=f"{ex['price']['score']:.3f}", s1=f"{ex['exec']['score']:.3f}")
                out["exec_verdict"] = tr("fc.exec.used") if it["model"]["kind"] == "offhours" else (
                    tr("fc.exec.not_better") if not ex["use"] else tr("fc.exec.not_now"))
            else:
                out["exec"] = tr("fc.exec.building")
        if it.get("dip"):
            out["dip"] = tr("fc.dip", typ=pct(it["dip"]["typical"]), bad=pct(it["dip"]["bad"]))
        c = it.get("cost") or {}
        money = lambda bps: i18n.money(int(Decimal(str(size * bps / 1e4)) * Decimal(fx or i18n.DEFAULT_FX)), fx)
        if c.get("samples") and c.get("buy_now_bps") is not None:
            out["cost"] = tr("fc.cost.now", size=it_size(size, fx), bps=_bps(c["buy_now_bps"]), money=money(c["buy_now_bps"]),
                             age=_ago(c["age_min"])) + (tr("fc.cost.extrap") if c.get("extrapolated") else "")
            b = c["buy"]
            if b["open"].get("n") and b["closed"].get("n"):
                out["cost_range"] = tr("fc.cost.range2", d=7, lo=_bps(b["all"]["p10"]), hi=_bps(b["all"]["p90"]),
                                       o=_bps(b["open"]["p50"]), c=_bps(b["closed"]["p50"]))
            elif b["all"].get("n", 0) > 1:
                out["cost_range"] = tr("fc.cost.range", d=7, lo=_bps(b["all"]["p10"]), hi=_bps(b["all"]["p90"]), n=b["all"]["n"])
            if c.get("round_trip_bps") is not None:
                out["round_trip"] = tr("fc.cost.round", h=hl, bps=_bps(c["round_trip_bps"]), money=money(c["round_trip_bps"]),
                                       hi=_bps(c["round_trip_hi_bps"]))
        else:
            out["cost"] = tr("fc.cost.none")
        p = it.get("premium") or {}
        if p.get("scaled"):
            out["premium"] = tr("fc.prem.scaled")
        elif p.get("n"):
            out["premium"] = tr("fc.prem", now=pct(p["latest"]), lo=pct(p["p10"]), hi=pct(p["p90"]), n=p["n"])
        return out


def it_size(size: float, fx) -> str:
    return i18n.money(int(Decimal(str(size)) * Decimal(fx or i18n.DEFAULT_FX)), fx)
