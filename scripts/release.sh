#!/usr/bin/env bash
# release.sh — canonical rebuild + deploy for analytics-web.
#
# Usage:
#   ./scripts/release.sh                   # full rebuild (data + image)
#   ./scripts/release.sh --code-only       # skip SQLite + summaries
#   ./scripts/release.sh --skip-summaries  # rebuild data but keep existing summaries
#
# See DEPLOY.md §4 for what each step does.

set -euo pipefail

CODE_ONLY=0
SKIP_SUMMARIES=0
for arg in "$@"; do
  case "$arg" in
    --code-only)      CODE_ONLY=1 ;;
    --skip-summaries) SKIP_SUMMARIES=1 ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."

echo "▶ Pre-flight: typecheck"
pnpm --filter analytics-web typecheck
echo "  ✓ Typecheck passed"

if [[ $CODE_ONLY -eq 0 ]]; then
  echo "▶ Step 1: Rebuilding lca.db from Postgres"
  pnpm --filter analytics-web build:sqlite

  if [[ $SKIP_SUMMARIES -eq 0 ]]; then
    echo "▶ Step 2: Regenerating LLM summaries"
    pnpm --filter analytics-web build:summaries
  else
    echo "▶ Step 2: Skipped (--skip-summaries)"
  fi
else
  echo "▶ Steps 1+2: Skipped (--code-only)"
fi

echo "▶ Step 3: Tagging current image as :rollback"
IMG=lca-normalization-engine-analytics-web
if docker image inspect "${IMG}:latest" >/dev/null 2>&1; then
  docker tag "${IMG}:latest" "${IMG}:rollback"
  echo "  ✓ Previous image tagged as :rollback"
else
  echo "  ⚠  No previous :latest image — first release"
fi

echo "▶ Step 4: Building new image"
docker compose build analytics-web

echo "▶ Step 5: Deploying"
docker compose up -d analytics-web

echo "▶ Step 6: Smoke test"
# Wait up to 30s for the container to start serving
for i in {1..15}; do
  if curl -fsS -o /dev/null http://localhost:3000/ 2>/dev/null; then
    break
  fi
  sleep 2
done

FAILED=0
for path in \
    / \
    /employer \
    /occupation/software-developers-15-1252 \
    /sitemap.xml \
    /api/docs; do
  code=$(curl -fsS -o /dev/null -w "%{http_code}" "http://localhost:3000${path}" 2>/dev/null || echo "FAIL")
  printf "  %-55s %s\n" "$path" "$code"
  [[ "$code" == "200" ]] || FAILED=1
done

if [[ $FAILED -eq 1 ]]; then
  echo "✗ Smoke test failed — investigate or roll back with:"
  echo "    docker tag ${IMG}:rollback ${IMG}:latest && docker compose up -d analytics-web"
  exit 1
fi

echo "✓ Release complete"
