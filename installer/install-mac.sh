#!/bin/bash
# KawKaw installer for macOS. Run from the KawKaw folder:  bash installer/install-mac.sh
set -e
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install it from https://nodejs.org (LTS) or: brew install node"; exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then echo "Node.js 20+ is required (you have $(node -v))."; exit 1; fi

echo "→ Installing dependencies…"
npm install --omit=dev --no-audit --no-fund

echo "→ Connecting to Claude and setting up auto-start…"
node bridge/src/cli.js setup
launchctl unload "$HOME/Library/LaunchAgents/com.kawkaw.daemon.plist" 2>/dev/null || true
launchctl load -w "$HOME/Library/LaunchAgents/com.kawkaw.daemon.plist"

echo "→ Building the Premiere panel…"
node installer/package-plugin.js
open dist/KawKaw.ccx || true

echo ""
echo "✔ Done. Restart Claude, then in Premiere open Window > UXP Plugins > KawKaw."
echo "  Settings: http://127.0.0.1:47321/settings"
