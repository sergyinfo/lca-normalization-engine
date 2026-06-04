#!/usr/bin/env bash
# dev-up.sh — (re)deploy the DEV serving stack and re-point dev.h1b.report.
#
# Recreating LcaServeStack gives the CloudFront distribution a NEW domain, so
# this script also upserts the Cloudflare CNAME dev.h1b.report → <new dist>.
#
# Required context (same as the normal serve deploy):
#   SITE_CERT_ARN   ACM cert ARN (us-east-1) covering *.h1b.report
#                   (falls back to cdk.context.json `siteCertificateArn`)
#   infra/aws/.origin-verify-secret must exist (origin-verify shared secret)
# Cloudflare DNS update uses the lca/cloudflare-token secret.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SELF_DIR/.."   # infra/aws
REGION="${AWS_REGION:-us-east-1}"

CERT_ARN="${SITE_CERT_ARN:-$(node -e "try{process.stdout.write(require('./cdk.context.json').siteCertificateArn||'')}catch{}" 2>/dev/null || true)}"
if [[ -z "$CERT_ARN" ]]; then
  echo "✗ Set SITE_CERT_ARN (or add siteCertificateArn to cdk.context.json)." >&2; exit 1
fi
if [[ ! -f .origin-verify-secret ]]; then
  echo "✗ infra/aws/.origin-verify-secret missing." >&2; exit 1
fi

echo "▶ Deploying LcaServeStack (dev)…"
pnpm cdk deploy LcaServeStack --require-approval never \
  -c siteCertificateArn="$CERT_ARN" \
  -c siteDomains=dev.h1b.report \
  -c siteUrl=https://dev.h1b.report \
  -c originVerifySecret="$(cat .origin-verify-secret)"

# Pull the freshest server lca.db + push the image so the box serves real data.
AWS_REGION="$REGION" SKIP_PG_DUMP=1 "$SELF_DIR/migrate-from-local.sh"

DIST_DOMAIN=$(aws cloudformation describe-stacks --region "$REGION" --stack-name LcaServeStack \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text)

echo "▶ Re-pointing dev.h1b.report → $DIST_DOMAIN (Cloudflare)…"
CF_TOKEN=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id lca/cloudflare-token --query SecretString --output text)
ZONE_ID=$(curl -sf -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=h1b.report" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"][0]["id"])')
REC_ID=$(curl -sf -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?type=CNAME&name=dev.h1b.report" \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];print(r[0]["id"] if r else "")')
BODY="{\"type\":\"CNAME\",\"name\":\"dev.h1b.report\",\"content\":\"$DIST_DOMAIN\",\"ttl\":120,\"proxied\":false}"
if [ -n "$REC_ID" ]; then
  curl -sf -X PUT -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$REC_ID" -d "$BODY" >/dev/null
else
  curl -sf -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" -d "$BODY" >/dev/null
fi
unset CF_TOKEN
echo "✓ Dev is back at https://dev.h1b.report"
