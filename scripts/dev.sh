#!/usr/bin/env bash
#
# Build + install Muxboard, then watch for changes.
#
# Prerequisite: cmux must allow external automation. In cmux, set
#   Settings → Automation → Socket Control Mode → Automation
# (or add `"automation": { "socketControlMode": "automation" }` to
# ~/.config/cmux/cmux.json) and FULLY quit + relaunch cmux. Without it, cmux
# rejects the Stream Deck plugin and the keys stay on the offline state.
#
#   npm run dev
#
set -euo pipefail
cd "$(dirname "$0")/.."

PLUGIN_DIR="com.mrshu.muxboard.sdPlugin"
PLUGIN_UUID="com.mrshu.muxboard"
STREAMDECK="npx --no-install streamdeck"

# CodexBar port (TCP; override via env). Must match the plugin config.
CODEXBAR_PORT="${CODEXBAR_PORT:-17777}"

echo "▸ Generating icons (if missing) and building…"
[ -f "$PLUGIN_DIR/imgs/plugin/icon.png" ] || npm run icons
npm run build

# CodexBar (TCP) powers the LCD; background it if not already up.
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

echo "▸ Done. Keys read cmux directly; LCD reads CodexBar."
echo "  One-time setup:"
echo "    • cmux Socket Control Mode = 'Automation' (see header)"
echo "    • Install the device profile: quit the Stream Deck app, run"
echo "      'npm run install-profile', reopen it, and pick the 'Muxboard' profile."
echo "▸ Watching for changes (Ctrl-C to stop)…"
npm run watch
