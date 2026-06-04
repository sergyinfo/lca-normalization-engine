#!/usr/bin/env bash
# migrate-from-local.sh — bootstrap the AWS deployment with artefacts you
# already built locally, skipping the expensive ingest + entity-resolution
# steps that would otherwise run on the burst EC2.
#
# Prerequisites:
#   1. LcaSharedStack already deployed (run `pnpm deploy:shared` first)
#   2. Local Postgres running on localhost:5432 (only for the optional PG dump;
#      set SKIP_PG_DUMP=1 for a P2-only serve deploy)
#   3. apps/analytics-web/data/lca.db built locally — ONLY needed with
#      --push-local-db (first deploy / deliberate local refresh). By default the
#      script pulls the server lca.db from S3, so no local build is required.
#   4. Docker buildx available
#   5. AWS_PROFILE / AWS_REGION configured
#
# What it does:
#   1. Looks up the bucket names + ECR URI from the deployed stack outputs
#   2. Pulls lca.db from S3 (the server copy) — or, with --push-local-db,
#      publishes the local lca.db to S3 instead
#   3. Builds + pushes the Next.js Lambda image to ECR (linux/arm64)
#   4. Dumps local Postgres and uploads the .pgdump file to S3 (optional)
#
# After this, you can `pnpm deploy:serve` + `pnpm deploy:data` and the
# burst pipeline will incrementally update from your dump instead of
# bootstrapping from scratch.

set -euo pipefail

# ----- Args ----------------------------------------------------------------
# --promote        : after building + updating dev, also promote to production
#                    (promote-to-prod.sh) — one command: build → dev → prod.
# --push-local-db  : publish the LOCAL lca.db to S3 and build from it. WITHOUT it
#                    the script PULLS lca.db from S3 (the server copy — freshest,
#                    e.g. from the harvester) and never overwrites it, so a stale
#                    local DB can't clobber server data.
PROMOTE=; PUSH_LOCAL_DB=
for arg in "$@"; do case "$arg" in
  --promote)       PROMOTE=1 ;;
  --push-local-db) PUSH_LOCAL_DB=1 ;;
esac; done
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

# ----- Sanity checks -------------------------------------------------------
if ! command -v aws >/dev/null; then
  echo "✗ aws CLI not on PATH" >&2; exit 1
fi
if ! command -v docker >/dev/null; then
  echo "✗ docker not on PATH" >&2; exit 1
fi
# pg_dump is only needed for the optional Postgres-snapshot step (P1). For a
# P2-only serve deploy, set SKIP_PG_DUMP=1 to skip it (the public site runs off
# lca.db and never needs cloud Postgres).
if [[ -z "${SKIP_PG_DUMP:-}" ]] && ! command -v pg_dump >/dev/null; then
  echo "✗ pg_dump not on PATH (install postgresql client tools), or set SKIP_PG_DUMP=1 to skip the Postgres snapshot" >&2; exit 1
fi

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION="${AWS_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"
echo "▶ Account: $ACCOUNT  Region: $REGION"

# ----- Resolve stack outputs ----------------------------------------------
echo "▶ Reading LcaSharedStack outputs"

get_resource() {
  # CDK suffixes logical IDs with a hash (e.g. LcaDbBucket993DDCC0), so match
  # on a logical-ID prefix rather than an exact id.
  aws cloudformation describe-stack-resources \
    --region "$REGION" \
    --stack-name LcaSharedStack \
    --query "StackResources[?starts_with(LogicalResourceId, \`$1\`)].PhysicalResourceId | [0]" \
    --output text
}

LCA_BUCKET=$(get_resource LcaDbBucket)
PG_BUCKET=$(get_resource PgSnapshotBucket)
ECR_REPO=$(get_resource LambdaImageRepo)
ECR_URI="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO"

echo "  lca.db bucket  : $LCA_BUCKET"
echo "  PG dump bucket : $PG_BUCKET"
echo "  ECR repo       : $ECR_URI"

