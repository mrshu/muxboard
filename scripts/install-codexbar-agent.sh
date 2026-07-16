#!/usr/bin/env bash
#
# Keep `codexbar serve` alive for Muxboard's LCD (macOS).
#
# Muxboard's LCD reads CodexBar over HTTP from `codexbar serve`. That process
# can exit unexpectedly (e.g. on some CodexBar builds it crashes when Codex's
# remote-control status changes), and a bare `codexbar serve` stays dead until
# you restart it by hand — the LCD then shows the muted "stale"/offline state.
#
# This installs a launchd user agent with KeepAlive, so the server starts at
# login and is respawned within a couple of seconds every time it exits. The
# LCD then never sits past its staleness threshold on a server crash.
#
#   bash scripts/install-codexbar-agent.sh              # install + load
#   CODEXBAR_PORT=8099 bash scripts/install-codexbar-agent.sh
#   bash scripts/install-codexbar-agent.sh --uninstall  # remove
#
# Idempotent: re-running reinstalls with the current codexbar path and port.
set -euo pipefail

LABEL="com.mrshu.codexbar-serve"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${CODEXBAR_PORT:-17777}"
LOG="/tmp/codexbar-serve.log"

say()  { printf '▸ %s\n' "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "launchd agents are macOS-only."

if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  say "Removed $LABEL. (codexbar serve is no longer kept alive.)"
  exit 0
fi

BIN="$(command -v codexbar || true)"
[ -n "$BIN" ] || die "codexbar not found on PATH — install CodexBar's CLI first."

# Refuse to install a crash-looping agent if the port is held by something other
# than codexbar: KeepAlive would restart-storm every ThrottleInterval forever.
holder="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
if [ -n "$holder" ]; then
  hname="$(ps -p "$holder" -o comm= 2>/dev/null || true)"
  case "$hname" in
    *codexbar*) : ;; # our own (hand-started) server — we take it over below
    *) die "Port $PORT is already in use by PID $holder ($hname). Free it, or set CODEXBAR_PORT to a free port, then re-run." ;;
  esac
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
    <string>serve</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>StandardOutPath</key><string>$LOG</string>
</dict>
</plist>
EOF

# Free the port from any hand-started server, then let launchd own it.
pkill -f "codexbar serve --port $PORT" 2>/dev/null || true
sleep 1
launchctl unload "$PLIST" 2>/dev/null || true
if ! launchctl load -w "$PLIST"; then
  die "launchctl load failed for $PLIST. On an SSH/non-GUI session, log in locally and re-run (or: launchctl bootstrap gui/\$(id -u) \"$PLIST\")."
fi

say "Installed $LABEL: $BIN serve --port $PORT (auto-restarts, logs to $LOG)."
say "Verify with: curl -s http://127.0.0.1:$PORT/health"
