#!/usr/bin/env bash
# ec2-rebuild-preview.sh — runs ON the burst review box (via SSM RunCommand),
# invoked by the RebuildPreviewPipeline when the operator clicks "Rebuild
# preview". Re-derives lca.db from the (edited) Postgres and refreshes ONLY the
# dev preview (dev.h1b.report). Prod is untouched — that's what Promote is for.
set -euxo pipefail

REGION="${AWS_REGION:-$(curl -sf http://169.254.169.254/latest/meta-data/placement/region)}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

stack_resource() {
  aws cloudformation describe-stack-resources --region "$REGION" --stack-name "$1" \
    --query "StackResources[?starts_with(LogicalResourceId, \`$2\`)].PhysicalResourceId | [0]" --output text
}
stack_output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null || true
}
TOPIC_ARN=$(stack_resource LcaDataPipelineStack BuildNotifications)
DEV_DIST=$(stack_output LcaServeStack DistributionId)
ECR_URI=$(aws ecr describe-repositories --region "$REGION" \
  --repository-names lca-analytics-web --query 'repositories[0].repositoryUri' --output text)
notify() { [ -n "${TOPIC_ARN:-}" ] && [ "$TOPIC_ARN" != "None" ] && \
  aws sns publish --region "$REGION" --topic-arn "$TOPIC_ARN" --subject "$1" --message "$2" || true; }
trap 'notify "[LCA] preview rebuild FAILED" "ec2-rebuild-preview.sh failed. Check /lca/burst logs."' ERR

export DATABASE_URL="postgresql://lca_user:lca_pass@localhost:5432/lca_db"
pnpm --filter @lca/cli analytics:refresh-views
pnpm --filter analytics-web build:sqlite
LLM_API_KEY=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id lca/llm-api-key --query SecretString --output text) \
LLM_PROVIDER=anthropic \
  pnpm --filter analytics-web build:summaries

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_URI"
docker build -f apps/analytics-web/Dockerfile.lambda -t "$ECR_URI:latest" .
docker push "$ECR_URI:latest"
aws lambda update-function-code --region "$REGION" \
  --function-name lca-analytics-web --image-uri "$ECR_URI:latest" >/dev/null
aws lambda wait function-updated --region "$REGION" --function-name lca-analytics-web || true
if [ -n "${DEV_DIST:-}" ] && [ "$DEV_DIST" != "None" ]; then
  aws cloudfront create-invalidation --distribution-id "$DEV_DIST" --paths '/*' \
    --region "$REGION" --query 'Invalidation.Id' --output text >/dev/null
fi
notify "[LCA] preview rebuilt" "dev.h1b.report now reflects your latest edits. Review again, then Promote."
