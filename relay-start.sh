#!/usr/bin/env bash
# Starts the deck-remote relay (any-WiFi phone access) in the background.
# Port 8676 must be open in the cloud firewall / security list.
export PATH="/usr/bin:$PATH"
cd "$(dirname "$0")"
mkdir -p ~/logs
# already running? keep it
if curl -s --max-time 2 http://127.0.0.1:8676/health | grep -q '"ok":true'; then
  echo "relay already running"; exit 0
fi
nohup node relay.js --port 8676 >> ~/logs/deck-remote-relay.log 2>&1 &
echo "relay started on port 8676 (pid $!) — log: ~/logs/deck-remote-relay.log"
