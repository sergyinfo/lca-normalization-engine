#!/usr/bin/env bash
# ec2-promote.sh — runs ON the burst review box (via SSM RunCommand), invoked
# by the PromotePipeline Step Function when the operator clicks "Promote".
#
# The operator's edits land in the local Postgres, so the candidate lca.db built
# at review-start is now stale. This script RE-DERIVES lca.db from the corrected
# Postgres and ships it to prod:
#   1. refresh analytics mat-views (pick up operator edits)
#   2. build:sqlite + build:summaries → fresh apps/analytics-web/data/lca.db
#   3. upload to the PROD key  s3://<lcaDbBucket>/lca.db
#   4. build+push the :prod image, update lca-analytics-web-prod, invalidate prod CF
#   5. snapshot Postgres back to S3
#   6. SNS "promoted to prod"
#
# Assumes: cwd is the repo root (/opt/lca), the compose Postgres (`db`) is still
# up from the build run, node/pnpm/docker are installed, and the instance role
# grants the needed S3/ECR/Lambda/CloudFront/SNS perms.
set -euxo pipefail

# IMDSv2 (HttpTokens=required on the burst launch template).
_imt=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 600" || true)
imds() { curl -sf -H "X-aws-ec2-metadata-token: $_imt" "http://169.254.169.254/latest/meta-data/$1"; }
REGION="${AWS_REGION:-$(imds placement/region)}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

stack_resource() { # stack, logical-id prefix
  aws cloudformation describe-stack-resources --region "$REGION" --stack-name "$1" \
    --query "StackResources[?starts_with(LogicalResourceId, \`$2\`)].PhysicalResourceId | [0]" \
    --output text
}
stack_output() { # stack, output key
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null || true
}

LCA_BUCKET=$(stack_resource LcaSharedStack LcaDbBucket)
PG_BUCKET=$(stack_resource LcaSharedStack PgSnapshotBucket)
TOPIC_ARN=$(stack_resource LcaDataPipelineStack BuildNotifications)
PROD_DIST=$(stack_output LcaServeProdStack DistributionId)
ECR_URI=$(aws ecr describe-repositories --region "$REGION" \
  --repository-names lca-analytics-web --query 'repositories[0].repositoryUri' --output text)

notify() { # subject, message
  [ -n "${TOPIC_ARN:-}" ] && [ "$TOPIC_ARN" != "None" ] && \
    aws sns publish --region "$REGION" --topic-arn "$TOPIC_ARN" --subject "$1" --message "$2" || true
}
trap 'notify "[LCA] promote FAILED" "ec2-promote.sh failed on $(hostname). Check /lca/burst logs."' ERR

# 1+2. Refresh views + rebuild lca.db from the corrected Postgres.
export DATABASE_URL="postgresql://lca_user:lca_pass@localhost:5432/lca_db"
pnpm --filter @lca/cli analytics:refresh-views
pnpm --filter analytics-web build:sqlite
# Seed entity_summary from the last candidate so build:summaries only re-runs the
# LLM for entities whose data actually changed (build:sqlite makes a fresh db, so
# without this every promote regenerates ALL summaries). Tolerant of a missing prior.
SUMMARY_SEED_DB=""
if aws s3 cp "s3://$LCA_BUCKET/candidates/last/lca.db" /tmp/prev-lca.db --region "$REGION" 2>/dev/null; then
  SUMMARY_SEED_DB=/tmp/prev-lca.db
fi
LLM_API_KEY=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id lca/llm-api-key --query SecretString --output text) \
LLM_PROVIDER=anthropic SUMMARY_SEED_DB="$SUMMARY_SEED_DB" \
  pnpm --filter analytics-web build:summaries

# 3. Upload to the PROD key (this is the only place the prod lca.db is written).
aws s3 cp apps/analytics-web/data/lca.db "s3://$LCA_BUCKET/lca.db" --region "$REGION"

# 4. Build + push the :prod image (native arm64), update prod Lambda, invalidate.
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_URI"
docker build -f apps/analytics-web/Dockerfile.lambda -t "$ECR_URI:prod" .
docker push "$ECR_URI:prod"
aws lambda update-function-code --region "$REGION" \
  --function-name lca-analytics-web-prod --image-uri "$ECR_URI:prod" >/dev/null
aws lambda wait function-updated --region "$REGION" --function-name lca-analytics-web-prod || true
if [ -n "${PROD_DIST:-}" ] && [ "$PROD_DIST" != "None" ]; then
  aws cloudfront create-invalidation --distribution-id "$PROD_DIST" --paths '/*' \
    --region "$REGION" --query 'Invalidation.Id' --output text >/dev/null
fi

# 5. Snapshot the corrected Postgres back to S3 for the next run.
docker compose exec -T db pg_dump --format=custom -U lca_user -d lca_db > /tmp/latest.pgdump
aws s3 cp /tmp/latest.pgdump "s3://$PG_BUCKET/latest.pgdump" --region "$REGION"

# 6. Done.
notify "[LCA] promoted to prod" "The reviewed data is live on https://h1b.report (prod Lambda repointed, edge cache invalidated). You can now Shut down the review box."
