#!/bin/bash
#
# nlp-finalize.sh — the finalize-after-NLP tail for the decoupled NLP processor.
#
# Runs on the long-lived NLP-processor box AFTER it has drained nlp-tasks to empty
# (i.e. SOC + employer resolution are 100% written back to lca_records). It does the
# parts of the burst tail that depend on a fully-classified DB, then re-snapshots so
# the complete work PERSISTS (the burst's own snapshot was taken with NLP deferred /
# partial — promoting that would ship ~16%-classified data).
#
# It deliberately does NOT stand up the operator-ui / Caddy / DNS review env — that's
# the burst box's job. This box's only output is: a SOC-complete candidate lca.db, an
# updated dev preview, a fresh PG snapshot, and a "promotable" notification.
#
# Required env (passed by nlp-processor.sh):
#   REGION RELEASE INSTANCE_ID NOTIFY_TOPIC
#   LLM_SECRET LCADB_BUCKET ECR_REPO PGSNAP_BUCKET
#
# A non-zero exit propagates to the caller's ERR handling.
set -euo pipefail
cd /opt/lca

# Host-side build:sqlite reads PG via DATABASE_URL (db container publishes 5432).
export DATABASE_URL="postgresql://lca_user:lca_pass@localhost:5432/lca_db"
DEV_FUNCTION=lca-analytics-web
DEV_STACK=LcaServeStack

# Refresh analytics matviews via the db container's psql. Non-fatal.
# Bootstrap (DROP + CREATE), not just REFRESH: the restored snapshot carries the OLD
# matview definitions, so we recreate them from the current (fixed) analytics_views.sql
# — this both applies definition fixes (e.g. the range-wage parse) and repopulates from
# the now fully-classified data. No ON_ERROR_STOP so a single quirky view can't halt the
# rest; the fixed wage parse means it shouldn't error at all.
docker compose exec -T db psql -U lca_user -d lca_db \
  < apps/analytics-ui/db/analytics_views.sql || echo "WARN: bootstrap-views failed (continuing)"

# Rebuild the candidate lca.db (+ summaries) — now against the fully-classified DB.
mkdir -p apps/analytics-web/data
pnpm --filter analytics-web build:sqlite

# Seed entity_summary from the previous candidate so build:summaries only
# re-runs the LLM for entities whose data actually changed (build:sqlite always
# produces a fresh db, so without this every rebuild regenerates ALL summaries).
# Tolerant: first ever run / missing object → no seed → full regen.
SUMMARY_SEED_DB=""
if aws s3 cp "s3://$LCADB_BUCKET/candidates/last/lca.db" /tmp/prev-lca.db 2>/dev/null; then
  SUMMARY_SEED_DB=/tmp/prev-lca.db
  echo "nlp-finalize: seeding summaries from previous candidate (candidates/last/lca.db)"
else
  echo "nlp-finalize: no previous candidate to seed from — full summary regen"
fi
LLM_API_KEY=$(aws secretsmanager get-secret-value --secret-id "$LLM_SECRET" --query SecretString --output text) \
  LLM_PROVIDER=anthropic SUMMARY_SEED_DB="$SUMMARY_SEED_DB" \
  pnpm --filter analytics-web build:summaries

# Forward-year forecast page (/h1b-2026): deterministic projection + one LLM call.
LLM_API_KEY=$(aws secretsmanager get-secret-value --secret-id "$LLM_SECRET" --query SecretString --output text) \
  LLM_PROVIDER=anthropic pnpm --filter analytics-web build:forecast

# Upload the SOC-complete candidate (staging key; Promote writes the prod key).
aws s3 cp apps/analytics-web/data/lca.db "s3://$LCADB_BUCKET/candidates/$RELEASE/lca.db"
# Stable pointer to the newest candidate so the NEXT run can seed summaries.
aws s3 cp apps/analytics-web/data/lca.db "s3://$LCADB_BUCKET/candidates/last/lca.db"

# Build + push the arm64 Lambda image. Construct the ECR URI (role has push, not
# ecr:DescribeRepositories); --provenance/--sbom=false (Lambda rejects OCI attestations).
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_URI"
docker build --provenance=false --sbom=false -f apps/analytics-web/Dockerfile.lambda -t "$ECR_URI:latest" .
docker push "$ECR_URI:latest"

# Point the DEV serving Lambda at the SOC-complete image → dev.h1b.report preview.
aws lambda update-function-code --function-name "$DEV_FUNCTION" --image-uri "$ECR_URI:latest"
aws lambda wait function-updated --function-name "$DEV_FUNCTION" || true
DEV_DIST=$(aws cloudformation describe-stacks --stack-name "$DEV_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text 2>/dev/null || true)
if [ -n "$DEV_DIST" ] && [ "$DEV_DIST" != "None" ]; then
  aws cloudfront create-invalidation --distribution-id "$DEV_DIST" --paths '/*' || true
fi

# ***THE WHOLE POINT***: re-snapshot Postgres with the COMPLETE NLP write-back so the
# next restore / prod Promote uses fully-classified data (not the burst's partial one).
docker compose exec -T db pg_dump --format=custom -U lca_user -d lca_db > /tmp/latest.pgdump
aws s3 cp /tmp/latest.pgdump "s3://$PGSNAP_BUCKET/latest.pgdump"

# Notify: SOC-complete + promotable. (No review env on this box — promote from the
# operator UI on the next burst, or wire a direct promote.)
aws sns publish --region "$REGION" --topic-arn "$NOTIFY_TOPIC" \
  --subject "[LCA] SOC-complete — promotable ($RELEASE)" \
  --message "NLP fully drained for release $RELEASE. Candidate lca.db rebuilt with complete SOC +
employer resolution, dev.h1b.report preview updated, and the PG snapshot refreshed
(latest.pgdump now holds the fully-classified data).

Preview: https://dev.h1b.report
Promote: run the operator Promote flow (or the next burst) to ship to prod.

This NLP-processor box will now self-terminate."
echo "nlp-finalize: SOC-complete + promotable ($RELEASE)"
