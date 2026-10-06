"""모의운용: hold a research result's target weights from its data date onward,
valued only with daily bars that arrive AFTER the start (forward, never re-fit).
No trading, no costs beyond the entry; it answers 'how is this idea doing since I looked?'.

Prices: the same daily history the forecasts use (``daily``: the verified quant release, continued every session with
the token's own price at the close from the execution tape), so a paper run moves forward every trading day even while
the quant store itself is not refreshed. Without it (tests, older setups) a fresh research snapshot is used."""

from __future__ import annotations

import json

from .i18n import tr
from .db import Database, dumps, new_id, now_iso
from .ledger import Ledger


class Paper:
    def __init__(self, db: Database, ledger: Ledger, research, daily=None):
        self.db = db
        self.ledger = ledger
        self.r = research
        self.daily = daily          # () -> volforecast.Daily (verified release + sessions continued from the tape)

    def start(self, run: dict, wallet: str) -> dict:
        if run.get("status") != "done" or not run.get("target"):
            raise ValueError(tr("err.paper.not_done"))
        paper_id = new_id("pp")
        body = {"run_id": run["run_id"], "title_ko": run.get("title_ko"), "weights": run["target"]["weights"],
                "cash": run["target"]["cash"], "start_date": run["data"]["as_of"], "benchmark": "QQQ"}
        self.db.execute("INSERT INTO paper_runs(paper_id, run_id, wallet, body, created_at) VALUES (?,?,?,?,?)",
                        (paper_id, run["run_id"], wallet, dumps(body), now_iso()))
        self.ledger.append("paper.started", tr("ledger.paper.started", title=body["title_ko"], date=body["start_date"]),
                           wallet=wallet, ref=paper_id, payload=body)
        return {"paper_id": paper_id, **body}

    def status(self, paper_id: str) -> dict:
        row = self.db.one("SELECT body, wallet, created_at FROM paper_runs WHERE paper_id = ?", (paper_id,))
        if not row:
            raise KeyError(paper_id)
        body = json.loads(row["body"])
        tickers = sorted(set(body["weights"]) | {body["benchmark"]})
        extension = None
        if self.daily is not None:
            d = self.daily()
            prices = d.adj.reindex(columns=tickers)
            as_of, extension = d.as_of, d.provenance.get("_extension")
        else:
            snap = self.r.marketdata.build_snapshot(tickers)  # refreshes cached bars when they are stale
            prices, as_of = self.r.marketdata.load_prices(snap.snapshot_id), snap.as_of
        prices = prices.dropna(how="all")
        dates = [str(d)[:10] for d in prices.index]
        if body["start_date"] not in dates:
            return {"paper_id": paper_id, **body, "as_of": as_of, "days": 0, "series": [],
                    "note_ko": tr("paper.no_start_price")}
        i0 = dates.index(body["start_date"])
        window = prices.iloc[i0:]
        base = window.iloc[0]
        series, bench = [], []
        window = window.ffill()                                   # a stock without a price that day keeps its last one
        for d, row_px in window.iterrows():
            value = body["cash"] + sum(w * float(row_px[t] / base[t]) for t, w in body["weights"].items() if base[t] == base[t])
            series.append([str(d)[:10], round(value * 100, 3)])
            bench.append([str(d)[:10], round(float(row_px[body["benchmark"]] / base[body["benchmark"]]) * 100, 3)])
        days = len(series) - 1
        out = {"paper_id": paper_id, **body, "as_of": as_of, "days": days, "series": series, "benchmark_series": bench,
               "total_return": round(series[-1][1] / 100 - 1, 6) if series else 0.0,
               "benchmark_return": round(bench[-1][1] / 100 - 1, 6) if bench else 0.0}
        out["note_ko"] = tr("paper.no_new_days") if days == 0 else tr("paper.result", n=days, date=body["start_date"])
        if extension and days:
            out["data"] = {"extended": extension}
            out["note_ko"] += tr("paper.extended", d0=extension["from"], d1=extension["to"])
        return out

    def list(self, wallet: str) -> list[dict]:
        return [{"paper_id": r["paper_id"], **json.loads(r["body"]), "created_at": r["created_at"]}
                for r in self.db.all("SELECT paper_id, body, created_at FROM paper_runs WHERE wallet = ? ORDER BY created_at DESC", (wallet,))]