# Move to monorepo root for the rest of the script
cd "$(dirname "$0")/../../.."

# ----- 1. lca.db ----------------------------------------------------------
# Default: build the image from the SERVER lca.db (pull from S3). The harvester
# writes the freshest copy there, so a stale local DB must NEVER clobber it.
# --push-local-db flips this to publish your locally-rebuilt DB (first-deploy
# seeding, or a deliberate local refresh).
mkdir -p apps/analytics-web/data
if [[ -n "$PUSH_LOCAL_DB" ]]; then
  echo "▶ Step 1: PUBLISH local lca.db → S3 (--push-local-db)"
  if [[ ! -f apps/analytics-web/data/lca.db ]]; then
    echo "  ✗ apps/analytics-web/data/lca.db missing — run \`pnpm --filter analytics-web build:data\` first." >&2
    exit 1
  fi
  echo "  Local lca.db: $(du -h apps/analytics-web/data/lca.db | cut -f1) → s3://$LCA_BUCKET/lca.db"
  aws s3 cp apps/analytics-web/data/lca.db "s3://$LCA_BUCKET/lca.db" --region "$REGION"
  echo "  ✓ Published — the server DB is now your local DB"
else
  echo "▶ Step 1: use the SERVER lca.db (pull from S3 — freshest, e.g. from the harvester)"
  if ! aws s3 cp "s3://$LCA_BUCKET/lca.db" apps/analytics-web/data/lca.db --region "$REGION" 2>/dev/null; then
    echo "  ✗ No lca.db in s3://$LCA_BUCKET/ yet. First deploy? Build it locally" >&2
    echo "    (pnpm --filter analytics-web build:data) and re-run with --push-local-db to seed S3." >&2
    exit 1
  fi
  echo "  ✓ Pulled server lca.db ($(du -h apps/analytics-web/data/lca.db | cut -f1)) — the image bakes this; S3 left untouched"
fi

# ----- 2. Lambda image ----------------------------------------------------
echo "▶ Step 2: Lambda Docker image → ECR"

# ECR login
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin \
  "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

# Buildx with cross-platform support. On Apple Silicon this is native;
# on x86 this transparently emulates arm64 (slower but works).
docker buildx create --use --name lca-builder >/dev/null 2>&1 || true

# --provenance=false / --sbom=false are REQUIRED: without them buildx pushes an
# OCI image index with an attestation manifest, which AWS Lambda rejects with
# "image manifest ... media type ... is not supported". A single-platform build
# with attestations off pushes a plain Docker schema-2 manifest that Lambda accepts.
docker buildx build \
  --platform linux/arm64 \
  --provenance=false \
  --sbom=false \
  --file apps/analytics-web/Dockerfile.lambda \
  --tag "$ECR_URI:latest" \
  --tag "$ECR_URI:$(date +%Y%m%d-%H%M%S)" \
  --push \
  .
echo "  ✓ Pushed $ECR_URI:latest"

# Repoint the serving Lambda at the freshly-pushed image. CloudFormation won't
# do this itself: the function references the image by the :latest TAG, and the
# tag string is unchanged even though it now resolves to a new digest — so a
# `cdk deploy` is a no-op for the image. update-function-code resolves :latest
# to the current digest and updates the function. Skipped gracefully on the very
# first run (before deploy:serve has created the function).
if aws lambda get-function --function-name lca-analytics-web --region "$REGION" >/dev/null 2>&1; then
  echo "  Repointing lca-analytics-web Lambda at the new image..."
  aws lambda update-function-code --function-name lca-analytics-web \
    --image-uri "$ECR_URI:latest" --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name lca-analytics-web --region "$REGION"
  echo "  ✓ Lambda updated"
  # Bust the DEV edge cache — SSG pages are cached ~forever at CloudFront, so a
  # new build must invalidate or the edge keeps serving the old one.
  DEV_DIST=$(aws cloudformation describe-stacks --stack-name LcaServeStack --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text 2>/dev/null)
  if [[ -n "$DEV_DIST" && "$DEV_DIST" != "None" ]]; then
    aws cloudfront create-invalidation --distribution-id "$DEV_DIST" --paths '/*' \
      --region "$REGION" --query 'Invalidation.Id' --output text >/dev/null && echo "  ✓ dev edge cache invalidated"
  fi
