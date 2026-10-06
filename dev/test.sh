#!/usr/bin/env bash
# Run the STA engine test suites inside the isolated dev workspace (no services, no signing).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY=/srv/skew/stockmesh-direct-node-20260920/source/xtxc-agent-20260929/agent/.venv/bin/python
NODE=/srv/skew/stockmesh-direct-node-20260920/toolchains/node-v22.23.2-linux-x64/bin/node
export STA_PYTHON="$PY"
export XTXC_CATALOG_REPORT=/srv/skew/stockmesh-direct-node-20260920/evidence/secondary-execution-20260928/catalog/report.json
# Engine JS dependencies are read from the published submission snapshot (read-only).
[ -e "$ROOT/engine/node_modules" ] || ln -s /srv/xtxc-operations/sta-submission-final-20260930/repo/node_modules "$ROOT/engine/node_modules"
cd "$ROOT/engine"
case "${1:-all}" in
  py) shift; "$PY" -m pytest -q "$@" ;;
  js) shift; "$NODE" --test "${@:-tests/*.test.mjs}" ;;
  all) "$PY" -m pytest -q; py=$?; "$NODE" --test tests/*.test.mjs; js=$?; exit $(( py || js )) ;;
esac
