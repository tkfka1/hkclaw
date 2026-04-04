#!/bin/bash
# start-hkclaw-admin.sh — Start HKClaw Admin Web without systemd

set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PID_FILE="$PROJECT_ROOT/hkclaw-admin.pid"
NODE_BIN="${NODE_BIN:-}"

if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || true)
fi

if [ -z "$NODE_BIN" ]; then
  echo "node not found in PATH. Set NODE_BIN to override." >&2
  exit 1
fi

cd "$PROJECT_ROOT"

export SERVICE_ID="admin-web"
export ASSISTANT_NAME="admin-web"
export SERVICE_ROLE="dashboard"
export SERVICE_AGENT_TYPE="claude-code"

# Stop existing instance if running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing hkclaw-admin (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting HKClaw Admin Web..."
nohup "$NODE_BIN" "$PROJECT_ROOT/dist/admin-standalone.js" \
  >> "$PROJECT_ROOT/logs/hkclaw-admin.log" \
  2>> "$PROJECT_ROOT/logs/hkclaw-admin.error.log" &

echo $! > "$PID_FILE"
echo "hkclaw-admin started (PID $!)"
echo "Logs: tail -f $PROJECT_ROOT/logs/hkclaw-admin.log"
