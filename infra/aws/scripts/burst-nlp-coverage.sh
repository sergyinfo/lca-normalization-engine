#!/bin/bash
#
# burst-nlp-coverage.sh — after ingest, GUARANTEE + VERIFY NLP coverage for the
# just-ingested year(s): sweep (100% enqueue) -> wait for nlp-tasks to drain ->
# assert no row was left unclassified. Scoped to the inbox's filing years so it
# never re-sweeps the historical backlog. Called by the burst user-data on the
# normal (quarterly) path — NOT when NLP is deferred to the decoupled processor.
#
# Required env: REGION NOTIFY_TOPIC RELEASE LOCAL_FILES_DIR
set -euo pipefail
cd /opt/lca
: "${REGION:?}" "${NOTIFY_TOPIC:?}" "${RELEASE:?}" "${LOCAL_FILES_DIR:?}"

# Derive the just-ingested fiscal years from the inbox filenames
# (LCA_Disclosure_Data_FY2026.xlsx -> 2026). Fall back to the max year in PG so
# we never accidentally sweep globally (which would drag in the backlog).
INGEST_YEARS=$(ls "$LOCAL_FILES_DIR"/*.xlsx 2>/dev/null \
  | grep -oE 'FY20[0-9][0-9]' | grep -oE '20[0-9][0-9]' | sort -u | paste -sd, -)
if [ -z "$INGEST_YEARS" ]; then
  INGEST_YEARS=$(docker compose exec -T db psql -U lca_user -d lca_db -tA \
    -c "SELECT max(filing_year) FROM lca_records" | tr -dc '0-9')
fi
echo "[nlp-coverage] just-ingested years: ${INGEST_YEARS:-<unknown>}"
export SWEEP_FILING_YEARS="$INGEST_YEARS"

# 1. Guarantee every just-ingested row is enqueued (ingest enqueue is best-effort).
bash /opt/lca/infra/aws/scripts/burst-sweep.sh

# 2. Wait for the NLP queue to drain (classification + write-back complete).
SNS_TOPIC="$NOTIFY_TOPIC" REGION="$REGION" RELEASE="$RELEASE" \
  bash /opt/lca/infra/aws/scripts/burst-barrier.sh nlp-tasks

# 3. Assert the just-ingested year(s) are fully covered — hard-fail otherwise so a
#    candidate is never built from partially-classified data.
NOTIFY_TOPIC="$NOTIFY_TOPIC" REGION="$REGION" RELEASE="$RELEASE" \
  bash /opt/lca/infra/aws/scripts/assert-coverage.sh
echo "[nlp-coverage] coverage verified for {${INGEST_YEARS}}"
