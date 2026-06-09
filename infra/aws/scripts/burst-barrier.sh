#!/bin/bash
#
# burst-barrier.sh QUEUE [QUEUE...] — block until the named BullMQ queues drain
# (two consecutive empty checks guard against a momentary mid-batch lull).
#
# Hardened 2026-06 after a burst hung ~2h: the reliable-queue (brpoplpush to an
# `:active` processing list) leaves a job stuck in `bull:<q>:active` if the worker
# dies or Redis blips at the post-process `lrem` — the barrier then waits forever.
# This version SELF-HEALS (requeues stuck `:active` jobs back to `:wait` so a
# healthy worker reprocesses them — idempotent) and FAILS FAST with an SNS alert
# instead of hanging to the 36h watchdog.
#
# Extracted from the burst user-data (near EC2's 16 KB limit). Runs the queue-depth
# helper from apps/harvester, where its bullmq/ioredis deps resolve.
#
# Env: REDIS_URL (helper), SNS_TOPIC + REGION (+ RELEASE) for the loud-failure
# notify. Tunables: BARRIER_MAX_WAIT (default 2400s), BARRIER_STALL_AFTER (180s).
set -uo pipefail

QUEUES="$*"
[ -n "$QUEUES" ] || { echo "usage: burst-barrier.sh <queue> [queue...]" >&2; exit 2; }

HELPER="/opt/lca/apps/harvester/queue-depth.mjs"
[ -f "$HELPER" ] || HELPER="$(cd "$(dirname "$0")/../../../apps/harvester" && pwd)/queue-depth.mjs"

MAX_WAIT="${BARRIER_MAX_WAIT:-2400}"       # hard ceiling (s) -> SNS + exit 1
STALL_AFTER="${BARRIER_STALL_AFTER:-180}"  # no-progress (s) before reclaiming orphans
POLL=20

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
notify_fail() {  # message, subject-suffix
  echo "[$(ts)] barrier FAIL: $1" >&2
  if [ -n "${SNS_TOPIC:-}" ]; then
    aws sns publish --region "${REGION:-us-east-1}" --topic-arn "$SNS_TOPIC" \
      --subject "[LCA] burst barrier: $2 (${RELEASE:-?})" --message "$1" || true
  fi
}

# Reclaim orphaned in-flight jobs: move every `:active` entry back to `:wait` so a
# healthy worker reprocesses it. Reprocessing is idempotent (re-writes the same
# soc_code), so a falsely-reclaimed job costs nothing. This is exactly the manual
# `rpoplpush` that unblocked the 2026-06-09 hang — automated.
reclaim() {
  cd /opt/lca 2>/dev/null || return 0
  local q n
  for q in $QUEUES; do
    n=$(docker compose exec -T redis redis-cli llen "bull:$q:active" 2>/dev/null | tr -dc '0-9')
    [ -n "$n" ] && [ "$n" -gt 0 ] || continue
    echo "[$(ts)] reclaim: $n stuck 'active' job(s) on '$q' -> requeue to wait"
    while [ "$n" -gt 0 ]; do
      docker compose exec -T redis redis-cli rpoplpush "bull:$q:active" "bull:$q:wait" >/dev/null 2>&1 || break
      n=$((n - 1))
    done
  done
}

# Sanity: the helper must actually run, else the loop below would never see 0.
if ! node "$HELPER" $QUEUES >/dev/null 2>&1; then
  notify_fail "queue-depth.mjs could not run (dependency resolution?). Box stays up for debugging." "helper failed"
  exit 1
fi

EMPTY=0; ELAPSED=0; STALL=0; LAST="-1"
while [ "$EMPTY" -lt 2 ]; do
  sleep "$POLL"; ELAPSED=$((ELAPSED + POLL))
  DEPTH=$(node "$HELPER" $QUEUES 2>/dev/null || echo ERR)
  if [ "$DEPTH" = "0" ]; then
    EMPTY=$((EMPTY + 1)); STALL=0
  else
    EMPTY=0
    if [ "$DEPTH" = "$LAST" ]; then STALL=$((STALL + POLL)); else STALL=0; fi
    if [ "$STALL" -ge "$STALL_AFTER" ]; then
      echo "[$(ts)] no progress for ${STALL}s (depth=$DEPTH) — reclaiming orphaned active jobs"
      reclaim; STALL=0
    fi
  fi
  LAST="$DEPTH"
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    notify_fail "Queue '$QUEUES' did not drain in ${MAX_WAIT}s (last depth=$DEPTH). Box left up for debugging." "timed out"
    exit 1
  fi
done
echo "barrier drained ($QUEUES)"
