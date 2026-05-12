"""
Full-cascade canonical-employer backfill
========================================
Resolves the `staging.unresolved_employers` queue end-to-end using the full
three-layer cascade and **inserts a new canonical_employer when no match is
found above threshold** (the existing `backfill-canonical-ids` is Layer-1
only and can't UPSERT, so it's a no-op for rows whose FEIN was never
registered as a canonical).

For each open unresolved entry we run, in order:

  Layer 1 — FEIN exact match against `canonical_employers`
  Layer 2 — `pg_trgm` similarity, state-blocked, threshold default 0.85
  Layer 3 — `pgvector` HNSW cosine, default cosine distance ≤ 0.15
  Miss   — INSERT a new `canonical_employers` row + embed its name into
           `employer_embeddings`

After the per-row decision, the script:

  1. Bulk-inserts new embeddings (one statement, executemany)
  2. Bulk-marks unresolved_employers as resolved with `resolved_to_id`
  3. Bulk-updates matching `lca_records` (by lower(EMPLOYER_NAME) + state)
     so every orphan row gets a `canonical_employer_id`

Work happens in batches of `--batch` rows (default 256) for memory and WAL
pressure control. Layer 3 encoding is batched within each chunk, which is
~5–10× faster than per-row encoding on Mac CPU.

Idempotent: only `resolved_at IS NULL` rows are processed; rerunning picks
up newly added unresolved entries.

CLI:
    DATABASE_URL=...  backfill-canonical-full \\
        --batch 256 \\
        --trgm-threshold 0.85 \\
        --vector-max-distance 0.15 \\
        [--limit N] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional
from uuid import UUID

import psycopg
import structlog

log = structlog.get_logger(__name__)


DEFAULT_MODEL = os.environ.get(
    "NLP_STAGE2_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
)
DEFAULT_TRGM_THRESHOLD = float(os.environ.get("NLP_TRGM_THRESHOLD", "0.85"))
DEFAULT_VECTOR_MAX_DIST = float(os.environ.get("NLP_VECTOR_MAX_DIST", "0.15"))
DEFAULT_BATCH = 256


# ---- SQL --------------------------------------------------------------------

_FETCH_UNRESOLVED_SQL = """
SELECT id, employer_name, employer_state, employer_fein, employer_city
FROM   staging.unresolved_employers
WHERE  resolved_at IS NULL
ORDER  BY id
LIMIT  %s OFFSET %s
"""

_LAYER1_SQL = """
SELECT id FROM canonical_employers WHERE fein = %s
"""

_LAYER2_SQL = """
SELECT id, similarity(canonical_name, %(name)s) AS sim
FROM   canonical_employers
WHERE  canonical_name %% %(name)s
  AND  (%(state)s::char(2) IS NULL OR employer_state = %(state)s)
ORDER  BY sim DESC
LIMIT  1
"""

_LAYER3_SQL = """
SELECT employer_id, embedding <=> %s::vector AS dist
FROM   employer_embeddings
ORDER  BY embedding <=> %s::vector
LIMIT  1
"""

_INSERT_CANONICAL_SQL = """
INSERT INTO canonical_employers
    (canonical_name, fein, employer_city, employer_state, record_count)
VALUES (%s, %s, %s, %s, 0)
RETURNING id
"""

_INSERT_EMBEDDING_SQL = """
INSERT INTO employer_embeddings (employer_id, embedding, model_version)
VALUES (%s, %s::vector, %s)
ON CONFLICT (employer_id) DO NOTHING
"""

_MARK_RESOLVED_SQL = """
UPDATE staging.unresolved_employers
SET    resolved_at    = NOW(),
       resolved_to_id = %s
