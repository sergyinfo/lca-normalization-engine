#!/bin/bash
#
# burst-barrier.sh QUEUE [QUEUE...] — block until the named BullMQ queues drain
# (two consecutive empty checks guard against a momentary mid-batch lull).
#
# Extracted from the burst user-data (which is near EC2's 16 KB limit). Runs the
# queue-depth helper from apps/harvester, where its bullmq/ioredis deps resolve —
# running it from /tmp failed and the old `|| echo 1` then looped the barrier forever.
#
# Env: REDIS_URL (helper), plus SNS_TOPIC + REGION (+ RELEASE) for the loud-failure
# notify if the helper itself can't run.
set -uo pipefail

QUEUES="$*"
[ -n "$QUEUES" ] || { echo "usage: burst-barrier.sh <queue> [queue...]" >&2; exit 2; }

HELPER="/opt/lca/apps/harvester/queue-depth.mjs"
[ -f "$HELPER" ] || HELPER="$(cd "$(dirname "$0")/../../../apps/harvester" && pwd)/queue-depth.mjs"

# Sanity: the helper must actually run, else the loop below would never see 0.
if ! node "$HELPER" $QUEUES >/dev/null 2>&1; then
  if [ -n "${SNS_TOPIC:-}" ]; then
    aws sns publish --region "${REGION:-us-east-1}" --topic-arn "$SNS_TOPIC" \
      --subject "[LCA] burst barrier helper failed (${RELEASE:-?})" \
      --message "queue-depth.mjs could not run (dependency resolution?). Box stays up for debugging." || true
  fi
  exit 1
fi

EMPTY=0
while [ "$EMPTY" -lt 2 ]; do
  sleep 20
  DEPTH=$(node "$HELPER" $QUEUES 2>/dev/null || echo ERR)
  if [ "$DEPTH" = "0" ]; then EMPTY=$((EMPTY + 1)); else EMPTY=0; fi
done
echo "barrier drained ($QUEUES)"
