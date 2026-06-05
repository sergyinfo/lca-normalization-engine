#!/bin/bash
#
# install.sh — set up the dol-watch LaunchAgent on this Mac.
#
# Idempotent: re-run it any time (e.g. after `git pull`) to reinstall/restart.
# It does NOT touch your AWS credentials — set up the `dol-watch` profile once,
# separately (see README.md, "1. AWS profile").

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="report.h1b.dol-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

mkdir -p "$HOME/.dol-watch" "$HOME/Library/LaunchAgents"
chmod +x "$HERE/dol-watch.sh"

# Render the template -> ~/Library/LaunchAgents with this Mac's real paths.
sed -e "s#__SCRIPT__#$HERE/dol-watch.sh#g" \
    -e "s#__HOME__#$HOME#g" \
    "$HERE/$LABEL.plist.template" > "$PLIST"

# (Re)load it. bootout first so a re-run cleanly replaces the old definition.
launchctl bootout   "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable    "gui/$UID_NUM/$LABEL"

echo "Installed LaunchAgent: $PLIST"

# Verify the AWS profile exists before the first kick (clearer error than a
# notification later). Non-fatal — just warns.
if ! aws configure list --profile dol-watch >/dev/null 2>&1; then
  echo "!! AWS profile 'dol-watch' is not set up yet — do README.md step 1 first."
  echo "   (The agent is installed and will run, but uploads will fail until then.)"
fi

# Run it once now so you get an immediate result (a notification if there's a
# new release or an error; silence means 'nothing new', which is normal).
echo "Kicking a first run now..."
launchctl kickstart -k "gui/$UID_NUM/$LABEL"
sleep 2
echo
echo "Done. Tail the log with:  tail -f ~/.dol-watch/dol-watch.log"