WHERE  id = %s
"""

# Bulk-backfill matching lca_records for one resolved unresolved entry.
# Driven by the new composite expression index
# `idx_lca_records_employer_name_state` (lower(EMPLOYER_NAME),EMPLOYER_STATE)
# plus the partial `idx_lca_records_canonical_missing` for the orphan filter.
_BACKFILL_LCA_SQL = """
UPDATE lca_records
SET    data = data || jsonb_build_object('canonical_employer_id', %(canonical)s::text)
WHERE  lower(data->>'EMPLOYER_NAME') = lower(%(name)s)
  AND  (%(state)s::text IS NULL OR data->>'EMPLOYER_STATE' = %(state)s)
  AND  NOT (data ? 'canonical_employer_id')
"""

_BUMP_RECORD_COUNT_SQL = """
UPDATE canonical_employers
SET    record_count = record_count + %s,
       updated_at   = NOW()
WHERE  id = %s
"""


# ---- Helpers ----------------------------------------------------------------

import re

_FEIN_RE = re.compile(r"^\d{2}-\d{7}$")


@dataclass
class UnresolvedRow:
    id: int
    employer_name: str
    employer_state: Optional[str]
    employer_fein: Optional[str]
    employer_city: Optional[str]


@dataclass
class Decision:
    unresolved_id: int
    employer_name: str
    employer_state: Optional[str]
    canonical_id: UUID
    source: str  # 'fein' | 'trgm' | 'vector' | 'inserted'


@dataclass
class Stats:
    seen: int = 0
    by_layer: dict[str, int] = field(default_factory=lambda: {
        "fein": 0,
        "trgm": 0,
        "vector": 0,
        "inserted": 0,
    })
    lca_rows_backfilled: int = 0
    new_canonicals: int = 0
    new_embeddings: int = 0
    started_at: float = field(default_factory=time.time)

    def elapsed(self) -> int:
        return int(time.time() - self.started_at)


def _vec_literal(v: Iterable[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def _resolve_layer1(cur: Any, fein: Optional[str]) -> Optional[UUID]:
    if not fein or not _FEIN_RE.match(fein):
        return None
    cur.execute(_LAYER1_SQL, (fein,))
    row = cur.fetchone()
    return UUID(str(row[0])) if row else None


def _resolve_layer2(
    cur: Any,
    name: str,
    state: Optional[str],
    threshold: float,
) -> Optional[UUID]:
    if not name:
        return None
    cur.execute(_LAYER2_SQL, {"name": name, "state": state})
    row = cur.fetchone()
    if not row:
        return None
    cid, sim = row
    return UUID(str(cid)) if sim is not None and float(sim) >= threshold else None


def _resolve_layer3(
    cur: Any,
    vec_lit: str,
    max_dist: float,
) -> Optional[UUID]:
    cur.execute(_LAYER3_SQL, (vec_lit, vec_lit))
    row = cur.fetchone()
    if not row:
        return None
    cid, dist = row
    return UUID(str(cid)) if dist is not None and float(dist) <= max_dist else None


# ---- Main -------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Resolve staging.unresolved_employers via Layer 1/2/3 cascade with "
            "UPSERT of new canonical_employers when nothing matches above threshold."
        )
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL DSN (default: $DATABASE_URL)",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help="sentence-transformer model id")
    parser.add_argument("--batch", type=int, default=DEFAULT_BATCH, help="rows per chunk")
    parser.add_argument(
        "--trgm-threshold",
        type=float,
        default=DEFAULT_TRGM_THRESHOLD,
        help="Layer 2 similarity floor (default 0.85)",
    )
    parser.add_argument(
        "--vector-max-distance",
        type=float,
        default=DEFAULT_VECTOR_MAX_DIST,
        help="Layer 3 cosine distance ceiling (default 0.15 ≈ similarity 0.85)",
    )
    parser.add_argument(
        "--limit", type=int, default=0, help="stop after N unresolved rows (0 = all)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report decisions without writing back",
    )
    parser.add_argument(
        "--no-backfill",
        action="store_true",
        help="resolve unresolved_employers but skip the lca_records backfill",
    )
    args = parser.parse_args()

    if not args.db:
        print("ERROR: DATABASE_URL is required", file=sys.stderr)
        sys.exit(2)

    try:
        from sentence_transformers import SentenceTransformer
    except Exception:
        print("ERROR: sentence-transformers not installed", file=sys.stderr)
        sys.exit(3)

    device = os.environ.get("NLP_DEVICE", "cpu")
    log.info("backfill_full.load_model", model=args.model, device=device)
    encoder = SentenceTransformer(args.model, device=device)
    model_short = args.model.rsplit("/", 1)[-1]

    stats = Stats()
    log.info(
        "backfill_full.start",
        dry_run=args.dry_run,
        backfill_lca=not args.no_backfill,
        trgm_threshold=args.trgm_threshold,
        vector_max_distance=args.vector_max_distance,
        batch=args.batch,
    )

    with psycopg.connect(args.db) as conn:
        # Session-level tuning for the long-running backfill.
        # `enable_seqscan = off` is the critical one: even with the new
        # composite expression index on (lower(EMPLOYER_NAME), EMPLOYER_STATE),
        # the planner picks Seq Scan on per-partition lookups when stats
        # are stale. EXPLAIN ANALYZE on FY2025 confirms the index hit drops
        # per-merge UPDATE wall time from ~14s to ~2s.
        with conn.cursor() as scur:
            scur.execute("SET LOCAL work_mem = '512MB'")
            scur.execute("SET LOCAL maintenance_work_mem = '2GB'")
            scur.execute("SET LOCAL synchronous_commit = off")
            scur.execute("SET LOCAL max_parallel_workers_per_gather = 4")
            scur.execute("SET LOCAL enable_seqscan = off")

        offset = 0
        while True:
            with conn.cursor() as cur:
                cur.execute(_FETCH_UNRESOLVED_SQL, (args.batch, offset))
                raw = cur.fetchall()
            if not raw:
                break

            chunk: list[UnresolvedRow] = [
                UnresolvedRow(
                    id=r[0],
                    employer_name=(r[1] or "").strip(),
                    employer_state=r[2],
                    employer_fein=r[3],
                    employer_city=r[4],
                )
                for r in raw
                if (r[1] or "").strip()
            ]
            if not chunk:
                offset += len(raw)
                continue

            decisions: list[Decision] = []
            need_vector: list[UnresolvedRow] = []

            # Pass 1: Layer 1 + Layer 2, collect leftovers for batched Layer 3.
            with conn.cursor() as cur:
                for row in chunk:
                    cid = _resolve_layer1(cur, row.employer_fein)
                    if cid is not None:
                        decisions.append(
                            Decision(row.id, row.employer_name, row.employer_state, cid, "fein")
                        )
                        continue
                    cid = _resolve_layer2(
                        cur, row.employer_name, row.employer_state, args.trgm_threshold
                    )
                    if cid is not None:
                        decisions.append(
                            Decision(row.id, row.employer_name, row.employer_state, cid, "trgm")
                        )
                        continue
                    need_vector.append(row)

            # Pass 2: batched encode + Layer 3 lookup + insert-on-miss.
            new_canonicals: list[tuple[str, str, list[float]]] = []  # (uuid, name, vec)
            if need_vector:
                names = [r.employer_name for r in need_vector]
                vecs = encoder.encode(
                    names,
                    batch_size=args.batch,
                    normalize_embeddings=True,
                    show_progress_bar=False,
                )
                with conn.cursor() as cur:
                    for row, vec in zip(need_vector, vecs):
                        vec_lit = _vec_literal(vec)
                        cid = _resolve_layer3(cur, vec_lit, args.vector_max_distance)
                        if cid is not None:
                            decisions.append(
                                Decision(row.id, row.employer_name, row.employer_state, cid, "vector")
                            )
                            continue
                        # Miss → insert new canonical.
                        if args.dry_run:
                            # Synthesize a placeholder UUID so stats stay coherent.
                            from uuid import uuid4

                            cid = uuid4()
                        else:
                            cur.execute(
                                _INSERT_CANONICAL_SQL,
                                (
                                    row.employer_name,
                                    row.employer_fein,
                                    row.employer_city,
                                    row.employer_state,
                                ),
                            )
                            inserted = cur.fetchone()
                            cid = UUID(str(inserted[0]))
                            new_canonicals.append((str(cid), row.employer_name, vec))
                        decisions.append(
                            Decision(row.id, row.employer_name, row.employer_state, cid, "inserted")
                        )
                if not args.dry_run:
                    conn.commit()

            # Bulk-insert embeddings for the newly inserted canonicals.
            if new_canonicals and not args.dry_run:
                rows = [
                    (uuid_, _vec_literal(vec), model_short)
                    for uuid_, _, vec in new_canonicals
                ]
                with conn.cursor() as cur:
                    cur.executemany(_INSERT_EMBEDDING_SQL, rows)
                conn.commit()
                stats.new_embeddings += len(rows)
            stats.new_canonicals += len(new_canonicals)

            # Mark unresolved_employers resolved + backfill lca_records per decision.
            if not args.dry_run:
                with conn.cursor() as cur:
                    # Mark resolved (per-row UPDATE, but fast because of PK lookup).
                    cur.executemany(
                        _MARK_RESOLVED_SQL,
                        [(str(d.canonical_id), d.unresolved_id) for d in decisions],
                    )
                conn.commit()

                if not args.no_backfill:
                    chunk_backfilled = 0
                    counts_by_canonical: dict[str, int] = {}
                    with conn.cursor() as cur:
                        for d in decisions:
                            cur.execute(
                                _BACKFILL_LCA_SQL,
                                {
                                    "canonical": str(d.canonical_id),
                                    "name": d.employer_name,
                                    "state": d.employer_state,
                                },
                            )
                            n = cur.rowcount or 0
                            chunk_backfilled += n
                            if n:
                                counts_by_canonical[str(d.canonical_id)] = (
                                    counts_by_canonical.get(str(d.canonical_id), 0) + n
                                )
                    # Bump record_count once per canonical for accuracy.
                    if counts_by_canonical:
                        with conn.cursor() as cur:
                            cur.executemany(
                                _BUMP_RECORD_COUNT_SQL,
                                [(n, cid) for cid, n in counts_by_canonical.items()],
                            )
                    conn.commit()
                    stats.lca_rows_backfilled += chunk_backfilled

            # Stats / logging
            stats.seen += len(chunk)
            for d in decisions:
                stats.by_layer[d.source] = stats.by_layer.get(d.source, 0) + 1

            log.info(
                "backfill_full.progress",
                seen=stats.seen,
                fein=stats.by_layer["fein"],
                trgm=stats.by_layer["trgm"],
                vector=stats.by_layer["vector"],
                inserted=stats.by_layer["inserted"],
                lca_backfilled=stats.lca_rows_backfilled,
                elapsed=stats.elapsed(),
            )

            if args.dry_run:
                offset += len(raw)
            # When not dry-run, MARK_RESOLVED moves rows out of the
            # `resolved_at IS NULL` filter, so OFFSET=0 stays correct.
            if args.limit and stats.seen >= args.limit:
                break

    elapsed = stats.elapsed()
    print()
    print("=== Full-cascade backfill summary ===")
    print(f"  unresolved_employers processed : {stats.seen}")
    print(f"    Layer 1 (FEIN)              : {stats.by_layer['fein']}")
    print(f"    Layer 2 (pg_trgm)           : {stats.by_layer['trgm']}")
    print(f"    Layer 3 (pgvector)          : {stats.by_layer['vector']}")
    print(f"    Inserted (new canonical)    : {stats.by_layer['inserted']}")
    print(f"  new canonical_employers rows  : {stats.new_canonicals}")
    print(f"  new employer_embeddings rows  : {stats.new_embeddings}")
    print(f"  lca_records rows backfilled   : {stats.lca_rows_backfilled}")
    print(f"  elapsed                       : {elapsed}s")
    if args.dry_run:
        print("  NOTE: --dry-run was set; no writes were performed.")


if __name__ == "__main__":
    main()
