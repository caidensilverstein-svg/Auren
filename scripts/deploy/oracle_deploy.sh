#!/bin/bash
# Deploy origin/main to the Oracle auren-mcp service. Run ON Oracle (e.g. through Command Dispatch, target oracle).
#
#   bash oracle_deploy.sh            deploy origin/main
#   bash oracle_deploy.sh rollback   restore the newest backup commit and restart
#
# Order: backup (code and ~/.auren state) -> fetch and fast-forward main -> syntax check -> pm2 restart -> health check ->
# authenticated tools/list (prints only the tool count, never the key) -> on any failure, roll back to the previous commit.
set -uo pipefail
DIR=/home/ubuntu/scos/auren-mcp
BK=/home/ubuntu/backups
cd "$DIR" || exit 1

if [ "${1:-}" = rollback ]; then
  PREV=$(cat "$BK/auren-mcp-last-deploy.prev" 2>/dev/null) || { echo "no recorded previous commit"; exit 1; }
  git reset --hard "$PREV" && pm2 restart auren-mcp --update-env >/dev/null && sleep 3 && curl -sf -m 5 localhost:3012/health && echo " rolled back to $PREV"
  exit $?
fi

TS=$(date +%Y%m%d-%H%M%S); B="$BK/auren-mcp-$TS"
mkdir -p "$B" && rsync -a --exclude node_modules "$DIR/" "$B/code/" && cp -a /home/ubuntu/.auren "$B/dot-auren" 2>/dev/null
PREV=$(git rev-parse HEAD); echo "$PREV" > "$BK/auren-mcp-last-deploy.prev"
echo "backup: $B  (running commit $PREV)"

git fetch -q origin main && git checkout -q main && git merge -q --ff-only origin/main || { echo "cannot fast-forward main; nothing changed"; exit 1; }
echo "now at $(git rev-parse --short HEAD)"
( cd mcp && [ -d node_modules ] || npm ci --omit=dev ) >/dev/null 2>&1
node --check mcp/index.js || { echo "syntax check failed"; git reset -q --hard "$PREV"; exit 1; }

pm2 restart auren-mcp --update-env >/dev/null
OK=0; for i in $(seq 1 15); do sleep 1; if curl -sf -m 3 localhost:3012/health >/dev/null; then OK=1; break; fi; done
if [ $OK = 1 ]; then
  KEY=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json;print(next(p['pm2_env'].get('AUREN_MCP_KEY','') for p in json.load(sys.stdin) if p['name']=='auren-mcp'))" 2>/dev/null)
  N=$(curl -s -m 8 -X POST "localhost:3012/mcp/$KEY" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -c "import sys,json;t=sys.stdin.read();t=t[t.index('{'):];print(len(json.loads(t)['result']['tools']))" 2>/dev/null)
  echo "health ok; tools: ${N:-unknown}"
  [ -n "${N:-}" ] && [ "$N" -ge 20 ] && { echo "deployed $(git rev-parse --short HEAD); rollback: bash $0 rollback"; exit 0; }
fi
echo "health or tool check failed: rolling back to $PREV"
git reset -q --hard "$PREV" && pm2 restart auren-mcp --update-env >/dev/null && sleep 3 && curl -sf -m 5 localhost:3012/health && echo " rolled back"
exit 1
