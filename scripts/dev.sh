#!/usr/bin/env bash
#
# Dev runner: build the plugin, link it into the Stream Deck app, and watch for
# changes. Requires the Elgato Stream Deck desktop app to be installed and
# running for link/restart to take effect; the build + icons steps work without
# it. CodexBar serve is started in the background if not already up.
#
#   npm run dev
#
set -euo pipefail
cd "$(dirname "$0")/.."

PLUGIN_DIR="com.mrshu.muxboard.sdPlugin"
PLUGIN_UUID="com.mrshu.muxboard"
STREAMDECK="npx --no-install streamdeck"

echo "▸ Generating icons (if missing) and building…"
[ -f "$PLUGIN_DIR/imgs/plugin/icon.png" ] || npm run icons
npm run build

# Ensure CodexBar serve is reachable; start it in the background if not.
if ! curl -sf -m 2 "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
  if command -v codexbar >/dev/null 2>&1; then
    echo "▸ Starting 'codexbar serve' in the background (port 8080)…"
    (codexbar serve >/tmp/muxboard-codexbar.log 2>&1 &)
  else
    echo "⚠ codexbar not found on PATH — the LCD will show an offline state."
  fi
fi

# Link + (re)start the plugin if the Stream Deck CLI is available.
if npx --no-install streamdeck --version >/dev/null 2>&1; then
  echo "▸ Linking plugin into the Stream Deck app…"
  $STREAMDECK link "$PLUGIN_DIR" || echo "⚠ link failed (is the Stream Deck app installed?)"
  $STREAMDECK restart "$PLUGIN_UUID" 2>/dev/null || true
else
  echo "⚠ @elgato/cli not available; skipping link. Run 'npm i' first."
fi

echo "▸ Watching for changes (Ctrl-C to stop)…"
echo "  Place the 'Attention Slot' action on all 8 keys and the 'Muxboard Dial'"
echo "  action on all 4 dials of your Stream Deck+ profile."
npm run watch
