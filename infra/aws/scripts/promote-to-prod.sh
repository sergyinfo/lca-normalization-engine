#!/usr/bin/env bash
# promote-to-prod.sh — promote the current dev build to production.
#
# The dev build flow (migrate-from-local.sh) pushes the image as ECR `:latest`
# and points the DEV Lambda (lca-analytics-web) at it, serving dev.h1b.report.
# When that build looks good on dev, this script promotes it to prod:
#
#   1. Server-side retag ECR `:latest` -> `:prod` (manifest copy — no pull/push).
#   2. Repoint the PROD Lambda (lca-analytics-web-prod) at the new `:prod` digest.
#
# It does NOT touch dev, DNS, or the prod CloudFront distribution. Run it after
# validating on dev.h1b.report; the prod site (h1b.report) updates immediately.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
PROD_FN="lca-analytics-web-prod"

if ! command -v aws >/dev/null; then echo "✗ aws CLI not on PATH" >&2; exit 1; fi

get_resource() {
  aws cloudformation describe-stack-resources --region "$REGION" --stack-name LcaSharedStack \
    --query "StackResources[?starts_with(LogicalResourceId, \`$1\`)].PhysicalResourceId | [0]" --output text
}

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO=$(get_resource LambdaImageRepo)
ECR_URI="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO"
echo "▶ Account $ACCOUNT  Region $REGION  Repo $ECR_REPO"

# 1. Retag :latest -> :prod (server-side; idempotent — ignores 'already exists').
echo "▶ Promoting ECR :latest → :prod"
MANIFEST=$(aws ecr batch-get-image --repository-name "$ECR_REPO" --region "$REGION" \
  --image-ids imageTag=latest --query 'images[0].imageManifest' --output text)
if [[ -z "$MANIFEST" || "$MANIFEST" == "None" ]]; then
  echo "✗ no :latest image in $ECR_REPO — run migrate-from-local.sh first" >&2; exit 1
fi
aws ecr put-image --repository-name "$ECR_REPO" --region "$REGION" \
  --image-tag prod --image-manifest "$MANIFEST" >/dev/null 2>&1 || true
echo "  ✓ :prod now resolves to the current :latest digest"

# 2. Repoint the prod Lambda (the :prod TAG is unchanged, so CFN won't; do it here).
if aws lambda get-function --function-name "$PROD_FN" --region "$REGION" >/dev/null 2>&1; then
  echo "▶ Repointing $PROD_FN at :prod"
  aws lambda update-function-code --function-name "$PROD_FN" \
    --image-uri "$ECR_URI:prod" --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$PROD_FN" --region "$REGION"
  echo "  ✓ $PROD_FN updated — prod is now serving the promoted build"
else
  echo "  ($PROD_FN not found — deploy LcaServeProdStack first)"
fi

# 3. Bust the prod edge cache. SSG pages are cached ~forever at CloudFront
#    (Next sends s-maxage=31536000), so a content deploy MUST invalidate or the
#    edge keeps serving the old build.
DIST=$(aws cloudformation describe-stacks --stack-name LcaServeProdStack --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text 2>/dev/null)
if [[ -n "$DIST" && "$DIST" != "None" ]]; then
  echo "▶ Invalidating prod edge cache ($DIST)"
  aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*' \
    --region "$REGION" --query 'Invalidation.Id' --output text >/dev/null
  echo "  ✓ invalidation submitted (propagates in ~1-2 min)"
else
  echo "  (LcaServeProdStack DistributionId output not found — skipping invalidation)"
fi
