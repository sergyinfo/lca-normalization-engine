#!/bin/bash
#
# assert-coverage.sh — fail LOUDLY if rows were ingested but left unclassified
# (no soc_code AND not quarantined). Guards against the false-completeness trap:
# a drained queue looks identical whether it classified everything or was never
# filled. This asserts against the END STATE instead of trusting the queue.
#
# Scope via SWEEP_FILING_YEARS (same as burst-sweep). Threshold via
# COVERAGE_MAX_UNCLASSIFIED (default 500 — a handful of un-processable rows is
# tolerated; a systemic enqueue gap is not). COVERAGE_WARN_ONLY=true logs instead
# of failing (the backfill processor uses this; the quarterly burst hard-fails so
# a candidate is NEVER built from incomplete data — a non-zero exit propagates to
# the burst's ERR trap: failure SNS + box stays up for debugging).
#
# Required env: REGION NOTIFY_TOPIC RELEASE
set -euo pipefail
cd /opt/lca
THRESH="${COVERAGE_MAX_UNCLASSIFIED:-500}"

YEAR_FILTER=""
[ -n "${SWEEP_FILING_YEARS:-}" ] && \
  YEAR_FILTER="AND r.filing_year = ANY(string_to_array('${SWEEP_FILING_YEARS}', ',')::int[])"

N=$(docker compose exec -T db psql -U lca_user -d lca_db -tA -c "
  SELECT count(*) FROM lca_records r
  WHERE NOT (data ? 'soc_code')
    AND NOT EXISTS (SELECT 1 FROM staging.quarantine_records q
                     WHERE q.raw_data->>'_nlp_id' = r.data->>'_nlp_id')
    ${YEAR_FILTER}" | tr -dc '0-9')
N="${N:-0}"
echo "[assert-coverage] unclassified+unquarantined: $N (threshold $THRESH; scope ${SWEEP_FILING_YEARS:-all})"

if [ "$N" -gt "$THRESH" ]; then
  aws sns publish --region "$REGION" --topic-arn "$NOTIFY_TOPIC" \
    --subject "[LCA] COVERAGE FAIL ($RELEASE): $N rows unclassified" \
    --message "$N rows (scope ${SWEEP_FILING_YEARS:-all}) are ingested but have no soc_code and are not quarantined — the NLP step did not cover them. See CloudWatch /lca/burst/userdata." || true
  if [ "${COVERAGE_WARN_ONLY:-false}" = "true" ]; then
    echo "[assert-coverage] WARN-ONLY: over threshold, continuing"
  else
    echo "[assert-coverage] FAIL: $N > $THRESH — candidate will NOT be built"
    exit 1
  fi
else
  echo "[assert-coverage] OK"
fi
