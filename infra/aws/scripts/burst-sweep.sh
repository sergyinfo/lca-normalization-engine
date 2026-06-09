#!/bin/bash
#
# burst-sweep.sh — GUARANTEED NLP enqueue.
#
# Enqueues EVERY unclassified, non-quarantined row into nlp-tasks, so coverage
# does NOT depend on the ingestor's best-effort per-batch enqueue (a transient
# Redis hiccup there silently left ~2.9M FY2010-2019 rows ingested-but-never-
# classified — see project_notes/soc_classifier_evolution.md "All-Years Coverage
# Audit"). base64 so text COPY escaping can't corrupt the embedded JSON.
#
# Scope: set SWEEP_FILING_YEARS (comma list, e.g. "2026") to limit the sweep to
# the just-ingested year(s) — the quarterly burst does this so it never re-sweeps
# the historical backlog into a multi-day drain. Leave it unset for a global
# sweep (the decoupled processor's full backfill).
set -euo pipefail
cd /opt/lca
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"

YEAR_FILTER=""
if [ -n "${SWEEP_FILING_YEARS:-}" ]; then
  YEAR_FILTER="AND r.filing_year = ANY(string_to_array('${SWEEP_FILING_YEARS}', ',')::int[])"
  echo "[burst-sweep] scope: filing_year IN {${SWEEP_FILING_YEARS}}"
else
  echo "[burst-sweep] scope: global (all unclassified rows)"
fi

SWEEP_SQL="COPY (SELECT replace(encode(convert_to(json_build_object(
  'nlp_id', data->>'_nlp_id', 'filing_year', filing_year,
  'job_title',      COALESCE(data->>'JOB_TITLE', data->>'job_title',''),
  'employer_name',  COALESCE(data->>'EMPLOYER_NAME', data->>'employer_name',''),
  'employer_state', COALESCE(data->>'EMPLOYER_STATE', data->>'employer_state'),
  'employer_city',  COALESCE(data->>'EMPLOYER_CITY', data->>'employer_city'),
  'fein',           COALESCE(data->>'EMPLOYER_FEIN', data->>'employer_fein')
  )::text,'UTF8'),'base64'), E'\n','')
  FROM lca_records r
  WHERE NOT (data ? 'soc_code')
    AND NOT EXISTS (SELECT 1 FROM staging.quarantine_records q
                     WHERE q.raw_data->>'_nlp_id' = r.data->>'_nlp_id')
    ${YEAR_FILTER}
  ) TO STDOUT"

echo "[burst-sweep] enqueuing unclassified rows -> nlp-tasks"
docker compose exec -T db psql -U lca_user -d lca_db -tA -c "$SWEEP_SQL" \
  | node apps/ingestor/sweep-enqueue.mjs
echo "[burst-sweep] done"
