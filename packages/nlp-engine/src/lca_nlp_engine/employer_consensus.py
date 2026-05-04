"""
Stage 0 — per-employer SOC consensus refresher
==============================================
Aggregates `lca_records` into the `employer_soc_consensus` lookup table that
`SocClassifier` consults BEFORE the DMTF / retrieval stages.

Why per-employer (not just global aliases)
------------------------------------------
`alias_bootstrap` already mines *cross-employer* consensus into `soc_aliases`.
That works for unambiguous titles ("Software Engineer" → 15-1252 across the
whole industry), but it cannot resolve titles whose meaning depends on the
filer:

  * "Partner" at a law firm → 23-1011 Lawyers
  * "Partner" at a consulting firm → 13-1111 Management Analysts
  * "Fellow" at a hospital → 29-1228 Physicians; at a university → 25-1099

The signal is the employer's *own* self-consistent labelling: when the same
FEIN files the same JOB_TITLE many times with the same SOC, the employer is
the authority on what that role means at their own company. We trust them.

Filters
-------
A (FEIN, normalized_title) entry is admitted only when *all* of:
  * the employer used this (title, soc) at least --min-hits times
  * those hits represent at least --min-agreement of the employer's filings
    for that title
  * SOC code is well-formed (XX-XXXX)

Idempotency
-----------
Refresher truncates and rebuilds. Cheap on our scale; can be made incremental
if we ever exceed ~10M rows.

Usage:
    refresh-employer-consensus --min-hits 5 --min-agreement 0.8
"""

from __future__ import annotations

import argparse
import os
import sys

import psycopg
import structlog

log = structlog.get_logger(__name__)


_AGGREGATE_SQL = """
WITH normalized AS (
    SELECT
        data->>'EMPLOYER_FEIN'                              AS fein,
        lower(trim(data->>'JOB_TITLE'))                     AS title_norm,
        regexp_replace(data->>'SOC_CODE', '\\.\\d+$', '')   AS soc_code,
        coalesce(nullif(trim(data->>'SOC_TITLE'), ''), '')  AS soc_title
    FROM lca_records
    WHERE data->>'JOB_TITLE' IS NOT NULL
      AND length(trim(data->>'JOB_TITLE')) BETWEEN 2 AND 500
      AND data->>'EMPLOYER_FEIN' ~ '^\\d{2}-?\\d{6,}$'
      AND data->>'SOC_CODE' ~ '^\\d{2}-\\d{4}'
),
pair_stats AS (
    SELECT
        fein,
        title_norm,
        soc_code,
        mode() WITHIN GROUP (ORDER BY soc_title) AS soc_title,
        count(*)                                  AS hits
    FROM normalized
    GROUP BY fein, title_norm, soc_code
),
title_totals AS (
    SELECT fein, title_norm, sum(hits) AS total
    FROM pair_stats
    GROUP BY fein, title_norm
)
SELECT
    p.fein,
    p.title_norm,
    p.soc_code,
    p.soc_title,
    p.hits,
    (p.hits::real / t.total) AS agreement
FROM pair_stats p
JOIN title_totals t USING (fein, title_norm)
WHERE p.hits >= %(min_hits)s
  AND (p.hits::real / t.total) >= %(min_agreement)s
  AND p.soc_title <> '';
"""


_TRUNCATE_SQL = "TRUNCATE TABLE employer_soc_consensus"


_INSERT_SQL = """
INSERT INTO employer_soc_consensus
    (fein, job_title_norm, soc_code, soc_title, hits, agreement)
VALUES (%s, %s, %s, %s, %s, %s)
ON CONFLICT (fein, job_title_norm) DO UPDATE
    SET soc_code     = EXCLUDED.soc_code,
        soc_title    = EXCLUDED.soc_title,
        hits         = EXCLUDED.hits,
        agreement    = EXCLUDED.agreement,
        refreshed_at = NOW()
"""


def refresh_consensus(
    db_url: str,
    min_hits: int = 5,
    min_agreement: float = 0.8,
    batch_size: int = 5000,
) -> dict[str, int]:
    """Rebuild employer_soc_consensus from lca_records. Returns counts."""
    rows: list[tuple] = []

    with psycopg.connect(db_url) as conn:
        log.info("employer_consensus.mining", min_hits=min_hits, min_agreement=min_agreement)
        with conn.cursor() as cur:
            cur.execute(_AGGREGATE_SQL, {"min_hits": min_hits, "min_agreement": min_agreement})
            for r in cur.fetchall():
                fein, title_norm, soc_code, soc_title, hits, agreement = r
                if len(soc_code) != 7:
                    continue
                rows.append((fein, title_norm, soc_code, soc_title, hits, float(agreement)))

        log.info("employer_consensus.candidates", count=len(rows))

        with conn.cursor() as cur:
            cur.execute(_TRUNCATE_SQL)
            for i in range(0, len(rows), batch_size):
                cur.executemany(_INSERT_SQL, rows[i : i + batch_size])
        conn.commit()

    log.info("employer_consensus.done", inserted=len(rows))
    return {"inserted": len(rows)}


def cli_main() -> None:
    parser = argparse.ArgumentParser(
        description="Refresh employer_soc_consensus from lca_records",
    )
    parser.add_argument("--db", default=os.environ.get("DATABASE_URL"))
    parser.add_argument(
        "--min-hits",
        type=int,
        default=int(os.environ.get("EMP_CONSENSUS_MIN_HITS", "5")),
        help="Minimum filings of (employer, title, soc) to admit (default: 5)",
    )
    parser.add_argument(
        "--min-agreement",
        type=float,
        default=float(os.environ.get("EMP_CONSENSUS_MIN_AGREEMENT", "0.8")),
        help="Minimum fraction of employer's filings of this title that use this SOC (default: 0.8)",
    )
    args = parser.parse_args()

    if not args.db:
        print("ERROR: --db or DATABASE_URL is required", file=sys.stderr)
        sys.exit(2)

    stats = refresh_consensus(
        db_url=args.db,
        min_hits=args.min_hits,
        min_agreement=args.min_agreement,
    )
    print(f"Employer SOC consensus refreshed: {stats['inserted']} entries.")
