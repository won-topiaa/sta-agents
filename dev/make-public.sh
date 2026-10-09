#!/usr/bin/env bash
# Builds the public hackathon snapshot (xtxctrade/sta-agents) from this workspace.
# Only the listed paths are copied: no secrets, no private notes (dev/dx-log.md), no unrelated XTXC services.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"; OUT="${1:-$HOME/Desktop/sta-agents-public}"
mkdir -p "$OUT"
rsync -a --delete --exclude .git --exclude node_modules --exclude __pycache__ --exclude .pytest_cache \
  --exclude 'engine/evidence/' --exclude 'engine/.env*' \
  "$SRC/engine/" "$OUT/engine/"
mkdir -p "$OUT/web/lib" "$OUT/web/app/exchange/bnb" "$OUT/web/app/api/v1/stocklana/research" "$OUT/web/app/api/v1/requester-sessions" "$OUT/web/app/api/bnb/market" "$OUT/dev"
cd "$SRC/web"
for f in lib/research-*.mjs lib/research-*.d.mts lib/research-*.ts lib/agent-rules.mjs lib/agent-rules.d.mts lib/bsc-*.mjs lib/bsc-*.d.mts \
         lib/binance-web3.mjs lib/bnb-gateway.ts lib/bnb-gecko.d.mts lib/requester-auth.ts \
         app/exchange/research-*.tsx app/exchange/research-*.css app/exchange/research-session.ts app/exchange/research-demo-context.ts app/exchange/bnb/bnb-workspace.tsx \
         app/exchange/bnb/bnb-chart.tsx app/api/bnb/market/route.ts app/api/v1/requester-sessions/route.ts; do
  [ -e "$f" ] && install -D -m 644 "$f" "$OUT/web/$f" 2>/dev/null || { mkdir -p "$OUT/web/$(dirname "$f")"; cp "$f" "$OUT/web/$f"; }
done
rsync -a --delete "$SRC/web/app/api/v1/stocklana/research/" "$OUT/web/app/api/v1/stocklana/research/"
for f in test.sh sync-shared.mjs e2e-bsc.mjs run-dev.sh diag_value.py make-public.sh gen_bsc_universe.py gen_bsc_themes.py; do cp "$SRC/dev/$f" "$OUT/dev/$f"; done
cp "$SRC/PUBLIC_README.md" "$OUT/README.md"
cp "$SRC/PUBLIC_NOTICE.md" "$OUT/NOTICE.md"
printf 'node_modules\n__pycache__\n.pytest_cache\n*.sqlite*\n.env*\nsecrets/\n' > "$OUT/.gitignore"
# Refuse to produce a snapshot that contains a credential: the actual values are read from the local key files at run
# time (never written here), plus generic credential shapes.
for envf in "$HOME/.config/sta-gateway/binance-web3.env" "$HOME/.config/sta-gateway/gateway.env"; do
  [ -f "$envf" ] || continue
  while IFS='=' read -r _ value; do
    [ -n "$value" ] && grep -rqF -- "$value" "$OUT" && { echo "a local credential value appears in the snapshot; refused" >&2; exit 1; }
  done < "$envf"
done
if grep -rIlE "BX-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|sk-ant-[A-Za-z0-9_-]{20}|-----BEGIN [A-Z ]*PRIVATE KEY-----" "$OUT" | grep -v "engine/tools/verify-bundle.mjs"; then
  echo "credential-shaped content found; snapshot refused" >&2; exit 1; fi
echo "snapshot ready: $OUT ($(find "$OUT" -type f | wc -l | tr -d ' ') files)"
