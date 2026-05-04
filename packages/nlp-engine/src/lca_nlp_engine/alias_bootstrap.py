"""
Self-supervised SOC alias bootstrapping
========================================
Mines high-agreement (job_title → SOC code) pairs from already-ingested
`lca_records` and inserts them into `soc_aliases` so both Stage 1 (exact
match) and Stage 2 (semantic retrieval) gain coverage.

Why this works on LCA data
--------------------------
Every LCA filing carries an employer-provided SOC_CODE. Individual employers
may pick the wrong code, but when many distinct employers independently use
the same SOC for a given job title, the consensus is high quality. We harvest
those consensus pairs as labelled training-free supervision.

Filters
-------
A (title, soc_code) pair is admitted into soc_aliases only when *all* of:

  * it occurs in at least --min-hits records overall
  * those records come from at least --min-employers distinct FEINs (avoid
    one large employer dominating)
  * the pair accounts for at least --min-agreement of the title's total
    occurrences (rejects ambiguous titles like "Manager" that map across
    many SOC codes)

Idempotency
-----------
The DDL puts a unique index on lower(soc_aliases.job_title), so DMTF entries
already in the table are preserved. Bootstrapped rows are tagged
source='lca_bootstrap' for downstream auditability.

Usage:
    bootstrap-aliases --min-hits 5 --min-employers 2 --min-agreement 0.8
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Optional

import psycopg
import structlog

log = structlog.get_logger(__name__)


_BOOTSTRAP_SQL = """
WITH normalized AS (
    SELECT
        lower(trim(data->>'JOB_TITLE'))                        AS title,
        regexp_replace(data->>'SOC_CODE', '\\.\\d+$', '')      AS soc_code,
        coalesce(nullif(trim(data->>'SOC_TITLE'), ''), '')     AS soc_title,
        data->>'EMPLOYER_FEIN'                                 AS fein
    FROM lca_records
    WHERE data->>'JOB_TITLE' IS NOT NULL
      AND length(trim(data->>'JOB_TITLE')) BETWEEN 2 AND 500
      AND data->>'SOC_CODE' ~ '^\\d{2}-\\d{4}'
),
pair_stats AS (
    SELECT
        title,
        soc_code,
        -- pick the most-common SOC_TITLE seen for this (title, soc_code)
        mode() WITHIN GROUP (ORDER BY soc_title)         AS soc_title,
        count(*)                                          AS hits,
        count(DISTINCT fein) FILTER (WHERE fein IS NOT NULL) AS distinct_employers
    FROM normalized
    GROUP BY title, soc_code
),
title_stats AS (
    SELECT title, sum(hits) AS total
    FROM pair_stats
    GROUP BY title
)
SELECT
    p.title,
    p.soc_code,
    p.soc_title,
    p.hits,
    p.distinct_employers,
    (p.hits::float / t.total) AS agreement
FROM pair_stats p
JOIN title_stats t USING (title)
WHERE p.hits >= %(min_hits)s
  AND p.distinct_employers >= %(min_employers)s
  AND (p.hits::float / t.total) >= %(min_agreement)s
  AND p.soc_title <> ''
  -- Skip titles already in soc_aliases (preserve DMTF / earlier bootstraps)
  AND NOT EXISTS (
        SELECT 1 FROM soc_aliases sa
        WHERE lower(sa.job_title) = p.title
  )
ORDER BY p.hits DESC;
"""


_INSERT_SQL = """
INSERT INTO soc_aliases (job_title, soc_code, soc_title, source)
VALUES (%s, %s, %s, 'lca_bootstrap')
ON CONFLICT ((lower(job_title))) DO NOTHING
"""


def bootstrap_aliases(
    db_url: str,
    min_hits: int = 5,
    min_employers: int = 2,
    min_agreement: float = 0.8,
    batch_size: int = 1000,
) -> dict[str, int]:
    """Mine consensus (title, SOC) pairs from lca_records and insert them.

    Returns a stats dict {candidates_found, inserted}.
    """
    inserted = 0
    candidates: list[tuple[str, str, str]] = []

    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            log.info(
                "alias_bootstrap.mining",
                min_hits=min_hits,
                min_employers=min_employers,
                min_agreement=min_agreement,
            )
            cur.execute(
                _BOOTSTRAP_SQL,
                {
                    "min_hits": min_hits,
                    "min_employers": min_employers,
                    "min_agreement": min_agreement,
                },
            )
            for row in cur.fetchall():
                title, soc_code, soc_title, hits, distinct_emp, agreement = row
                # soc_aliases.soc_code is character(7) → must be exactly XX-XXXX
                if len(soc_code) != 7:
                    continue
                candidates.append((title, soc_code, soc_title))

        log.info("alias_bootstrap.candidates", count=len(candidates))

        with conn.cursor() as cur:
            for i in range(0, len(candidates), batch_size):
                chunk = candidates[i : i + batch_size]
                cur.executemany(_INSERT_SQL, chunk)
                inserted += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        conn.commit()

    log.info("alias_bootstrap.done", candidates=len(candidates), inserted=inserted)
    return {"candidates_found": len(candidates), "inserted": inserted}


def cli_main() -> None:
    parser = argparse.ArgumentParser(
        description="Bootstrap soc_aliases from consensus (job_title, SOC_CODE) pairs in lca_records",
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL DSN (default: $DATABASE_URL)",
    )
    parser.add_argument(
        "--min-hits",
        type=int,
        default=int(os.environ.get("BOOTSTRAP_MIN_HITS", "5")),
        help="Minimum total occurrences for a (title, SOC) pair (default: 5)",
    )
    parser.add_argument(
        "--min-employers",
        type=int,
        default=int(os.environ.get("BOOTSTRAP_MIN_EMPLOYERS", "2")),
        help="Minimum distinct employers using this pair (default: 2)",
    )
    parser.add_argument(
        "--min-agreement",
        type=float,
        default=float(os.environ.get("BOOTSTRAP_MIN_AGREEMENT", "0.8")),
        help="Minimum fraction of title occurrences using this SOC (default: 0.8)",
    )
    args = parser.parse_args()

    if not args.db:
        print("ERROR: --db or DATABASE_URL is required", file=sys.stderr)
        sys.exit(2)

    stats = bootstrap_aliases(
        db_url=args.db,
        min_hits=args.min_hits,
        min_employers=args.min_employers,
        min_agreement=args.min_agreement,
    )
    print(
        f"Bootstrap complete: {stats['inserted']} new aliases inserted "
        f"(from {stats['candidates_found']} candidates)."
    )
