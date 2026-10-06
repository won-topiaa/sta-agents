"""격리 실행기: same numbers as the engine, guards that hold, limits that end runaway jobs, results re-checked."""
import json
import hashlib
import os
import subprocess
import sys
import threading

import pytest

from xtxc_agent.research import sandbox
from xtxc_agent.research.backtest import simulate
from test_strategy_lang import _prices, spec


def test_job_catalog_is_hash_bound_without_inheriting_secrets(tmp_path, monkeypatch):
    sandbox.pack(tmp_path, "leakage", {"spec": spec()}, _prices(), sandbox.LIMITS)
    job = json.loads((tmp_path / "job.json").read_text())
    assert hashlib.sha256((tmp_path / "catalog.json").read_bytes()).hexdigest() == job["catalog_sha256"]
    monkeypatch.setenv("KILN_API_KEY", "fixture-secret-do-not-inherit")
    assert "KILN_API_KEY" not in sandbox._env(tmp_path)
    # Mutating even valid JSON must fail before the strategy runs.
    os.chmod(tmp_path / "catalog.json", 0o640)
    (tmp_path / "catalog.json").write_text('{"products":[]}')
    result = sandbox.run_worker(tmp_path, sandbox.LIMITS)
    assert result["ok"] is False and "catalog hash mismatch" in result["error"]


def test_isolated_backtest_matches_the_engine_and_says_how_it_ran():
    prices = _prices()
    out = sandbox.run("backtests", {"runs": [{"spec": spec(), "cost_model": {"default_bps": 20}, "full": True}]}, prices)
    res = out["result"]["runs"][0]
    ref = simulate(spec(), prices, {"default_bps": 20})
    assert res["equity"] == ref["equity"] and res["spec_hash"] == ref["spec_hash"]
    iso = out["isolation"]
    assert iso["mode"] == "process" and {"process", "limits", "audit", "readonly"} <= set(iso["guards"]) and len(iso["implementation"]) == 64
    assert iso["usage"]["cpu_s"] > 0
    sandbox.check_backtest(spec(), res, {"AAA", "BBB", "CCC", "DDD", "EEE"})


def test_the_parent_rejects_results_that_break_the_rules():
    prices = _prices()
    res = sandbox.run("backtests", {"runs": [{"spec": spec(), "full": True}]}, prices)["result"]["runs"][0]
    bad = json.loads(json.dumps(res))
    bad["weights"][3][1] = {"AAA": 0.95}
    with pytest.raises(sandbox.SandboxError):
        sandbox.check_backtest(spec(), bad, {"AAA", "BBB", "CCC", "DDD", "EEE"})
    with pytest.raises(sandbox.SandboxError):
        sandbox.check_backtest(spec(), res, {"AAA"})                                # a stock the user did not allow


def test_a_job_over_its_time_limit_is_killed():
    with pytest.raises(sandbox.SandboxError, match="time limit"):
        sandbox.run("backtests", {"runs": [{"spec": spec()}]}, _prices(), limits={"wall_s": 0.005})


def test_the_audit_hook_blocks_network_processes_and_files(tmp_path):
    job = tmp_path / "job"
    job.mkdir()
    probe = f"""
import sys, json
sys.path.insert(0, {str(sandbox.PACKAGE_ROOT)!r})
from pathlib import Path
from xtxc_agent.research import sandbox
sandbox._install_audit_hook(Path({str(job)!r}))
out = {{}}
def attempt(name, fn):
    try:
        fn(); out[name] = "allowed"
    except PermissionError:
        out[name] = "blocked"
import socket as _s  # already importable before? blocked on first import
""".replace("import socket as _s  # already importable before? blocked on first import", "")
    probe += f"""
attempt("socket", lambda: __import__("socket").socket())
attempt("subprocess", lambda: __import__("os").system("true"))
attempt("read_outside", lambda: open("/etc/hostname").read())
attempt("write_outside", lambda: open({str(tmp_path / 'x.txt')!r}, "w").write("x"))
attempt("write_inside", lambda: open({str(job / 'ok.txt')!r}, "w").write("x"))
attempt("read_code", lambda: open(sandbox.__file__).read())
print(json.dumps(out))
"""
    r = subprocess.run([sys.executable, "-I", "-c", probe], capture_output=True, text=True, timeout=60)
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out == {"socket": "blocked", "subprocess": "blocked", "read_outside": "blocked", "write_outside": "blocked",
                   "write_inside": "allowed", "read_code": "allowed"}, (out, r.stderr[-500:])


def test_service_mode_runs_jobs_from_the_spool(tmp_path):
    stop = threading.Event()
    t = threading.Thread(target=sandbox.serve, args=(tmp_path,), kwargs={"poll_s": 0.05, "stop": stop}, daemon=True)
    t.start()
    try:
        for _ in range(100):
            if (tmp_path / sandbox.HEARTBEAT).exists():
                break
            __import__("time").sleep(0.05)
        out = sandbox.run("leakage", {"spec": spec()}, _prices(), spool=tmp_path)
        assert out["isolation"]["mode"] == "service" and out["result"]["passed"]
        assert not [p for p in tmp_path.iterdir() if p.is_dir()]                   # job folders are cleaned up
    finally:
        stop.set()
        t.join(5)
