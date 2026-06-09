#!/bin/bash
#
# dol-watch.sh — tiny daily DOL LCA-release checker for macOS.
#
# Runs from a launchd LaunchAgent (at login + once a day). The OFLC performance
# PAGE sits behind Akamai Bot Manager, which now hard-403s curl regardless of IP
# (it fingerprints the TLS/HTTP client, not just the address). So we read the page
# out of your REAL Safari via AppleScript — a genuine browser runs Akamai's JS and
# is allowed through. The data FILES, by contrast, are on AkamaiNetStorage (a plain
# static CDN, no bot check) and download fine with curl.
#
# Each run:
#   1. Load the DOL OFLC performance page in Safari; read the .xlsx links from the DOM.
#   2. Find the newest in-scope LCA disclosure file (filing_year >= START_YEAR;
#      annual/Q4 are cumulative supersets). NB: DOL sometimes MISSPELLS the name
#      (e.g. FY2026 Q2 shipped as "LCA_Dislclosure_Data_FY2026_Q2.xlsx"), so the
#      match tolerates "Dis…closure".
#   3. If it's newer than what we last processed (a tiny state file):
#        download it (curl) -> upload to the S3 inbox -> fire the burst -> NOTIFY.
#   4. Nothing new  -> exit silently (no notification — zero nag).
#      Anything fails -> NOTIFY with the reason.
#
# One-time setup for the Safari read: Safari → Settings → Advanced → "Show features
# for web developers", then Develop → "Allow JavaScript from Apple Events" (persists),
# and grant Automation control of Safari when macOS first prompts.
#
# AWS auth: the `aws` CLI signs the requests using the `dol-watch` profile
# (a dedicated, least-privilege key: s3:PutObject incoming/* + events:PutEvents).
# See infra/mac/README.md for the one-time install + profile setup.

set -uo pipefail
export LC_ALL=C   # byte-wise string compare for the "YYYY-Q" high-water mark

# ----------------------------- CONFIG --------------------------------------
AWS_PROFILE_NAME="${DOL_WATCH_PROFILE:-dol-watch}"
AWS_REGION="${DOL_WATCH_REGION:-us-east-1}"
S3_BUCKET="${DOL_WATCH_BUCKET:-lcasharedstack-ingestscratchbucket64251afd-obtmmxvmd5cg}"
S3_PREFIX="incoming/"
DOL_URL="https://www.dol.gov/agencies/eta/foreign-labor/performance"
START_YEAR="${DOL_WATCH_START_YEAR:-2020}"
STATE_DIR="$HOME/.dol-watch"
STATE_FILE="$STATE_DIR/state"
LOG_FILE="$STATE_DIR/dol-watch.log"
COOKIE_JAR="$STATE_DIR/cookies.txt"
SAFARI_OSA_FILE="$STATE_DIR/fetch.applescript"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
# ---------------------------------------------------------------------------

mkdir -p "$STATE_DIR"
exec >>"$LOG_FILE" 2>&1   # everything below is logged
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

notify() {  # title, message  — macOS desktop notification (best-effort)
  /usr/bin/osascript -e "display notification \"${2//\"/\'}\" with title \"${1//\"/\'}\"" >/dev/null 2>&1 || true
}
fail() { echo "[$(ts)] FAIL: $1"; notify "DOL harvest failed" "$1"; exit 1; }

AWS_BIN="$(command -v aws || true)"
[ -n "$AWS_BIN" ] || fail "aws CLI not found on PATH (install it / fix the LaunchAgent PATH)"
aws() { "$AWS_BIN" --profile "$AWS_PROFILE_NAME" --region "$AWS_REGION" "$@"; }

echo "[$(ts)] --- run start ---"

