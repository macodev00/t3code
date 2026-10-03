#!/usr/bin/env bash
# Start an isolated T3 Code web stack (server + Vite web) for screenshots.
# Usage: t3-serve.sh <t3code-checkout> <fixture-project-dir> <state-dir> [web_port] [server_port]
# Prints PAIRING_URL=... and writes PIDs to <state-dir>/pids. No provider credentials needed.
# `start --auto-bootstrap-project-from-cwd` creates the project AND an empty "New thread" (the Diff/Files
# surfaces need a real thread; draft threads disable them). Stop with: bin/t3-stop.sh <state-dir>
set -euo pipefail
REPO=$(realpath "$1"); FIXTURE=$(realpath "$2"); STATE=$(mkdir -p "$3" && realpath "$3")
WEB_PORT=${4:-6133}; SERVER_PORT=${5:-14173}
export PATH="$HOME/.local/node24/bin:$PATH"
mkdir -p "$STATE/home"
cd "$REPO/apps/web"
PORT=$WEB_PORT T3CODE_PORT=$SERVER_PORT T3CODE_SINGLE_ORIGIN_DEV=1 T3CODE_MODE=web \
  VITE_DEV_SERVER_URL="http://localhost:$WEB_PORT" \
  setsid nohup "$REPO/node_modules/.bin/vp" dev --port "$WEB_PORT" --strictPort > "$STATE/web.log" 2>&1 &
echo $! > "$STATE/pids"
cd "$FIXTURE"
T3CODE_NO_BROWSER=1 setsid nohup node "$REPO/apps/server/src/bin.ts" start --mode web --no-browser --host 127.0.0.1 \
  --port "$SERVER_PORT" --base-dir "$STATE/home" --dev-url "http://localhost:$WEB_PORT" \
  --auto-bootstrap-project-from-cwd "$FIXTURE" > "$STATE/server.log" 2>&1 &
echo $! >> "$STATE/pids"
for i in $(seq 1 120); do
  if grep -qE "^Token: |pairingUrl|Listening on" "$STATE/server.log" 2>/dev/null; then break; fi; sleep 1
done
# `start` logs "pairingUrl: http://localhost:<web>/pair#token=XXXX" (with --dev-url it already points at Vite).
for i in $(seq 1 60); do grep -q "pairingUrl" "$STATE/server.log" && break; sleep 1; done
TOKEN=$(grep -oE 'pairingUrl: [^ ]*#token=[A-Z0-9]+' "$STATE/server.log" | tail -1 | sed 's/.*#token=//')
echo "PAIRING_URL=http://localhost:$WEB_PORT/pair#token=$TOKEN"
