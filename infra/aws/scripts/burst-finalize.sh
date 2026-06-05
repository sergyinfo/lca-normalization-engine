#!/bin/bash
#
# burst-finalize.sh — the candidate-build + operator-review tail of the burst,
# extracted from the EC2 user-data (which is capped at 16 KB). Runs after the
# ingest/NLP barrier: refresh matviews → build candidate lca.db + summaries →
# preview on dev.h1b.report → snapshot PG → operator-ui at operator.h1b.report
# (Caddy + Cloudflare DNS-01) → SNS "ready for review".
#
# Required env (the user-data passes these CDK-resolved values):
#   REGION RELEASE INSTANCE_ID SUMMARY_JSON
#   NOTIFY_TOPIC LLM_SECRET LCADB_BUCKET ECR_REPO PGSNAP_BUCKET
#   OPERATOR_PW_SECRET SESSION_SECRET_ID CF_TOKEN_SECRET
#
# A non-zero exit propagates to the user-data's ERR trap (failure SNS + box stays up).
set -euo pipefail
cd /opt/lca

DEV_FUNCTION=lca-analytics-web
DEV_STACK=LcaServeStack

# Refresh analytics matviews via the db container's psql (host has none). Non-fatal —
# a stale matview shouldn't block the review env; a later Rebuild-preview refreshes.
docker compose exec -T db psql -U lca_user -d lca_db -v ON_ERROR_STOP=1 \
  < apps/analytics-ui/db/refresh_views.sql || echo "WARN: refresh-views failed (continuing)"

# Build the candidate lca.db (+ summaries). data/ is gitignored → create it first,
# else SQLite can't open the new file.
mkdir -p apps/analytics-web/data
pnpm --filter analytics-web build:sqlite
LLM_API_KEY=$(aws secretsmanager get-secret-value --secret-id "$LLM_SECRET" --query SecretString --output text) \
  LLM_PROVIDER=anthropic pnpm --filter analytics-web build:summaries

# Upload the CANDIDATE lca.db (staging key, never the prod key — Promote writes that).
aws s3 cp apps/analytics-web/data/lca.db "s3://$LCADB_BUCKET/candidates/$RELEASE/lca.db"

# Build + push the arm64 Lambda image (--provenance/--sbom=false: Lambda rejects OCI attestations).
ECR_URI=$(aws ecr describe-repositories --repository-names "$ECR_REPO" --query 'repositories[0].repositoryUri' --output text)
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_URI"
docker build --provenance=false --sbom=false -f apps/analytics-web/Dockerfile.lambda -t "$ECR_URI:latest" .
docker push "$ECR_URI:latest"

# Point the DEV serving Lambda at the candidate image → dev.h1b.report preview (prod untouched).
aws lambda update-function-code --function-name "$DEV_FUNCTION" --image-uri "$ECR_URI:latest"
aws lambda wait function-updated --function-name "$DEV_FUNCTION" || true
DEV_DIST=$(aws cloudformation describe-stacks --stack-name "$DEV_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text 2>/dev/null || true)
if [ -n "$DEV_DIST" ] && [ "$DEV_DIST" != "None" ]; then
  aws cloudfront create-invalidation --distribution-id "$DEV_DIST" --paths '/*' || true
fi

# Snapshot Postgres back to S3 (so the next run restores fast).
docker compose exec -T db pg_dump --format=custom -U lca_user -d lca_db > /tmp/latest.pgdump
aws s3 cp /tmp/latest.pgdump "s3://$PGSNAP_BUCKET/latest.pgdump"

# ----- Operator review UI against the local Postgres -----
export OPERATOR_PASSWORD=$(aws secretsmanager get-secret-value --secret-id "$OPERATOR_PW_SECRET" --query SecretString --output text)
export SESSION_SECRET=$(aws secretsmanager get-secret-value --secret-id "$SESSION_SECRET_ID" --query SecretString --output text)
export INSTANCE_ID AWS_REGION="$REGION" RELEASE
docker compose up -d operator-ui
unset OPERATOR_PASSWORD SESSION_SECRET

# ----- TLS + DNS for operator.h1b.report (Caddy + Cloudflare DNS-01) -----
CF_TOKEN=$(aws secretsmanager get-secret-value --secret-id "$CF_TOKEN_SECRET" --query SecretString --output text)
IMDS_TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
PUBLIC_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=arm64&p=github.com/caddy-dns/cloudflare" \
  -o /usr/local/bin/caddy && chmod +x /usr/local/bin/caddy
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<'CADDY'
operator.h1b.report {
  reverse_proxy localhost:8080
  tls {
    dns cloudflare {env.CLOUDFLARE_API_TOKEN}
  }
}
CADDY
CLOUDFLARE_API_TOKEN=$CF_TOKEN /usr/local/bin/caddy start --config /etc/caddy/Caddyfile --adapter caddyfile

# Upsert the operator.h1b.report A-record → this instance's public IP.
ZONE_ID=$(curl -sf -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=h1b.report" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"][0]["id"])')
REC_ID=$(curl -sf -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?type=A&name=operator.h1b.report" \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];print(r[0]["id"] if r else "")')
REC_BODY="{\"type\":\"A\",\"name\":\"operator.h1b.report\",\"content\":\"$PUBLIC_IP\",\"ttl\":120,\"proxied\":false}"
if [ -n "$REC_ID" ]; then
  curl -sf -X PUT -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$REC_ID" -d "$REC_BODY"
else
  curl -sf -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" -d "$REC_BODY"
fi
unset CF_TOKEN CLOUDFLARE_API_TOKEN

# ----- Notify: ready for review (box stays up; teardown on operator command) -----
aws sns publish --region "$REGION" --topic-arn "$NOTIFY_TOPIC" \
  --subject "[LCA] review environment ready ($RELEASE)" \
  --message "Release $RELEASE is built and ready for human review.

  Ingest summary: ${SUMMARY_JSON:-n/a}

  Operator UI : https://operator.h1b.report
  Preview site: https://dev.h1b.report

  Log in, walk the Reviews / Quarantine / Unresolved queues, then either click
  Promote (ship to prod) or Shut down (terminate this box)."
echo "burst-finalize: review environment ready ($RELEASE)"
