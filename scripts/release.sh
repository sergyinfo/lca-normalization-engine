#!/usr/bin/env bash
# release.sh — canonical rebuild + deploy for analytics-web.
#
# Usage:
#   ./scripts/release.sh                   # full rebuild (data + image)
#   ./scripts/release.sh --code-only       # skip SQLite + summaries
#   ./scripts/release.sh --skip-summaries  # rebuild data but keep existing summaries
#   ./scripts/release.sh --rebuild-views   # also DROP+CREATE every matview from
#                                            analytics_views.sql. Run after pulling
#                                            a release that adds new matviews.
#                                            Slow — ~30-60 min for the full corpus.
#   ./scripts/release.sh --skip-views      # skip the matview REFRESH step
#
# Env:
#   DATABASE_URL  required for the matview + SQLite-rebuild steps
#                 (typically loaded from .env in the working directory)
#
# See DEPLOY.md §4 for what each step does.

set -euo pipefail

CODE_ONLY=0
SKIP_SUMMARIES=0
SKIP_VIEWS=0
REBUILD_VIEWS=0
for arg in "$@"; do
  case "$arg" in
    --code-only)      CODE_ONLY=1 ;;
    --skip-summaries) SKIP_SUMMARIES=1 ;;
    --skip-views)     SKIP_VIEWS=1 ;;
    --rebuild-views)  REBUILD_VIEWS=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
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
  # Step 0 — keep Postgres analytics matviews in sync with the SQL file.
  #
  # `refresh_views.sql` only refreshes matviews that already exist; if
  # `analytics_views.sql` adds a new matview between releases, REFRESH
  # alone won't notice (we hit exactly this on 2026-05-26).
  #
  # Default behaviour:
  #   - Detect declared vs present matviews.
  #   - If any are missing, refuse to continue and tell the operator to
  #     re-run with `--rebuild-views` (the DROP+CREATE pass takes 30-60 min
  #     on the full corpus, so we don't want to do it silently).
  #   - Otherwise REFRESH all matviews (fast — ~5 min on the full corpus).
  if [[ $SKIP_VIEWS -eq 0 ]]; then
    if [[ -z "${DATABASE_URL:-}" ]]; then
      echo "  ✗ DATABASE_URL is not set — source .env or pass it inline." >&2
      exit 1
    fi

    if [[ $REBUILD_VIEWS -eq 1 ]]; then
      echo "▶ Step 0: --rebuild-views — applying analytics_views.sql in full"
      echo "  (DROP+CREATE every matview from scratch; expect 30-60 min)"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
        -f apps/analytics-ui/db/analytics_views.sql >/dev/null
      echo "  ✓ Matviews recreated"
    else
      echo "▶ Step 0: Checking for new matviews in analytics_views.sql"
      DECLARED=$(grep -oE 'CREATE MATERIALIZED VIEW analytics\.[a-z_]+' \
        apps/analytics-ui/db/analytics_views.sql \
        | sed -E 's|CREATE MATERIALIZED VIEW analytics\.||' \
        | sort -u)
      PRESENT=$(psql "$DATABASE_URL" -tA -c \
        "SELECT matviewname FROM pg_matviews WHERE schemaname='analytics' ORDER BY 1")
      MISSING=$(comm -23 <(echo "$DECLARED") <(echo "$PRESENT"))
      if [[ -n "$MISSING" ]]; then
        echo "  ✗ Missing matviews in Postgres:"
        echo "$MISSING" | sed 's/^/      /'
        echo "  Re-run with --rebuild-views (slow but creates them)."
        exit 1
      fi
      echo "  ✓ All declared matviews present"

      echo "▶ Step 0b: REFRESHing matviews from current lca_records"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
        -f apps/analytics-ui/db/refresh_views.sql >/dev/null
      echo "  ✓ Matviews refreshed"
    fi
  else
    echo "▶ Step 0: Skipped (--skip-views)"
  fi

  echo "▶ Step 1: Rebuilding lca.db from Postgres"
  pnpm --filter analytics-web build:sqlite

  if [[ $SKIP_SUMMARIES -eq 0 ]]; then
    echo "▶ Step 2: Regenerating LLM summaries"
    pnpm --filter analytics-web build:summaries
  else
    echo "▶ Step 2: Skipped (--skip-summaries)"
  fi
else
  echo "▶ Steps 0+1+2: Skipped (--code-only)"
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
