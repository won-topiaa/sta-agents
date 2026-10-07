"""격리 실행기: runs a new (AI-designed) strategy's backtests away from the agent.

Every job runs in a fresh process that
  - starts in isolated mode (``python -I``) with a scrubbed environment (no secrets, one BLAS thread),
  - lowers its own limits before it loads anything: CPU seconds, address space, largest file it may write,
    open files, no core dumps,
  - installs a Python audit hook after loading numpy/pandas/the research code: no sockets or HTTP, no new
    processes or exec, no ctypes, no imports of network/process modules, writes only inside its job folder,
    reads only the Python installation, the research package, time-zone data and its job folder,
  - reads its inputs from files in the job folder (prices as a plain .npz, loaded without pickle),
  - writes one result file; the parent reads at most ``out_mb`` and re-checks the result (weights inside the caps,
    cash floor, finite equity, only the allowed stocks) before anything downstream may use it.

Two modes (the report says which one ran):
  service  the job folder goes to a spool served by ``xtxc-agent-sandbox.service``: its own unprivileged user
           (``xtxc-sandbox``), no network at all (systemd PrivateNetwork, AF_UNIX only, IPAddressDeny=any), read-only
           system, no access to the agent's database or model key, memory/task caps. The kernel enforces these.
  process  the service is not running: the same worker, limits and audit hook, as a child of the agent process
           (inherits the agent unit's hardening, but not a separate user or network namespace).

The strategy itself is data (``strategy_lang``), never code: the isolation is defence in depth around our own
engine running an AI-written design, not a place to execute model-written programs.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

import numpy as np

PACKAGE_ROOT = Path(__file__).resolve().parents[2]            # .../agent (contains xtxc_agent/)
IMPLEMENTATION = ("research/strategies.py", "research/strategy_lang.py", "research/backtest.py", "research/evaluator.py",
                  "research/sandbox.py", "research/universe.py", "research/universe_map.json", "research/token_products.json")
LIMITS = {"cpu_s": 60, "wall_s": 120, "mem_mb": 2048, "out_mb": 16, "files": 64}
TASKS = ("backtests", "leakage")
BLOCKED_MODULES = {"socket", "ssl", "http", "urllib", "urllib3", "httpx", "requests", "subprocess", "ctypes", "multiprocessing",
                   "asyncio", "smtplib", "ftplib", "telnetlib", "xmlrpc", "webbrowser", "pty", "sqlite3", "shutil"}
BLOCKED_PREFIXES = ("socket.", "subprocess.", "os.exec", "os.spawn", "os.posix_spawn", "os.fork", "os.system", "os.kill",
                    "os.killpg", "ctypes.", "urllib.", "http.", "ftplib.", "smtplib.", "webbrowser.", "os.putenv", "os.chmod",
                    "os.chown", "os.symlink", "os.link", "resource.setrlimit")
HEARTBEAT = ".heartbeat"
SERVICE_FRESH_S = 30


class SandboxError(RuntimeError):
    pass


def implementation_hash() -> str:
    """Hash of the code a job runs, plus the numeric library versions (recorded with every result)."""
    import pandas as pd
    h = hashlib.sha256()
    for rel in IMPLEMENTATION:
        h.update(rel.encode())
        h.update((PACKAGE_ROOT / "xtxc_agent" / rel).read_bytes())
    h.update(f"numpy {np.__version__} pandas {pd.__version__} python {sys.version.split()[0]}".encode())
    return h.hexdigest()


# ------------------------------------------------------------------ job files
def pack(job_dir: Path, task: str, payload: dict, prices, limits: dict) -> None:
    import pandas as pd
    from .universe import catalog_report_path
    if task not in TASKS:
        raise SandboxError(f"unknown task {task}")
    job_dir.mkdir(parents=True, exist_ok=True)
    idx = pd.DatetimeIndex(prices.index)
    np.savez(job_dir / "prices.npz", days=(idx.values.astype("datetime64[D]").astype("int64")),
             tickers=np.array([str(c) for c in prices.columns]), values=prices.to_numpy(dtype="float64"))
    # Capture the admitted universe with this job. A worker must not silently
    # discover a server-global catalog or inherit the parent's credential env.
    with catalog_report_path().open("rb") as f:
        catalog = f.read(4_000_001)
    if len(catalog) > 4_000_000:
        raise SandboxError("catalog exceeds the job input limit")
    if not isinstance(json.loads(catalog).get("products"), list):
        raise SandboxError("invalid job catalog")
    (job_dir / "catalog.json").write_bytes(catalog)
    (job_dir / "job.json").write_text(json.dumps({"task": task, "payload": payload, "limits": limits,
                                                "catalog_sha256": hashlib.sha256(catalog).hexdigest()}))
    for f in ("prices.npz", "catalog.json", "job.json"):
        os.chmod(job_dir / f, 0o440)                                   # read-only inputs


def _load_prices(job_dir: Path):
    import pandas as pd
    z = np.load(job_dir / "prices.npz", allow_pickle=False)
    idx = pd.DatetimeIndex(z["days"].astype("datetime64[D]"))
    return pd.DataFrame(z["values"], index=idx, columns=[str(t) for t in z["tickers"]])


# ------------------------------------------------------------------ inside the worker
def _set_limits(limits: dict) -> None:
    import resource
    cpu, mem = int(limits["cpu_s"]), int(limits["mem_mb"]) * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 2))
    resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
    out = int(limits["out_mb"]) * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_FSIZE, (out, out))
    resource.setrlimit(resource.RLIMIT_NOFILE, (int(limits["files"]), int(limits["files"])))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def _read_roots(job_dir: Path) -> tuple[str, ...]:
    roots = {sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix, str(PACKAGE_ROOT / "xtxc_agent"), str(job_dir),
             "/usr/share/zoneinfo", "/etc/localtime", "/dev/null", "/dev/urandom", "/proc/self"}
    roots |= {p for p in sys.path if p and os.path.isdir(p) and "site-packages" in p}
    return tuple(sorted(os.path.realpath(r) for r in roots))


def _install_audit_hook(job_dir: Path) -> None:
    job = os.path.realpath(job_dir)
    readable = _read_roots(job_dir)
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC

    def inside(path, roots) -> bool:
        p = os.path.realpath(os.fsdecode(path))
        return any(p == r or p.startswith(r.rstrip("/") + "/") for r in roots)

    def hook(event: str, args: tuple) -> None:
        if event == "import":
            if str(args[0] or "").split(".")[0] in BLOCKED_MODULES:
                raise PermissionError(f"sandbox: import {args[0]} is not allowed")
            return
        if event.startswith(BLOCKED_PREFIXES):
            raise PermissionError(f"sandbox: {event} is not allowed")
        if event == "open":
            path, mode, flags = (list(args) + [None, None])[:3]
            if isinstance(path, int) or path is None:
                return
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & write_flags)
            if writing and not inside(path, (job,)):
                raise PermissionError(f"sandbox: writing {path} is not allowed")
            if not writing and not inside(path, readable):
                raise PermissionError(f"sandbox: reading {path} is not allowed")
        elif event in ("os.remove", "os.rename", "os.rmdir", "os.mkdir", "shutil.rmtree", "os.truncate"):
            if args and isinstance(args[0], (str, bytes, os.PathLike)) and not inside(args[0], (job,)):
                raise PermissionError(f"sandbox: {event} outside the job folder is not allowed")

    sys.addaudithook(hook)


def worker_main(job_dir: str) -> None:
    job_dir = Path(job_dir)
    t0 = time.monotonic()
    job = json.loads((job_dir / "job.json").read_text())
    _set_limits(job["limits"])
    with (job_dir / "catalog.json").open("rb") as f:
        catalog = f.read(4_000_001)
    if len(catalog) > 4_000_000 or hashlib.sha256(catalog).hexdigest() != job.get("catalog_sha256"):
        raise SandboxError("job catalog hash mismatch")
    os.environ["XTXC_CATALOG_REPORT"] = str(job_dir / "catalog.json")
    # load everything the task needs, then lock down
    import pandas  # noqa: F401
    from . import backtest, evaluator, strategies, strategy_lang  # noqa: F401
    from .universe import load_universe
    import resource
    load_universe()                                                    # warm the cache read by the leveraged-ETF filter
    prices = _load_prices(job_dir)                                     # our own input files, read before the lock-down
    _install_audit_hook(job_dir)
    try:
        p = job["payload"]
        if job["task"] == "backtests":
            out = []
            for run in p["runs"]:
                res = backtest.simulate(run["spec"], prices, run.get("cost_model"), snapshot_id=p.get("snapshot_id"),
                                        held=run.get("held"))
                out.append(res if run.get("full") else {k: res[k] for k in ("metrics", "holdout_metrics", "period", "spec_hash",
                                                                            "trades", "turnover", "costs_paid")})
            result = {"runs": out}
        else:
            result = evaluator.leakage_test(p["spec"], prices, period=p.get("period"))
        ru = resource.getrusage(resource.RUSAGE_SELF)
        doc = {"ok": True, "result": result,
               "usage": {"cpu_s": round(ru.ru_utime + ru.ru_stime, 3), "max_rss_mb": round(ru.ru_maxrss / 1024, 1),
                         "wall_s": round(time.monotonic() - t0, 3)}}
    except Exception as exc:  # reported to the parent; nothing else leaves the process
        doc = {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:300]}"}
    tmp = job_dir / "result.tmp"
    tmp.write_text(json.dumps(doc, default=float))
    os.replace(tmp, job_dir / "result.json")


BOOT = ("import sys; sys.path.insert(0, {root!r}); from xtxc_agent.research import sandbox; sandbox.worker_main(sys.argv[1])")


def _env(job_dir: Path) -> dict:
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "HOME": str(job_dir), "TMPDIR": str(job_dir),
            "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONHASHSEED": "0"}


def run_worker(job_dir: Path, limits: dict) -> dict:
    """Start one worker for ``job_dir`` and wait (wall-clock limit; the whole process group is killed on timeout)."""
    cmd = [sys.executable, "-I", "-c", BOOT.format(root=str(PACKAGE_ROOT)), str(job_dir)]
    proc = subprocess.Popen(cmd, cwd=str(job_dir), env=_env(job_dir), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, start_new_session=True)
    try:
        _, err = proc.communicate(timeout=limits["wall_s"])
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        return {"ok": False, "error": f"time limit ({limits['wall_s']} s) exceeded", "exit": "killed"}
    res = job_dir / "result.json"
    if not res.exists():
        tail = (err or b"")[-400:].decode("utf-8", "replace")
        return {"ok": False, "error": f"worker ended without a result (exit {proc.returncode}): {tail}", "exit": proc.returncode}
    if res.stat().st_size > limits["out_mb"] * 1024 * 1024:
        return {"ok": False, "error": "result larger than the output limit", "exit": proc.returncode}
    doc = json.loads(res.read_text())
    doc["exit"] = proc.returncode
    return doc


# ------------------------------------------------------------------ the service (xtxc-agent-sandbox.service)
def serve(spool: Path, poll_s: float = 0.2, stop=None) -> None:
    """Pick up job folders (``<id>/ready``), run each in its own worker, mark them ``done``."""
    import threading
    spool = Path(spool)
    last_beat = 0.0
    stop = stop or threading.Event()
    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
    while not stop.is_set():
        if time.monotonic() - last_beat > 5:
            (spool / HEARTBEAT).write_text(json.dumps({"pid": os.getpid(), "at": time.time(), "impl": implementation_hash()}))
            last_beat = time.monotonic()
        for ready in sorted(spool.glob("*/ready")):
            job_dir = ready.parent
            try:
                os.rename(ready, job_dir / "claimed")                  # atomic: one worker per job
            except OSError:
                continue
            limits = {**LIMITS, **json.loads((job_dir / "job.json").read_text()).get("limits", {})}
            doc = run_worker(job_dir, limits)
            if not (job_dir / "result.json").exists() or not doc.get("ok"):
                (job_dir / "failed.json").write_text(json.dumps(doc))
            (job_dir / "done").write_text("1")
        time.sleep(poll_s)


# ------------------------------------------------------------------ the agent side
def _service_alive(spool: Path | None) -> bool:
    if not spool:
        return False
    try:
        return time.time() - (Path(spool) / HEARTBEAT).stat().st_mtime < SERVICE_FRESH_S
    except OSError:
        return False


def run(task: str, payload: dict, prices, *, spool: Path | None = None, limits: dict | None = None) -> dict:
    """Run one job isolated; returns {"result", "isolation": {mode, limits, usage, implementation, seconds}}."""
    limits = {**LIMITS, **(limits or {})}
    t0 = time.monotonic()
    impl = implementation_hash()
    if _service_alive(spool):
        mode = "service"
        job_dir = Path(spool) / uuid.uuid4().hex
        job_dir.mkdir(mode=0o770)
        os.chmod(job_dir, 0o2770)                                       # the sandbox user (group) may write its result here
        pack(job_dir, task, payload, prices, limits)
        (job_dir / "ready").write_text("1")
        deadline = time.monotonic() + limits["wall_s"] + 30
        while not (job_dir / "done").exists():
            if time.monotonic() > deadline:
                raise SandboxError("the isolated runner did not answer in time")
            time.sleep(0.1)
        failed = job_dir / "failed.json"
        doc = json.loads(failed.read_text()) if failed.exists() else json.loads((job_dir / "result.json").read_text())
        shutil.rmtree(job_dir, ignore_errors=True)
    else:
        mode = "process"
        job_dir = Path(tempfile.mkdtemp(prefix="xtxc-sandbox-"))
        try:
            pack(job_dir, task, payload, prices, limits)
            doc = run_worker(job_dir, limits)
        finally:
            shutil.rmtree(job_dir, ignore_errors=True)
    if not doc.get("ok"):
        raise SandboxError(doc.get("error") or "the isolated run failed")
    return {"result": doc["result"],
            "isolation": {"mode": mode, "limits": limits, "usage": doc.get("usage"), "implementation": impl,
                          "seconds": round(time.monotonic() - t0, 2),
                          # guard codes (the screen words them): what stood between this job and everything else
                          "guards": ["process", "limits", "audit", "readonly"]
                          + (["user", "no_network", "no_secrets"] if mode == "service" else [])}}


# ------------------------------------------------------------------ re-check what came back
def check_backtest(spec: dict, res: dict, universe: set[str]) -> None:
    """The parent never trusts a worker's numbers blindly: caps, cash floor, stocks and equity are re-checked."""
    from decimal import Decimal
    from .strategies import normalize_spec, spec_hash
    s = normalize_spec(spec)
    if res.get("spec_hash") != spec_hash(s):
        raise SandboxError("result belongs to a different strategy")
    band = float(Decimal(s["params"]["band"]))
    cap = float(Decimal(s["max_weight"]))
    floor = float(Decimal(s["min_cash"]))
    eq = [v for _, v in res.get("equity", [])]
    if not eq or not all(np.isfinite(eq)) or min(eq) <= 0:
        raise SandboxError("equity curve is not finite and positive")
    for _, w in res.get("weights", []):
        if set(w) - universe:
            raise SandboxError(f"weights outside the allowed stocks: {sorted(set(w) - universe)}")
        if any(x < -1e-12 or x > cap + 1e-9 for x in w.values()) or sum(w.values()) > 1 - floor + 1e-9:
            raise SandboxError("target weights break the per-stock cap or the cash floor")
    for _, w in res.get("held_weights", []):
        if any(x > cap + band + 1e-6 for x in w.values()) or sum(w.values()) > 1 - floor + band + 1e-6:
            raise SandboxError("held weights break the cap or the cash floor")
    lt = (res.get("latest_target") or {}).get("weights") or {}
    if set(lt) - universe or any(x > cap + 1e-9 for x in lt.values()) or sum(lt.values()) > 1 - floor + 1e-9:
        raise SandboxError("the latest target breaks the rules")


def _main(argv=None) -> None:  # pragma: no cover - operator / systemd entry point
    import argparse
    ap = argparse.ArgumentParser(prog="sandbox")
    ap.add_argument("command", choices=["serve", "hash"])
    ap.add_argument("--spool")
    a = ap.parse_args(argv)
    if a.command == "hash":
        print(implementation_hash())
    else:
        serve(Path(a.spool))


if __name__ == "__main__":  # pragma: no cover
    _main()
