#!/usr/bin/env bash
# smoke-test.sh — quick post-deploy verification.
#
# Hits the most-important routes and confirms they all return 200.
# Usage:
#   ./scripts/smoke-test.sh                       # localhost:3000
#   ./scripts/smoke-test.sh https://h1b.report    # custom base URL

set -euo pipefail

BASE="${1:-http://localhost:3000}"

PATHS=(
  /
  /sitemap.xml
  /robots.txt
  /employer
  /occupation
  /state
  /sector
  /rankings
  /top-h1b-sponsors
  /top-h1b-occupations
  /top-h1b-states
  /h1b-by-industry
  /highest-paying-h1b-jobs
  /cleanest-h1b-sponsors
  /employer/cognizant-technology-solutions-us-corp
  /occupation/software-developers-15-1252
  /state/california-ca
  /sector/professional-scientific-and-technical-services-54
  /search?q=cog
  /api/docs
  /compare/employer/cognizant-technology-solutions-us-corp/infosys-limited
)

FAILED=0
for path in "${PATHS[@]}"; do
  code=$(curl -fsS -o /dev/null -w "%{http_code}" "${BASE}${path}" 2>/dev/null || echo "FAIL")
  if [[ "$code" == "200" ]]; then
    printf "  ✓ %-65s %s\n" "$path" "$code"
  else
    printf "  ✗ %-65s %s\n" "$path" "$code"
    FAILED=1
  fi
done

if [[ $FAILED -eq 1 ]]; then
  echo
  echo "✗ Smoke test failed against ${BASE}"
  exit 1
fi

echo
echo "✓ All routes 200 against ${BASE}"
