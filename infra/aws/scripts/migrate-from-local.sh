#!/usr/bin/env bash
# migrate-from-local.sh — bootstrap the AWS deployment with artefacts you
# already built locally, skipping the expensive ingest + entity-resolution
# steps that would otherwise run on the burst EC2.
#
# Prerequisites:
#   1. LcaSharedStack already deployed (run `pnpm deploy:shared` first)
#   2. Local Postgres running on localhost:5432 with the ingested data
#   3. apps/analytics-web/data/lca.db built locally (`pnpm build:sqlite`)
#   4. Docker buildx available
#   5. AWS_PROFILE / AWS_REGION configured
#
# What it does:
#   1. Looks up the bucket names + ECR URI from the deployed stack outputs
#   2. Uploads lca.db to the versioned S3 bucket
#   3. Builds + pushes the Next.js Lambda image to ECR (linux/arm64)
#   4. Dumps local Postgres and uploads the .pgdump file to S3
#
# After this, you can `pnpm deploy:serve` + `pnpm deploy:data` and the
# burst pipeline will incrementally update from your dump instead of
# bootstrapping from scratch.

set -euo pipefail

# ----- Sanity checks -------------------------------------------------------
if ! command -v aws >/dev/null; then
  echo "✗ aws CLI not on PATH" >&2; exit 1
fi
if ! command -v docker >/dev/null; then
  echo "✗ docker not on PATH" >&2; exit 1
fi
if ! command -v pg_dump >/dev/null; then
  echo "✗ pg_dump not on PATH (install postgresql client tools)" >&2; exit 1
fi

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION="${AWS_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"
echo "▶ Account: $ACCOUNT  Region: $REGION"

# ----- Resolve stack outputs ----------------------------------------------
echo "▶ Reading LcaSharedStack outputs"

get_resource() {
  aws cloudformation describe-stack-resource \
    --region "$REGION" \
    --stack-name LcaSharedStack \
    --logical-resource-id "$1" \
    --query 'StackResourceDetail.PhysicalResourceId' \
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
echo "▶ Step 1: lca.db → S3"
if [[ ! -f apps/analytics-web/data/lca.db ]]; then
  echo "  apps/analytics-web/data/lca.db is missing."
  echo "  Run \`pnpm --filter analytics-web build:sqlite\` first, then retry."
  exit 1
fi
SIZE=$(du -h apps/analytics-web/data/lca.db | cut -f1)
echo "  Local lca.db: $SIZE"
aws s3 cp apps/analytics-web/data/lca.db "s3://$LCA_BUCKET/lca.db" \
  --region "$REGION"
echo "  ✓ Uploaded"

# ----- 2. Lambda image ----------------------------------------------------
echo "▶ Step 2: Lambda Docker image → ECR"

# ECR login
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin \
  "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

# Buildx with cross-platform support. On Apple Silicon this is native;
# on x86 this transparently emulates arm64 (slower but works).
docker buildx create --use --name lca-builder >/dev/null 2>&1 || true

docker buildx build \
  --platform linux/arm64 \
  --file apps/analytics-web/Dockerfile.lambda \
  --tag "$ECR_URI:latest" \
  --tag "$ECR_URI:$(date +%Y%m%d-%H%M%S)" \
  --push \
  .
echo "  ✓ Pushed $ECR_URI:latest"

# ----- 3. Postgres dump ---------------------------------------------------
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

# ----- Summary ------------------------------------------------------------
echo
echo "✓ Migration complete (lca.db + Lambda image + PG dump uploaded). Next steps:"
echo "    1. pnpm deploy:serve     (provisions CloudFront + Lambda + static bucket, ~15 min)"
echo "                             pass domain context once the ACM cert is Issued, e.g.:"
echo "                               pnpm cdk deploy LcaServeStack \\"
echo "                                 -c siteCertificateArn=arn:aws:acm:us-east-1:…:certificate/… \\"
echo "                                 -c siteDomains=dev.h1b.report \\"
echo "                                 -c siteUrl=https://dev.h1b.report"
echo "    2. ./infra/aws/scripts/sync-static.sh   (REQUIRED — fills the static bucket"
echo "                             that CloudFront serves /_next/static/* + /static/* from;"
echo "                             without it all CSS/JS 404s. Re-run on every code deploy.)"
echo "    3. pnpm deploy:data      (provisions EventBridge, Step Fn, EC2 launch template)"
echo "    4. Wait 24h after activating cost-allocation tags, then:"
echo "       LCA_BILLING_EMAIL=you@example.com pnpm deploy:budgets"
echo
echo "  Verify serving:"
echo "    CF_DOMAIN=\$(aws cloudformation list-exports \\"
echo "      --query \"Exports[?Name=='LcaStaticAssetsBucket'].Value\" --output text >/dev/null; \\"
echo "      aws cloudfront list-distributions \\"
echo "      --query 'DistributionList.Items[?Comment==\`LCA analytics web — CloudFront distribution\`].DomainName' \\"
echo "      --output text)"
echo "    ./scripts/smoke-test.sh \"https://\$CF_DOMAIN\""
