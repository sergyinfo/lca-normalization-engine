#!/bin/bash
#
# upload-dol.sh — one-shot: push DOL Disclosure file(s) to the S3 inbox and fire
# the burst. For MANUAL uploads (historical backfills, or a release dol-watch
# can't reach). The daily dol-watch agent does this automatically for new FLAG
# releases; this is the by-hand equivalent for arbitrary files.
#
#   ./upload-dol.sh data/H-1B_Disclosure_Data_FY2019.xlsx [more.xlsx ...]
#   ./upload-dol.sh --defer-nlp --instance-type c7g.4xlarge data/*.xlsx   # big backfill
#
# Flags (per-run overrides passed to the burst via the trigger event):
#   --defer-nlp                 skip the NLP barrier — ingest fast, normalise in the
#                               background on the kept-alive review box (big backfills).
#   --instance-type <type>      EC2 size for THIS run (default c7g.2xlarge).
#
# The burst syncs the whole inbox on start, so upload ALL the files you want in one
# run, THEN this fires a single build.run for the batch.

set -euo pipefail
PROFILE="${DOL_UPLOAD_PROFILE:-h1b-report}"
REGION="${AWS_REGION:-us-east-1}"
BUCKET="${DOL_UPLOAD_BUCKET:-lcasharedstack-ingestscratchbucket64251afd-obtmmxvmd5cg}"

DEFER_NLP=false
INSTANCE_TYPE=""
files=()
while [ $# -gt 0 ]; do
  case "$1" in
    --defer-nlp)          DEFER_NLP=true; shift;;
    --instance-type)      INSTANCE_TYPE="${2:?--instance-type needs a value}"; shift 2;;
    --instance-type=*)    INSTANCE_TYPE="${1#*=}"; shift;;
    -*)                   echo "unknown flag: $1" >&2; exit 2;;
    *)                    files+=("$1"); shift;;
  esac
done
[ ${#files[@]} -ge 1 ] || { echo "usage: $0 [--defer-nlp] [--instance-type <type>] <file.xlsx> [...]"; exit 2; }

names=()
for f in "${files[@]}"; do
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
python3 - "$DEFER_NLP" "$INSTANCE_TYPE" "${names[@]}" >"$entries" <<'PY'
import sys, json
defer, itype, files = sys.argv[1], sys.argv[2], sys.argv[3:]
detail = {"source": "upload-dol", "files": files, "deferNlp": defer}
if itype:
    detail["instanceType"] = itype  # else the Step Function default (c7g.2xlarge)
print(json.dumps([{"Source": "lca.manual", "DetailType": "build.run", "Detail": json.dumps(detail)}]))
PY
echo "firing lca.manual/build.run (deferNlp=$DEFER_NLP, instanceType=${INSTANCE_TYPE:-default}) ..."
aws --profile "$PROFILE" --region "$REGION" events put-events --entries "file://$entries"
rm -f "$entries"
echo "done — burst triggered. Watch the operator.h1b.report 'ready for review' email,"
echo "or tail CloudWatch /lca/burst/userdata."
