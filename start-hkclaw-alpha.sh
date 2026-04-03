#!/bin/bash
# start-hkclaw-alpha.sh — Start HKClaw Normal Service (Codex) without systemd
# To stop: kill \$(cat /home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/hkclaw-alpha.pid)

set -euo pipefail

cd "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw"

# Load environment files
set -a
source "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/.env.agent.alpha"
set +a

export SERVICE_ID="alpha"
export SERVICE_AGENT_TYPE="codex"
export SERVICE_ROLE="normal"
export ASSISTANT_NAME="Alpha"
export HKCLAW_SERVICE_ENV_PATH="/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/.env.agent.alpha"

# Stop existing instance if running
if [ -f "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/hkclaw-alpha.pid" ]; then
  OLD_PID=$(cat "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/hkclaw-alpha.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing hkclaw-alpha (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting HKClaw Normal Service (Codex)..."
nohup "/home/hkyo/.nvm/versions/node/v24.14.1/bin/node" "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/dist/index.js" \
  >> "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/logs/hkclaw-alpha.log" \
  2>> "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/logs/hkclaw-alpha.error.log" &

echo $! > "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/hkclaw-alpha.pid"
echo "hkclaw-alpha started (PID $!)"
echo "Logs: tail -f /home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/logs/hkclaw-alpha.log"
