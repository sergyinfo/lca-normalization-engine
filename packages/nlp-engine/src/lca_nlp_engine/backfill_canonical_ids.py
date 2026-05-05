"""
Backfill canonical_employer_id on lca_records orphans
=====================================================
Scans `lca_records` for rows with no `canonical_employer_id` and runs
Layer 1 (FEIN) entity resolution against `canonical_employers`, writing the
resolved UUID back into the JSONB.

Why this exists
---------------
The original NLP worker resolves canonical_employer_id inline. Records that
took the quarantine path (low Stage-2 confidence, then later drained by
`reclassify-quarantine`) only had their SOC fields patched — `canonical_employer_id`
was never written. This CLI fixes those gaps.

Idempotent: re-running picks up only rows still missing the id. Keyset-paginated
to stay correct under concurrent writes.

CLI:
    DATABASE_URL=...  backfill-canonical-ids --batch 500 --limit 0
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import psycopg
import structlog

from lca_nlp_engine.entity_resolution import CompanyDeduplicator

log = structlog.get_logger(__name__)


_FETCH_SQL = """
SELECT
    lr.id,
    lr.filing_year,
    lr.data->>'_nlp_id'         AS nlp_id,
    lr.data->>'EMPLOYER_NAME'   AS employer_name,
    lr.data->>'EMPLOYER_FEIN'   AS fein,
    lr.data->>'EMPLOYER_CITY'   AS employer_city,
    lr.data->>'EMPLOYER_STATE'  AS employer_state
FROM lca_records lr
WHERE lr.data->>'canonical_employer_id' IS NULL
  AND (lr.id, lr.filing_year) > (%s, %s)
ORDER BY lr.filing_year, lr.id
LIMIT %s;
"""

_UPDATE_SQL = """
UPDATE lca_records
SET data = data || %s::jsonb
WHERE id = %s
  AND filing_year = %s
"""


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill canonical_employer_id on lca_records orphans via Layer 1 (FEIN)"
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL DSN (default: $DATABASE_URL)",
    )
    parser.add_argument("--batch", type=int, default=500, help="Rows per fetch")
    parser.add_argument("--limit", type=int, default=0, help="Stop after N rows (0 = all)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Resolve and report but do not write back",
    )
    args = parser.parse_args()

    if not args.db:
        print("ERROR: DATABASE_URL is required", file=sys.stderr)
        sys.exit(2)

    dedup = CompanyDeduplicator(db_url=args.db)
    dedup.connect()
    if dedup._db_conn is None:  # type: ignore[attr-defined]
        print("ERROR: could not connect to DB", file=sys.stderr)
        sys.exit(3)

    n_seen = 0
    n_resolved = 0
    n_unresolved = 0
    last_year = 0
    last_id = 0

    started = time.time()
    log.info("backfill.start", dry_run=args.dry_run)

    with psycopg.connect(args.db) as conn:
        while True:
            with conn.cursor() as cur:
                cur.execute(_FETCH_SQL, (last_id, last_year, args.batch))
                rows = cur.fetchall()
            if not rows:
                break
            last_id = rows[-1][0]
            last_year = rows[-1][1]

            for row in rows:
                row_id, filing_year, nlp_id, name, fein, city, state = row
                n_seen += 1
                if args.limit and n_seen > args.limit:
                    break

                canonical_id = dedup.resolve_fein(
                    employer_name=name or "",
                    fein=fein,
                    employer_city=city,
                    employer_state=state,
                )
                if canonical_id is None:
                    n_unresolved += 1
                    continue

                n_resolved += 1
                if args.dry_run:
                    if n_resolved <= 10:
                        log.info(
                            "backfill.dry_run_pick",
                            employer=(name or "")[:60],
                            fein=fein,
                            canonical_id=str(canonical_id),
                        )
                    continue

                patch = {"canonical_employer_id": str(canonical_id)}
                try:
                    with conn.cursor() as cur:
                        cur.execute(_UPDATE_SQL, (json.dumps(patch), row_id, filing_year))
                    conn.commit()
                except Exception:
                    log.exception("backfill.write_failed", row_id=row_id)
                    conn.rollback()

                if n_seen % 500 == 0:
                    log.info(
                        "backfill.progress",
                        seen=n_seen,
                        resolved=n_resolved,
                        unresolved=n_unresolved,
                        elapsed=int(time.time() - started),
                    )

            if args.limit and n_seen >= args.limit:
                break

    dedup.close()
    elapsed = int(time.time() - started)
    print()
    print("=== Backfill Summary ===")
    print(f"  rows seen     : {n_seen}")
    print(f"  resolved      : {n_resolved}  ({(100.0*n_resolved/n_seen if n_seen else 0):.1f}%)")
    print(f"  unresolved    : {n_unresolved}  (no FEIN match in canonical_employers)")
    print(f"  elapsed       : {elapsed}s")


if __name__ == "__main__":
    main()
