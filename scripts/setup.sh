#!/usr/bin/env bash
#
# Muxboard one-command installer (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/mrshu/muxboard/main/scripts/setup.sh | bash
#
# Downloads the latest packaged plugin from GitHub Releases, installs it and the
# 8-key + 4-dial device profile, and checks that cmux automation mode is enabled.
# Everything it touches is a published release asset — no repo clone required.
set -uo pipefail

REPO="mrshu/muxboard"
APP="Elgato Stream Deck"

say()  { printf '▸ %s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "Muxboard is macOS-only for now."
command -v curl >/dev/null 2>&1 || die "curl is required."
command -v node >/dev/null 2>&1 || die "Node.js >= 20 is required (https://nodejs.org)."

say "Finding the latest Muxboard release…"
api=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest") \
  || die "Could not reach the GitHub releases API."
urls=$(printf '%s\n' "$api" \
  | grep -o '"browser_download_url": *"[^"]*"' \
  | sed 's/.*"\(https[^"]*\)"/\1/')
plugin_url=$(printf '%s\n' "$urls" | grep '\.streamDeckPlugin$' | head -1 || true)
profile_url=$(printf '%s\n' "$urls" | grep 'install-profile\.mjs$' | head -1 || true)
[ -n "$plugin_url" ] || die "No .streamDeckPlugin asset in the latest release yet."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "Downloading the plugin…"
curl -fsSL "$plugin_url" -o "$tmp/Muxboard.streamDeckPlugin" || die "Download failed."
[ -n "$profile_url" ] && curl -fsSL "$profile_url" -o "$tmp/install-profile.mjs"

say "Installing the plugin into Stream Deck…"
open "$tmp/Muxboard.streamDeckPlugin"
printf '  Confirm the install in the Stream Deck app, then press Enter to continue… '
read -r _ </dev/tty 2>/dev/null || sleep 8
printf '\n'

# The profile must be written while the app is closed (it owns the store at
# runtime), so we quit it, write, and relaunch.
if [ -f "$tmp/install-profile.mjs" ]; then
  say "Installing the Muxboard profile (Stream Deck closes briefly)…"
  osascript -e "quit app \"$APP\"" >/dev/null 2>&1 || true
  sleep 2
  if node "$tmp/install-profile.mjs"; then
    say "Profile installed."
  else
    warn "Profile install skipped — you can add the actions to a profile manually."
  fi
  open -a "$APP" >/dev/null 2>&1 || true
fi

if command -v cmux >/dev/null 2>&1; then
  if cmux capabilities 2>/dev/null | grep -q '"access_mode"[^,]*automation'; then
    say "cmux automation mode: enabled."
  else
    warn "cmux is in cmuxOnly mode. Set Settings → Automation → Socket Control Mode → Automation, then fully quit and relaunch cmux."
  fi
else
  warn "cmux not found on PATH. Install cmux and enable automation mode."
fi

say "Done. Open Stream Deck and select the 'Muxboard' profile."
