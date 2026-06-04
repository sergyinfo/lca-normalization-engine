#!/usr/bin/env bash
# ec2-teardown.sh — runs ON the burst review box (via SSM RunCommand), invoked
# by the TeardownPipeline Step Function when the operator clicks "Shut down".
#
#   1. delete the operator.h1b.report Cloudflare A-record (so it stops resolving)
#   2. stop Caddy
#   3. SNS "review box torn down"
#   4. self-terminate (the instance role allows ec2:TerminateInstances on
#      BurstWorker=true instances)
set -euxo pipefail

REGION="${AWS_REGION:-$(curl -sf http://169.254.169.254/latest/meta-data/placement/region)}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
INSTANCE_ID=$(curl -sf http://169.254.169.254/latest/meta-data/instance-id)

TOPIC_ARN=$(aws cloudformation describe-stack-resources --region "$REGION" \
  --stack-name LcaDataPipelineStack \
  --query "StackResources[?starts_with(LogicalResourceId, \`BuildNotifications\`)].PhysicalResourceId | [0]" \
  --output text 2>/dev/null || true)
notify() {
  [ -n "${TOPIC_ARN:-}" ] && [ "$TOPIC_ARN" != "None" ] && \
    aws sns publish --region "$REGION" --topic-arn "$TOPIC_ARN" --subject "$1" --message "$2" || true
}

# 1. Remove the operator.h1b.report A-record.
CF_TOKEN=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id lca/cloudflare-token --query SecretString --output text 2>/dev/null || true)
if [ -n "${CF_TOKEN:-}" ]; then
  ZONE_ID=$(curl -sf -H "Authorization: Bearer $CF_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones?name=h1b.report" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"][0]["id"])' || true)
  REC_ID=$(curl -sf -H "Authorization: Bearer $CF_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?type=A&name=operator.h1b.report" \
    | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];print(r[0]["id"] if r else "")' || true)
  if [ -n "${REC_ID:-}" ]; then
    curl -sf -X DELETE -H "Authorization: Bearer $CF_TOKEN" \
      "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$REC_ID" || true
  fi
  unset CF_TOKEN
fi

# 2. Stop Caddy (best-effort).
/usr/local/bin/caddy stop 2>/dev/null || true

# 3. Notify, then 4. self-terminate.
notify "[LCA] review box torn down" "operator.h1b.report removed; instance $INSTANCE_ID terminating. No EC2 cost until the next release."
aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID"
