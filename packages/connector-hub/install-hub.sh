#!/usr/bin/env bash
# Installs the connector hub as a launchd agent on this Mac (FR-17): starts at
# login, restarts itself, logs under ~/Library/Logs/UnifiedInbox. Rerun to update.
#   RELAY_URL=https://inbox.example.net ./install-hub.sh [--uninstall]
set -euo pipefail
LABEL=com.unified-inbox.hub
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL."
  exit 0
fi

: "${RELAY_URL:?Set RELAY_URL to the relay's public origin, e.g. https://inbox.example.net}"
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then echo "node (26 or newer) is required; install it first." >&2; exit 1; fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 24 )); then echo "node 24 or newer is required (found $("$NODE" --version))." >&2; exit 1; fi

mkdir -p "$HOME/Library/Logs/UnifiedInbox" "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE|g" -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__RELAY_URL__|$RELAY_URL|g" \
    -e "s|__HUB_LABEL__|${HUB_LABEL:-$(scutil --get ComputerName)}|g" -e "s|__HOME__|$HOME|g" \
    "$HERE/launchd/$LABEL.plist.template" > "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Installed $LABEL. Logs: ~/Library/Logs/UnifiedInbox/hub.log"
echo "Next: grant Full Disk Access to $NODE (System Settings → Privacy & Security → Full Disk Access), then: launchctl kickstart -k gui/$(id -u)/$LABEL"