# Single-flight: never let two runs (login + daily, or an install kick) overlap
# — concurrent requests look bursty to Akamai and get challenged.
LOCK="$STATE_DIR/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then echo "[$(ts)] another run in progress — exiting"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# The performance PAGE is Akamai-Bot-Manager-gated → curl gets a hard 403. Read it
# from the user's real Safari instead (it runs Akamai's JS legitimately). Returns
# the newline-separated absolute .xlsx URLs from the page DOM. Retries a couple
# times (Safari slow to launch / page slow to settle) before giving up.
#
# NB: the AppleScript is written to a FILE via a plain heredoc redirect — NOT
# captured through $( … <<'OSA' … ) — because bash 3.2 (which launchd's /bin/bash
# is) mis-parses a heredoc nested inside command substitution when the body has
# parens/quotes, corrupting the rest of the script. The file form is 3.2-safe.
cat >"$SAFARI_OSA_FILE" <<'OSA'
on run argv
  set theURL to item 1 of argv
  set safariWasRunning to (application "Safari" is running)
  tell application "Safari"
    make new document
    set myWin to front window
    set URL of document 1 to theURL
    set waited to 0
    repeat
      delay 1
      set waited to waited + 1
      try
        set rs to (do JavaScript "document.readyState" in document 1)
      on error
        set rs to "?"
      end try
      if rs is "complete" then exit repeat
      if waited > 60 then exit repeat
    end repeat
    delay 2
    set linksOut to ""
    set theErr to ""
    try
      set curURL to (URL of document 1)
      if curURL does not contain "foreign-labor/performance" then error "unexpected URL after load: " & curURL
      set jsCmd to "Array.from(document.querySelectorAll('a[href$=\".xlsx\"]')).map(function(a){return a.href}).join(String.fromCharCode(10))"
      set linksOut to (do JavaScript jsCmd in document 1)
    on error e
      set theErr to e
    end try
    -- Close the tab/window we opened; quit Safari if we launched it (or nothing's
    -- left open) so the agent never leaves a stray browser behind. A user's existing
    -- windows are preserved (we only quit when none remain).
    try
      close myWin
    end try
    try
      if (not safariWasRunning) or ((count of windows) is 0) then quit
    end try
    if theErr is not "" then error theErr
    if linksOut is "" then error "no .xlsx links found on page"
    return linksOut
  end tell
end run
OSA
browser_links() {  # echoes newline-separated absolute .xlsx URLs; returns 1 after retries
  local a out
  for a in 1 2 3; do
    if out="$(osascript "$SAFARI_OSA_FILE" "$DOL_URL" 2>&1)"; then
      printf '%s' "$out"; return 0
    fi
    echo "[$(ts)] Safari page-read attempt $a/3 failed: $out" >&2
    sleep $(( a * 15 ))
  done
  return 1
}
download() {  # url dest ; the file CDN (AkamaiNetStorage) intermittently 403s, so
              # retry generously with resume (-C -) to ride a ~1-2 min bad window.
              # No cookies: the page is read by Safari now, and a stale Akamai bot
              # cookie here only risks a 403 — the static file needs none.
  local a
  for a in 1 2 3 4 5 6; do
    curl -fsS --compressed -A "$UA" -e "$DOL_URL" -C - -o "$2" "$1" && return 0
    echo "[$(ts)] download attempt $a/6 failed — backing off" >&2
    sleep $(( a * 20 ))
  done
  return 1
}

# 1. Read the DOL page via Safari (Akamai 403s curl; a real browser passes).
links="$(browser_links)" \
  || fail "Safari page-read failed — check: Safari 'Allow JavaScript from Apple Events' is on, Automation control of Safari is granted, and you're logged into the GUI session"

