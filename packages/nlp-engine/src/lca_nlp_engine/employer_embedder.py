"""
Employer name embedder
======================
Encodes `canonical_employers.canonical_name` into 384-dim sentence-transformer
vectors and stores them in `employer_embeddings`. This populates the index
used by Layer 3 entity resolution (pgvector HNSW cosine).

Idempotent: only embeds canonical_employers rows that don't already have a
matching `employer_embeddings.employer_id`. Re-running picks up newly inserted
canonicals.

CLI:
    DATABASE_URL=...  embed-employers --batch 256
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Iterable

import psycopg
import structlog

log = structlog.get_logger(__name__)


DEFAULT_MODEL = os.environ.get(
    "NLP_STAGE2_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
)


_FETCH_SQL = """
SELECT ce.id, ce.canonical_name
FROM canonical_employers ce
LEFT JOIN employer_embeddings ee ON ee.employer_id = ce.id
WHERE ee.employer_id IS NULL
ORDER BY ce.id
"""


_INSERT_SQL = """
INSERT INTO employer_embeddings (employer_id, embedding, model_version)
VALUES (%s, %s::vector, %s)
ON CONFLICT (employer_id) DO NOTHING
"""


def _vec_literal(v: Iterable[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Embed canonical_employers names into employer_embeddings (Layer 3 backfill)"
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL DSN (default: $DATABASE_URL)",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help="sentence-transformer model id")
    parser.add_argument("--batch", type=int, default=256, help="encode + insert batch size")
    parser.add_argument("--limit", type=int, default=0, help="stop after N rows (0 = all)")
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
    log.info("embedder.load_model", model=args.model, device=device)
    encoder = SentenceTransformer(args.model, device=device)

    started = time.time()
    n_seen = 0
    n_written = 0

    # Materialize the work list up-front. With ~20K canonicals * (UUID + name)
    # this is a few MB, far cheaper than juggling a server-side cursor across
    # commit boundaries.
    with psycopg.connect(args.db) as conn:
        with conn.cursor() as cur:
            cur.execute(_FETCH_SQL)
            todo = [
                (str(eid), name)
                for eid, name in cur.fetchall()
                if name and name.strip()
            ]

        if args.limit:
            todo = todo[: args.limit]

        log.info("embedder.todo", n=len(todo))
        model_short = args.model.rsplit("/", 1)[-1]

        for start in range(0, len(todo), args.batch):
            chunk = todo[start : start + args.batch]
            ids = [eid for eid, _ in chunk]
            names = [name for _, name in chunk]
            vecs = encoder.encode(
                names,
                batch_size=args.batch,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            rows = [
                (eid, _vec_literal(v), model_short)
                for eid, v in zip(ids, vecs)
            ]
            with conn.cursor() as wcur:
                wcur.executemany(_INSERT_SQL, rows)
            conn.commit()
            n_seen += len(chunk)
            n_written += len(rows)
            log.info(
                "embedder.progress",
                seen=n_seen,
                written=n_written,
                elapsed=int(time.time() - started),
            )

    elapsed = int(time.time() - started)
    print()
    print("=== Embedder Summary ===")
    print(f"  model     : {args.model}")
    print(f"  rows seen : {n_seen}")
    print(f"  embedded  : {n_written}")
    print(f"  elapsed   : {elapsed}s")


if __name__ == "__main__":
    main()
