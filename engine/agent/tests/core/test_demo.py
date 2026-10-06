"""Public demo mode: per-visitor wallet, wallet guard, rate limits (no sidecar, no model)."""
import pytest
from fastapi.testclient import TestClient

from xtxc_agent.chain import client as chain_client
from xtxc_agent.core import app as app_module

DEMO = ["DemoWalletA", "DemoWalletB"]


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("XTXC_MODE", "demo")
    monkeypatch.setenv("XTXC_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("XTXC_COOKIE_SECURE", "0")
    monkeypatch.setenv("XTXC_KILN_OFFLINE", "1")
    signed_for = []
    monkeypatch.setattr(chain_client.LocalChain, "status", lambda self: {
        "genesis": "g", "wallets": [{"wallet": "DevWallet", "role": "dev", "nonces": []}] +
                                   [{"wallet": w, "role": "demo", "nonces": [f"n-{w}"]} for w in DEMO]})
    monkeypatch.setattr(chain_client.LocalChain, "market_status",
                        lambda self, tickers=None: {"enabled": True, "delaySeconds": 20, "unsupported": ["SPY"], "tickers": [], "recent": []})
    monkeypatch.setattr(chain_client.LocalChain, "market_restore",
                        lambda self, tickers=None: signed_for.append(("restore", tuple(tickers or ()))) or {"actions": []})
    monkeypatch.setattr(chain_client.LocalChain, "dev_sign",
                        lambda self, txs, wallet=None: signed_for.append(wallet) or [t + "-signed" for t in txs])
    app = app_module.create_app(start_watcher=False)
    ko = {"X-Lang": "ko"}                       # these tests assert Korean messages
    return TestClient(app, headers=ko), TestClient(app, headers=ko), signed_for


def test_visitors_get_separate_demo_wallets_and_cannot_use_each_other(api):
    alice, bob, signed_for = api
    assert alice.get("/api/health").json()["mode"] == "demo"
    a = alice.get("/api/dev/wallet").json()["wallet"]
    b = bob.get("/api/dev/wallet").json()["wallet"]
    assert {a, b} == set(DEMO) and a != b
    assert alice.get("/api/dev/wallet").json()["wallet"] == a            # same visitor keeps the same wallet
    r = alice.get(f"/api/records?wallet={b}")
    assert r.status_code == 403 and "시연 세션의 지갑이 아니에요" in r.json()["detail_ko"]
    assert alice.post("/api/stop", json={"wallet": b}).status_code == 403
    assert alice.post("/api/dev/sign", json={"transactions": ["tx"]}).json()["signed"] == ["tx-signed"]
    assert signed_for == [a]                                              # the server signs only for the visitor's wallet
    stranger = TestClient(alice.app, headers={"X-Lang": "ko"})
    r = stranger.post("/api/dev/sign", json={"transactions": ["tx"]})
    assert r.status_code == 403 and "먼저 연결" in r.json()["detail_ko"]
    assert alice.get(f"/api/records?wallet={a}").status_code == 200


def test_model_calls_are_rate_limited_per_visitor_ip(api):
    alice, _, _ = api
    w = alice.get("/api/dev/wallet").json()["wallet"]
    n = alice.get("/api/health").json()["limits"]["ai_requests_per_10min"]
    codes = [alice.post("/api/ask", json={"wallet": w, "question": "?"}).status_code for _ in range(n + 1)]
    assert codes[:n] == [400] * n and codes[n] == 429                     # n per 10 minutes, then 429 with detail_ko
    r = alice.post("/api/briefs", json={"wallet": w, "text": "300만 원으로 반도체"})
    assert r.status_code == 429 and "분 뒤" in r.json()["detail_ko"]


def test_demo_health_explains_the_market_simulator_and_restore_needs_a_session(api):
    alice, _, calls = api
    sim = alice.get("/api/health").json()["market_sim"]
    assert sim["enabled"] and sim["delay_seconds"] == 20 and "시뮬레이터" in sim["note_ko"]
    assert alice.post("/api/dev/restore", json={"tickers": ["LLY"]}).status_code == 403     # no demo wallet yet
    alice.get("/api/dev/wallet")
    r = alice.post("/api/dev/restore", json={"tickers": ["LLY"]})
    assert r.status_code == 200 and ("restore", ("LLY",)) in calls


def test_session_summary_rebuilds_where_the_visitor_was(api):
    alice, bob, _ = api
    w = alice.get("/api/dev/wallet").json()["wallet"]
    assert alice.get(f"/api/session?wallet={w}").json()["stage"] == "start"
    db = alice.app.state.db
    from xtxc_agent.core.db import dumps, now_iso
    body = {"brief_id": "b_x", "version": 1, "status": "draft", "wallet": w, "universe": {"tickers": ["LLY"]}}
    db.execute("INSERT INTO briefs(brief_id, version, wallet, status, body, created_at) VALUES ('b_x',1,?,'draft',?,?)", (w, dumps(body), now_iso()))
    s = alice.get(f"/api/session?wallet={w}").json()
    assert s["stage"] == "brief" and s["brief_id"] == "b_x"
    bob.get("/api/dev/wallet")
    assert bob.get(f"/api/session?wallet={w}").status_code == 403           # someone else's session