else
  echo "  (lca-analytics-web Lambda not found yet — deploy:serve will create it)"
fi

# ----- 3. Postgres dump (optional — skip for a P2-only serve deploy) -------
if [[ -n "${SKIP_PG_DUMP:-}" ]]; then
  echo "▶ Step 3: Postgres dump SKIPPED (SKIP_PG_DUMP set)."
  echo "  The public site serves from lca.db and needs no cloud Postgres."
  echo "  Re-run without SKIP_PG_DUMP before enabling the P1 burst pipeline."
else
echo "▶ Step 3: local Postgres → S3"
DUMP_PATH=/tmp/lca-$(date +%Y%m%d).pgdump

# Default connection params — override via PG_* env vars.
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-lca_user}"
PG_DB="${PG_DB:-lca_db}"

echo "  Dumping $PG_DB @ $PG_HOST:$PG_PORT as $PG_USER ..."
PGPASSWORD="${PG_PASSWORD:-lca_pass}" pg_dump \
  --format=custom --compress=9 --no-owner --no-acl \
  -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" \
  -f "$DUMP_PATH"

DUMP_SIZE=$(du -h "$DUMP_PATH" | cut -f1)
echo "  Dump size: $DUMP_SIZE"
echo "  Uploading to s3://$PG_BUCKET/latest.pgdump (this may take a while)"
aws s3 cp "$DUMP_PATH" "s3://$PG_BUCKET/latest.pgdump" --region "$REGION"

# Keep a dated copy too — handy for rollback
DATED_KEY="archives/$(date +%Y-%m-%d).pgdump"
aws s3 cp "$DUMP_PATH" "s3://$PG_BUCKET/$DATED_KEY" --region "$REGION"
rm "$DUMP_PATH"

echo "  ✓ Uploaded to s3://$PG_BUCKET/latest.pgdump + $DATED_KEY"
fi

# ----- Summary ------------------------------------------------------------
echo
echo "✓ Migration complete (lca.db + Lambda image uploaded; Lambda repointed). Next steps:"
echo "    1. Deploy serving with the domain/hardening context (see infra/aws/README.md §Serving model):"
echo "         pnpm cdk deploy LcaServeStack --require-approval never \\"
echo "           -c siteCertificateArn=arn:aws:acm:us-east-1:…:certificate/… \\"
echo "           -c siteDomains=dev.h1b.report -c siteUrl=https://dev.h1b.report \\"
echo "           -c originVerifySecret=\$(cat infra/aws/.origin-verify-secret)"
echo "       (static assets are served by the Lambda image — no separate sync step.)"
echo "    2. pnpm deploy:data      (provisions EventBridge, Step Fn, EC2 launch template)"
echo "    3. Wait 24h after activating cost-allocation tags, then:"
echo "       LCA_BILLING_EMAIL=you@example.com pnpm deploy:budgets"
echo
echo "  Verify serving:"
echo "    CF_DOMAIN=\$(aws cloudformation describe-stacks --stack-name LcaServeStack \\"
echo "      --query \"Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue\" --output text)"
echo "    ./scripts/smoke-test.sh \"https://\$CF_DOMAIN\""

# ----- Optional: ship straight to production -------------------------------
if [[ -n "$PROMOTE" ]]; then
  echo
  echo "▶ --promote: shipping this build to production (h1b.report)"
  "$SELF_DIR/promote-to-prod.sh"
fi
