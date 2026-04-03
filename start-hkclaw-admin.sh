#!/bin/bash
# start-hkclaw-admin.sh — Start HKClaw Admin Web without systemd
# To stop: kill \$(cat /home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/hkclaw-admin.pid)

set -euo pipefail

cd "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw"

export SERVICE_ID="admin-web"
export ASSISTANT_NAME="admin-web"
export SERVICE_ROLE="dashboard"
export SERVICE_AGENT_TYPE="claude-code"

# Stop existing instance if running
if [ -f "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/hkclaw-admin.pid" ]; then
  OLD_PID=$(cat "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/hkclaw-admin.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing hkclaw-admin (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting HKClaw Admin Web..."
nohup "/home/hkyo/.nvm/versions/node/v24.14.1/bin/node" "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/dist/admin-standalone.js" \
  >> "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/logs/hkclaw-admin.log" \
  2>> "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/logs/hkclaw-admin.error.log" &

echo $! > "/home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/hkclaw-admin.pid"
echo "hkclaw-admin started (PID $!)"
echo "Logs: tail -f /home/hkyo/.paperclip/instances/default/projects/11539895-8f39-4e0f-b029-7415aa82a51a/fa801b26-64ce-4ed2-a285-366223d55d09/hkclaw/logs/hkclaw-admin.log"
