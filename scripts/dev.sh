#!/usr/bin/env bash
#
# Run Muxboard. IMPORTANT: run this INSIDE a cmux terminal — the bridge must be
# a descendant of the cmux session or cmux's socket rejects it ("broken pipe").
#
# It builds + links the plugin into the Stream Deck app, starts CodexBar in the
# background (TCP, session-independent), then runs the cmux bridge in the
# FOREGROUND (so it stays in the cmux session). Leave it running.
#
#   npm run dev          # inside a cmux pane
#
# For live plugin development, run `npm run watch` in a separate pane.
#
set -euo pipefail
cd "$(dirname "$0")/.."

PLUGIN_DIR="com.mrshu.muxboard.sdPlugin"
PLUGIN_UUID="com.mrshu.muxboard"
STREAMDECK="npx --no-install streamdeck"

# Ports (hardcoded; override via env). Must match the plugin config.
CODEXBAR_PORT="${CODEXBAR_PORT:-17777}"
BRIDGE_PORT="${MUXBOARD_BRIDGE_PORT:-17779}"

if [ -z "${CMUX_WORKSPACE_ID:-}" ]; then
  echo "⚠ Not inside a cmux session (CMUX_WORKSPACE_ID unset)."
  echo "  The bridge will fail with 'broken pipe'. Open a cmux terminal and rerun."
fi

echo "▸ Generating icons (if missing) and building…"
[ -f "$PLUGIN_DIR/imgs/plugin/icon.png" ] || npm run icons
npm run build
npm run profile

# CodexBar (TCP) can run anywhere; background it if not already up.
if ! curl -sf -m 2 "http://127.0.0.1:${CODEXBAR_PORT}/health" >/dev/null 2>&1; then
  if command -v codexbar >/dev/null 2>&1; then
    echo "▸ Starting 'codexbar serve --port ${CODEXBAR_PORT}' in the background…"
    (codexbar serve --port "${CODEXBAR_PORT}" >/tmp/muxboard-codexbar.log 2>&1 &)
  else
    echo "⚠ codexbar not found on PATH — the LCD will show an offline state."
  fi
fi

# Link + (re)start the plugin if the Stream Deck CLI is available.
if npx --no-install streamdeck --version >/dev/null 2>&1; then
  echo "▸ Linking + restarting the plugin in the Stream Deck app…"
  $STREAMDECK link "$PLUGIN_DIR" 2>/dev/null || true
  $STREAMDECK restart "$PLUGIN_UUID" 2>/dev/null || true
else
  echo "⚠ @elgato/cli not available; skipping link. Run 'npm i' first."
fi

echo "▸ Starting the cmux bridge in the foreground (Ctrl-C to stop)…"
echo "  Keep this running. The Stream Deck profile auto-applies; keys populate"
echo "  from cmux via the bridge, the LCD from CodexBar."
exec node scripts/bridge.mjs
