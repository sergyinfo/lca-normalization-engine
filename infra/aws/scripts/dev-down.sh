#!/usr/bin/env bash
# dev-down.sh — tear down the DEV serving stack (LcaServeStack) entirely.
#
# NOTE: the dev serve stack is Lambda + CloudFront — both pay-per-request — so it
# idles at ≈$0. The real cost lever in this project is the burst EC2 (the review
# box), which is already ephemeral and shut down from the operator UI. Use this
# only when you want dev fully gone (e.g. a long pause). `dev-up.sh` brings it
# back; the dev CloudFront domain changes, so dev-up re-points the Cloudflare
# CNAME for you.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SELF_DIR/.."   # infra/aws

echo "▶ Destroying LcaServeStack (dev). Prod + shared are untouched."
pnpm cdk destroy LcaServeStack --force
echo "✓ Dev serve stack destroyed. dev.h1b.report will 5xx until you run dev-up.sh."
