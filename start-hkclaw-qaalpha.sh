#!/bin/bash
# start-hkclaw-qaalpha.sh — Start HKClaw Normal Service (Codex) without systemd

set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PID_FILE="$PROJECT_ROOT/hkclaw-qaalpha.pid"
ENV_FILE="$PROJECT_ROOT/.env.agent.qaalpha"
NODE_BIN="${NODE_BIN:-}"

if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || true)
fi

if [ -z "$NODE_BIN" ]; then
  echo "node not found in PATH. Set NODE_BIN to override." >&2
  exit 1
fi

cd "$PROJECT_ROOT"

# Load environment files
set -a
source "$ENV_FILE"
set +a

export SERVICE_ID="qaalpha"
export SERVICE_AGENT_TYPE="codex"
export SERVICE_ROLE="normal"
export ASSISTANT_NAME="QA Alpha"
export HKCLAW_SERVICE_ENV_PATH="$ENV_FILE"

# Stop existing instance if running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing hkclaw-qaalpha (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting HKClaw Normal Service (Codex)..."
nohup "$NODE_BIN" "$PROJECT_ROOT/dist/index.js" \
  >> "$PROJECT_ROOT/logs/hkclaw-qaalpha.log" \
  2>> "$PROJECT_ROOT/logs/hkclaw-qaalpha.error.log" &

echo $! > "$PID_FILE"
echo "hkclaw-qaalpha started (PID $!)"
echo "Logs: tail -f $PROJECT_ROOT/logs/hkclaw-qaalpha.log"
