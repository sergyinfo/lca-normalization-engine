#!/bin/bash
#
# nlp-processor.sh — the decoupled NLP processor (long-lived, off the review box).
#
# Why this exists: the burst box ingests all years + builds the candidate in HOURS,
# but classifying a big backfill (~6M rows @ ~90k/hr ≈ 65h) far exceeds the 36h
# review-box watchdog, and the burst's PG snapshot is taken with NLP deferred (so it
# holds only partially-classified data). This box owns the slow part: it restores the
# burst's snapshot, enqueues EVERY unclassified row (the ingest enqueue is best-effort
# — see apps/ingestor/sweep-enqueue.mjs), drains nlp-tasks to empty over days, then
# re-snapshots + rebuilds the candidate so the COMPLETE work persists and is promotable.
#
# Assumes the box is already bootstrapped (docker + node + pnpm + repo at /opt/lca),
# exactly like burst-finalize.sh — the CDK user-data does the bootstrap then calls this.
#
# Required env (CDK-resolved, passed by user-data):
#   REGION RELEASE INSTANCE_ID NOTIFY_TOPIC
#   LLM_SECRET LCADB_BUCKET ECR_REPO PGSNAP_BUCKET PGSNAP_KEY(optional, default latest.pgdump)
# Optional:
#   NLP_REPLICAS (default 1)             NLP_WORKER_CONCURRENCY (default 6)
#   LCA_PARTITION_START_YEAR (def 2010)  DRAIN_MAX_HOURS (default 60)
#   SELF_TERMINATE (default true)
set -euo pipefail
cd /opt/lca

export DATABASE_URL="postgresql://lca_user:lca_pass@localhost:5432/lca_db"
export REDIS_URL="redis://localhost:6379"
export NLP_WORKER_CONCURRENCY="${NLP_WORKER_CONCURRENCY:-6}"
PGSNAP_KEY="${PGSNAP_KEY:-latest.pgdump}"

echo "[nlp-processor] $(date -u +%FT%TZ) start (release=$RELEASE concurrency=$NLP_WORKER_CONCURRENCY)"

# 1. Restore the burst's snapshot (raw+ingested data, NLP partial/deferred).
aws s3 cp "s3://$PGSNAP_BUCKET/$PGSNAP_KEY" /tmp/restore.pgdump
docker compose up -d db redis
until docker compose exec -T db pg_isready -U lca_user; do sleep 2; done
# Tolerant: pg_restore exits non-zero if a matview REFRESH fails on a quirky source
# value (e.g. a pre-FLAG range wage "$69,400 - $80,000") — but the table DATA still
# restores fine ("errors ignored on restore"). nlp-finalize rebuilds the matviews from
# the (fixed) definitions, so a refresh error here is not fatal.
docker compose exec -T db pg_restore --no-owner --no-acl --clean --if-exists \
  -U lca_user -d lca_db < /tmp/restore.pgdump \
  || echo "WARN: pg_restore reported errors (matview refresh) — table data restored, continuing"

# 2. Ensure partitions exist for the full backfill range (floor 2010), so nothing the
#    restore brought in falls into the DEFAULT overflow partition. Idempotent.
LCA_PARTITION_START_YEAR="${LCA_PARTITION_START_YEAR:-2010}" \
  node apps/cli-tool/index.js db:init

# Rebuild-only mode (NLP_REPLICAS=0): skip workers/sweep/drain and go straight to
# the finalize/rebuild. Use this for analytics-only rebuilds (e.g. the year-view
# dashboard) that must NOT re-sweep an unclassified backlog — the FY2010-2019
# backfill has ~2.9M rows without a soc_code, and sweeping them would kick off a
# multi-day BERT drain instead of a ~quick rebuild. (Classify that backlog with a
# normal NLP_REPLICAS>=1 run when you actually want to fill the SOC gap.)
if [ "${NLP_REPLICAS:-1}" = "0" ]; then
  echo "[nlp-processor] NLP_REPLICAS=0 — rebuild-only: skipping workers/sweep/drain"
else

# 3. Workers — NLP only (data is already ingested; no harvester/ingestion-worker here),
#    scaled to NLP_REPLICAS processes. One worker is a single asyncio process whose
#    classify/resolve calls block the event loop (~70k/hr ceiling), so throughput scales
#    by running N replica PROCESSES, not by raising NLP_WORKER_CONCURRENCY. The workers
#    coordinate across replicas via a Postgres advisory lock.
docker compose up -d --scale nlp-worker="${NLP_REPLICAS:-1}" nlp-worker

# 4. Sweep: enqueue EVERY unclassified, non-quarantined row (guarantees 100%
#    coverage regardless of what ingest enqueued). Global (SWEEP_FILING_YEARS unset)
#    — the processor's job IS the full backlog. Shared with the quarterly burst.
bash /opt/lca/infra/aws/scripts/burst-sweep.sh

# 5. Drain barrier: wait until nlp-tasks is empty for two consecutive checks (write-back
#    is per-job, so a brief read of 0 between jobs is possible — confirm twice). Capped
#    at DRAIN_MAX_HOURS as a backstop. queue-depth.mjs must run from apps/harvester.
DRAIN_MAX_HOURS="${DRAIN_MAX_HOURS:-60}"
deadline=$(( $(date +%s) + DRAIN_MAX_HOURS * 3600 ))
empties=0
while :; do
  depth=$(cd apps/harvester && node queue-depth.mjs nlp-tasks 2>/dev/null | tr -dc '0-9')
  depth="${depth:-1}"
  if [ "$depth" -eq 0 ]; then empties=$((empties+1)); else empties=0; fi
  echo "[nlp-processor] $(date -u +%TZ) nlp-tasks depth=$depth empties=$empties"
  [ "$empties" -ge 2 ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[nlp-processor] WARN: hit DRAIN_MAX_HOURS=$DRAIN_MAX_HOURS with depth=$depth — finalizing anyway"
    break
  fi
  sleep 120
done

# 5b. Coverage check — warn-only on the backfill (a few un-processable rows over a
#     multi-million backlog are expected; this surfaces the count without aborting
#     the re-snapshot). The quarterly burst uses the same check in HARD-FAIL mode.
COVERAGE_WARN_ONLY=true COVERAGE_MAX_UNCLASSIFIED="${COVERAGE_MAX_UNCLASSIFIED:-5000}" \
  NOTIFY_TOPIC="$NOTIFY_TOPIC" REGION="$REGION" RELEASE="$RELEASE" \
  bash /opt/lca/infra/aws/scripts/assert-coverage.sh || true
fi  # end rebuild-only guard (NLP_REPLICAS=0 skips workers/sweep/drain)

# 6. Finalize-after-NLP: rebuild candidate + re-snapshot (the persist step) + notify.
NOTIFY_TOPIC="$NOTIFY_TOPIC" LLM_SECRET="$LLM_SECRET" LCADB_BUCKET="$LCADB_BUCKET" \
  ECR_REPO="$ECR_REPO" PGSNAP_BUCKET="$PGSNAP_BUCKET" \
  REGION="$REGION" RELEASE="$RELEASE" INSTANCE_ID="$INSTANCE_ID" \
  bash /opt/lca/infra/aws/scripts/nlp-finalize.sh

# 7. Self-terminate (job done). Guarded so a debug run can keep the box.
if [ "${SELF_TERMINATE:-true}" = "true" ]; then
  echo "[nlp-processor] self-terminating $INSTANCE_ID"
  aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID"
fi
