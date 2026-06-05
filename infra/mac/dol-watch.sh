#!/bin/bash
#
# dol-watch.sh — tiny daily DOL LCA-release checker for macOS.
#
# Runs from a launchd LaunchAgent (at login + once a day). Your Mac has a
# residential IP, so DOL's Akamai WAF lets it through (it blocks AWS and
# datacenter hosts — that's why this can't run in the cloud).
#
# Each run:
#   1. Fetch the DOL OFLC performance page.
#   2. Find the newest in-scope "LCA_Disclosure_Data_FY<year>" file
#      (filing_year >= START_YEAR; annual/Q4 are cumulative supersets).
#   3. If it's newer than what we last processed (a tiny state file):
#        download it -> upload to the S3 inbox -> fire the burst -> NOTIFY.
#   4. Nothing new  -> exit silently (no notification — zero nag).
#      Anything fails -> NOTIFY with the reason.
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

# 1. Fetch the DOL page (residential IP -> 200; Akamai 403s datacenters).
html="$(curl -fsS --compressed -A "$UA" \
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \
  -H 'Accept-Language: en-US,en;q=0.9' \
  "$DOL_URL")" || fail "DOL page fetch failed (curl exit $?) — IP blocked or page down"

# 2. Pick the newest in-scope LCA Disclosure file. Mark = "YYYY-Q" (annual = Q4).
best_mark=""; best_url=""; best_name=""
while IFS= read -r href; do
  [ -n "$href" ] || continue
  name="${href##*/}"
  [[ "$name" =~ LCA_Disclosure_Data_FY(20[0-9][0-9]) ]] || continue
  year="${BASH_REMATCH[1]}"
  [ "$year" -lt "$START_YEAR" ] && continue
  if [[ "$name" =~ _Q([1-4]) ]]; then q="${BASH_REMATCH[1]}"; else q=4; fi
  mark="$year-$q"
  case "$href" in http*) url="$href" ;; *) url="https://www.dol.gov$href" ;; esac
  if [ -z "$best_mark" ] || [[ "$mark" > "$best_mark" ]]; then
    best_mark="$mark"; best_url="$url"; best_name="$name"
  fi
done < <(printf '%s' "$html" | grep -oE 'href="[^"]+\.xlsx"' | sed -E 's/^href="//; s/"$//')

[ -n "$best_mark" ] || fail "No in-scope LCA Disclosure files on the page (blocked or page layout changed)"

state="$(cat "$STATE_FILE" 2>/dev/null || echo '0000-0')"
echo "[$(ts)] newest on page: $best_mark ($best_name); last processed: $state"
if [[ ! "$best_mark" > "$state" ]]; then
  echo "[$(ts)] no new release — done (silent)"; exit 0
fi

# 3. New release — download (cumulative file; carry a Referer like a browser).
tmp="${TMPDIR:-/tmp}/$best_name"
echo "[$(ts)] new release -> downloading $best_url"
curl -fsS --compressed -A "$UA" -e "$DOL_URL" -o "$tmp" "$best_url" \
  || { rm -f "$tmp"; fail "Download failed for $best_name (HTTP error)"; }
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
