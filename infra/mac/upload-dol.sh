#!/bin/bash
#
# upload-dol.sh — one-shot: push DOL Disclosure file(s) to the S3 inbox and fire
# the burst. For MANUAL uploads (historical backfills, or a release dol-watch
# can't reach). The daily dol-watch agent does this automatically for new FLAG
# releases; this is the by-hand equivalent for arbitrary files.
#
#   ./upload-dol.sh data/H-1B_Disclosure_Data_FY2019.xlsx [more.xlsx ...]
#
# The burst (already deployed) syncs the whole inbox on start, so upload ALL the
# files you want in one run, THEN this fires a single build.run for the batch.

set -euo pipefail
PROFILE="${DOL_UPLOAD_PROFILE:-h1b-report}"
REGION="${AWS_REGION:-us-east-1}"
BUCKET="${DOL_UPLOAD_BUCKET:-lcasharedstack-ingestscratchbucket64251afd-obtmmxvmd5cg}"

[ $# -ge 1 ] || { echo "usage: $0 <file.xlsx> [file2.xlsx ...]"; exit 2; }

names=()
for f in "$@"; do
  [ -f "$f" ] || { echo "not found: $f" >&2; exit 1; }
  n=$(basename "$f")
  echo "uploading $n ($(du -h "$f" | cut -f1)) -> s3://$BUCKET/incoming/$n"
  aws --profile "$PROFILE" --region "$REGION" s3 cp "$f" "s3://$BUCKET/incoming/$n" \
    --content-type 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  names+=("$n")
done

# Fire one build.run for the batch. Build the ENTIRE entries JSON in python so all
# escaping (Detail is a JSON *string*) is correct — hand-rolled quoting double-encodes.
entries="$(mktemp)"
python3 - "${names[@]}" >"$entries" <<'PY'
import sys, json
detail = json.dumps({"source": "upload-dol", "files": sys.argv[1:]})
print(json.dumps([{"Source": "lca.manual", "DetailType": "build.run", "Detail": detail}]))
PY
echo "firing lca.manual/build.run ..."
aws --profile "$PROFILE" --region "$REGION" events put-events --entries "file://$entries"
rm -f "$entries"
echo "done — burst triggered. Watch the operator.h1b.report 'ready for review' email,"
echo "or tail CloudWatch /lca/burst/userdata."
