#!/usr/bin/env bash
# Start / stop the isolated STA dev stack on this host: web (127.0.0.1:4391) + research worker.
# Binance calls go to the BNB gateway through 127.0.0.1:4590 (an SSH reverse tunnel from a permitted region).
# Usage: dev/run-dev.sh start|stop|status
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; T=/srv/xtxc-operations/research-test/sta-agents-20261006
NODE=/srv/skew/stockmesh-direct-node-20260920/toolchains/node-v22.23.2-linux-x64/bin/node
PY=/srv/skew/stockmesh-direct-node-20260920/source/xtxc-agent-20260929/agent/.venv/bin/python
mkdir -p "$T/run" "$T/logs"
load() {   # secrets go into the process environment only; nothing is printed
  set -a; . "$T/secrets/dev.env"; eval "$(sudo cat /etc/xtxc/research-agent.env | grep -E '^KILN_(API_KEY|BASE_URL|MODEL_ID)=')"; set +a
  export NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 XTXC_RESEARCH_DB="$T/workspace.sqlite" XTXC_RESEARCH_DATA_ROOT="$T/data" \
    SKEW_STOCKLANA_PUBLIC_ORIGIN=http://localhost:4391 XTXC_BNB_GATEWAY_URL=http://127.0.0.1:4590 \
    XTXC_RESEARCH_PYTHON="$PY" XTXC_RESEARCH_PYTHONPATH="$ROOT/engine/agent:$ROOT/engine/compute" XTXC_RESEARCH_EVALUATOR="$ROOT/engine/compute/evaluate.py" \
    XTXC_CATALOG_REPORT=/srv/skew/stockmesh-direct-node-20260920/evidence/secondary-execution-20260928/catalog/report.json XTXC_RESEARCH_DESIGNS=1
}
running() { [ -f "$T/run/$1.pid" ] && kill -0 "$(cat "$T/run/$1.pid")" 2>/dev/null; }
case "${1:-status}" in
  start)
    load
    # Agentic sign-in and start need XTXC_AGENTIC_OWNER (the operator's wallet); without XTXC_DEV_AGENTIC=1 it is unset,
    # so the dev web cannot sign the shared gateway in to another account.
    [ "${XTXC_DEV_AGENTIC:-}" = 1 ] || unset XTXC_AGENTIC_OWNER
    running web || { (cd "$ROOT/web" && nohup "$NODE" node_modules/next/dist/bin/next start -p 4391 -H 127.0.0.1 >> "$T/logs/web.log" 2>&1 < /dev/null & echo $! > "$T/run/web.pid"); }
    # Production shares the gateway and its one Agentic Wallet, so the dev worker never drives it (no agenticTick or
    # exitWatch) unless XTXC_DEV_AGENTIC=1 is set for a deliberate test.
    running worker || { (cd "$ROOT/engine" && if [ "${XTXC_DEV_AGENTIC:-}" = 1 ]; then exec nohup "$NODE" scripts/research-agent-worker.mjs; else exec env -u XTXC_BNB_GATEWAY_URL nohup "$NODE" scripts/research-agent-worker.mjs; fi >> "$T/logs/worker.log" 2>&1 < /dev/null & echo $! > "$T/run/worker.pid"); }
    sleep 1; "$0" status ;;
  stop) for s in web worker; do running $s && kill "$(cat "$T/run/$s.pid")"; rm -f "$T/run/$s.pid"; done
    # Also any worker left from an earlier start (a lost pid file once left 15 of them running with the gateway URL).
    for p in $(pgrep -u "$(id -u)" -f "scripts/research-agent-worker.mjs"); do
      [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$ROOT/engine" ] && kill "$p"; done
    # `next start` forks next-server; stop whatever still listens on the dev port.
    for p in $(ss -ltnp 2>/dev/null | grep ':4391 ' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do kill "$p"; done; sleep 2; "$0" status ;;
  status) for s in web worker; do running $s && echo "$s running ($(cat "$T/run/$s.pid"))" || echo "$s stopped"; done ;;
esac