# 2. Pick the newest in-scope LCA Disclosure file. Mark = "YYYY-Q" (annual = Q4).
#    Match tolerates DOL's "Dislclosure" misspelling (FY2026 Q2) but still excludes
#    the FLAG sub-files (LCA_Appendix_A_*, LCA_Worksites_*) — they lack "closure_Data".
best_mark=""; best_url=""; best_name=""
while IFS= read -r href; do
  [ -n "$href" ] || continue
  name="${href##*/}"
  [[ "$name" =~ LCA_Dis[A-Za-z]*closure_Data_FY(20[0-9][0-9]) ]] || continue
  year="${BASH_REMATCH[1]}"
  [ "$year" -lt "$START_YEAR" ] && continue
  if [[ "$name" =~ _Q([1-4]) ]]; then q="${BASH_REMATCH[1]}"; else q=4; fi
  mark="$year-$q"
  case "$href" in http*) url="$href" ;; *) url="https://www.dol.gov$href" ;; esac
  if [ -z "$best_mark" ] || [[ "$mark" > "$best_mark" ]]; then
    best_mark="$mark"; best_url="$url"; best_name="$name"
  fi
done < <(printf '%s\n' "$links")

[ -n "$best_mark" ] || fail "No in-scope LCA Disclosure files on the page (blocked or page layout changed)"

state="$(cat "$STATE_FILE" 2>/dev/null || echo '0000-0')"
echo "[$(ts)] newest on page: $best_mark ($best_name); last processed: $state"

# Dry run: report what we found + whether it's new, then stop (no download / upload /
# burst). Handy for testing detection without spending anything. `DOL_WATCH_DRY_RUN=1`.
if [ -n "${DOL_WATCH_DRY_RUN:-}" ]; then
  if [[ "$best_mark" > "$state" ]]; then isnew="YES (would download + upload + fire burst)"; else isnew="no"; fi
  echo "[$(ts)] DRY_RUN: newest=$best_mark name=$best_name new-vs-state($state)=$isnew"
  echo "[$(ts)] DRY_RUN: url=$best_url"
  exit 0
fi

if [[ ! "$best_mark" > "$state" ]]; then
  echo "[$(ts)] no new release — done (silent)"; exit 0
fi

# 3. New release — download (cumulative file; carry a Referer like a browser).
tmp="${TMPDIR:-/tmp}/$best_name"
echo "[$(ts)] new release -> downloading $best_url"
download "$best_url" "$tmp" \
  || { rm -f "$tmp"; fail "Download failed for $best_name after retries"; }
[ -s "$tmp" ] || { rm -f "$tmp"; fail "Downloaded file is empty: $best_name"; }
bytes="$(stat -f%z "$tmp" 2>/dev/null || echo '?')"
echo "[$(ts)] downloaded $bytes bytes"

# 4. Upload to the S3 inbox (aws CLI handles SigV4 + multipart for big files).
echo "[$(ts)] uploading -> s3://$S3_BUCKET/$S3_PREFIX$best_name"
aws s3 cp "$tmp" "s3://$S3_BUCKET/$S3_PREFIX$best_name" \
  --content-type 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' \
  || { rm -f "$tmp"; fail "S3 upload failed for $best_name"; }
rm -f "$tmp"

# 5. Fire the burst (the deployed ManualRunRule listens for lca.manual/build.run).
entries="$STATE_DIR/event.json"
cat >"$entries" <<JSON
[{"Source":"lca.manual","DetailType":"build.run","Detail":"{\"source\":\"mac-watch\",\"file\":\"$best_name\",\"s3key\":\"$S3_PREFIX$best_name\",\"release\":\"$best_mark\"}"}]
JSON
put_out="$(aws events put-events --entries "file://$entries" 2>&1)" \
  || fail "PutEvents failed: $put_out"
if printf '%s' "$put_out" | grep -q '"FailedEntryCount": 0'; then
  echo "[$(ts)] burst triggered: $put_out"
else
  fail "PutEvents reported a failed entry: $put_out"
fi

# 6. Success — persist the high-water mark and tell the human once.
echo "$best_mark" > "$STATE_FILE"
echo "[$(ts)] state updated to $best_mark — done"
notify "DOL: new LCA release" "$best_name uploaded — review pipeline triggered (release $best_mark). Watch for the operator.h1b.report email."
