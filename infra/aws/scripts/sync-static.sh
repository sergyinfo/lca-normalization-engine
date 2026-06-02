#!/usr/bin/env bash
# sync-static.sh — upload the Next.js static assets to the S3 bucket that
# CloudFront serves for the /_next/static/* and /static/* behaviors.
#
# WHY THIS EXISTS: LcaServeStack routes /_next/static/* and /static/* to an S3
# origin (StaticAssetsBucket). Nothing else populates that bucket — without
# this step every CSS/JS request 404s and the site renders unstyled. The Lambda
# image bundles the same assets, but the CloudFront behaviors send those paths
# to S3, not the Lambda, so S3 must hold them.
#
# ORDERING: run this AFTER `pnpm deploy:serve` (the bucket is created by that
# stack) and after a local `pnpm --filter analytics-web build` (which produces
# .next/static). Re-run it on every code deploy so hashed asset paths stay in
# sync. It is also invoked from the burst EC2 cloud-init for quarterly rebuilds.
#
# Prerequisites:
#   1. LcaServeStack deployed (exports LcaStaticAssetsBucket)
#   2. apps/analytics-web/.next/static present (`pnpm --filter analytics-web build`)
#   3. AWS_PROFILE / AWS_REGION configured
#
# Usage:
#   ./infra/aws/scripts/sync-static.sh                # resolve bucket from CFN export
#   STATIC_BUCKET=my-bucket ./infra/aws/scripts/sync-static.sh   # override

set -euo pipefail

if ! command -v aws >/dev/null; then
  echo "✗ aws CLI not on PATH" >&2; exit 1
fi

REGION="${AWS_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"

# Move to monorepo root (script lives in infra/aws/scripts/)
cd "$(dirname "$0")/../../.."

STATIC_DIR="apps/analytics-web/.next/static"
PUBLIC_DIR="apps/analytics-web/public"

if [[ ! -d "$STATIC_DIR" ]]; then
  echo "✗ $STATIC_DIR is missing." >&2
  echo "  Run \`pnpm --filter analytics-web build\` first, then retry." >&2
  exit 1
fi

# ----- Resolve the static-assets bucket -----------------------------------
if [[ -z "${STATIC_BUCKET:-}" ]]; then
  echo "▶ Resolving StaticAssetsBucket from CloudFormation export LcaStaticAssetsBucket"
  STATIC_BUCKET=$(aws cloudformation list-exports \
    --region "$REGION" \
    --query "Exports[?Name=='LcaStaticAssetsBucket'].Value" \
    --output text)
fi

if [[ -z "$STATIC_BUCKET" || "$STATIC_BUCKET" == "None" ]]; then
  echo "✗ Could not resolve the static-assets bucket." >&2
  echo "  Deploy LcaServeStack first (\`pnpm deploy:serve\`), or pass STATIC_BUCKET=… explicitly." >&2
  exit 1
fi
echo "  Bucket: $STATIC_BUCKET"

# ----- Sync hashed assets (immutable, cache forever) ----------------------
# /_next/static/* paths are content-hashed, so a 1-year immutable TTL is safe.
echo "▶ Syncing $STATIC_DIR → s3://$STATIC_BUCKET/_next/static/"
aws s3 sync "$STATIC_DIR" "s3://$STATIC_BUCKET/_next/static/" \
  --region "$REGION" \
  --cache-control "public,max-age=31536000,immutable" \
  --delete

# ----- Sync public/* (favicon, OG placeholders, etc.) ---------------------
# Served under /static/* per the CloudFront behavior. Not content-hashed, so a
# shorter TTL — CloudFront still honors the per-object Cache-Control.
echo "▶ Syncing $PUBLIC_DIR → s3://$STATIC_BUCKET/static/"
aws s3 sync "$PUBLIC_DIR" "s3://$STATIC_BUCKET/static/" \
  --region "$REGION" \
  --cache-control "public,max-age=3600" \
  --delete

echo "✓ Static assets synced. Hard-refresh https://<your-domain>/_next/static/… to verify a 200."
