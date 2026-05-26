"""
Smoke test — auto-embed sweep
=============================
Validates the `CompanyDeduplicator.embed_pending` integration end-to-end:

  1. Inserts a sentinel canonical_employers row with a uniquely-named
     `canonical_name` (no FEIN, no record_count bump).
  2. Confirms it has no corresponding employer_embeddings row.
  3. Constructs a CompanyDeduplicator (no NLP worker boot, no Redis).
  4. Calls `embed_pending` and asserts:
       a. it returns >= 1 (we know we created exactly one pending row).
       b. employer_embeddings now has a row for the sentinel id.
       c. the stored vector has length 384 and a sane (non-zero) norm.
  5. Cleans up: deletes the embedding + the sentinel canonical.

Run:
    DATABASE_URL=... packages/nlp-engine/.venv/bin/python \\
        packages/nlp-engine/scripts/smoke_embed.py

Exits 0 on pass, 1 on any failure. Idempotent — safe to re-run.
"""
from __future__ import annotations

import os
import sys
import time
import uuid

import psycopg

from lca_nlp_engine.entity_resolution import CompanyDeduplicator


SENTINEL_PREFIX = "ZZZ_SMOKE_EMBED_"


def fail(msg: str) -> "None":
    print(f"FAIL  {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        fail("DATABASE_URL is required")

    sentinel_name = f"{SENTINEL_PREFIX}{uuid.uuid4().hex[:12].upper()}"
    sentinel_id: uuid.UUID | None = None
    t_start = time.time()

    # ---- 1. Insert the sentinel canonical -------------------------------
    print(f"▶ Inserting sentinel canonical: {sentinel_name}")
    with psycopg.connect(db_url) as setup, setup.cursor() as cur:
        # Belt-and-braces: nuke any stale sentinels from prior runs that
        # crashed before cleanup. Match by the prefix.
        cur.execute(
            "DELETE FROM employer_embeddings ee USING canonical_employers ce "
            "WHERE ee.employer_id = ce.id AND ce.canonical_name LIKE %s",
            (SENTINEL_PREFIX + "%",),
        )
        cur.execute(
            "DELETE FROM canonical_employers WHERE canonical_name LIKE %s",
            (SENTINEL_PREFIX + "%",),
        )

        cur.execute(
            """
            INSERT INTO canonical_employers (canonical_name, employer_state)
            VALUES (%s, %s)
            RETURNING id
            """,
            (sentinel_name, "ZZ"),
        )
        row = cur.fetchone()
        if row is None:
            fail("INSERT did not return id")
        sentinel_id = row[0]
        setup.commit()

        cur.execute(
            "SELECT 1 FROM employer_embeddings WHERE employer_id = %s",
            (sentinel_id,),
        )
        if cur.fetchone() is not None:
            fail("sentinel already has an embedding (cleanup bug)")
    print(f"  id = {sentinel_id}")

    # ---- 2. Run embed_pending via the new method ------------------------
    print("▶ Constructing CompanyDeduplicator (loads sentence-transformer)")
    dedup = CompanyDeduplicator(db_url=db_url)
    dedup.connect()

    print("▶ Calling embed_pending(max_rows=50)")
    t0 = time.time()
    written = dedup.embed_pending(max_rows=50, batch_size=32)
    print(f"  embed_pending returned: {written}  (took {time.time() - t0:.2f}s)")

    if written < 1:
        fail("embed_pending returned 0 — expected >= 1 (the sentinel)")

    # ---- 3. Verify the sentinel's vector landed -------------------------
    print("▶ Verifying sentinel vector in employer_embeddings")
    with psycopg.connect(db_url) as check, check.cursor() as cur:
        cur.execute(
            """
            SELECT embedding::text, model_version, vector_dims(embedding)
            FROM employer_embeddings WHERE employer_id = %s
            """,
            (sentinel_id,),
        )
        row = cur.fetchone()
        if row is None:
            fail("no embedding row for sentinel id after embed_pending")
        vec_text, model_version, dims = row
        print(f"  model_version = {model_version}")
        print(f"  vector_dims   = {dims}")

        if dims != 384:
            fail(f"expected 384 dims, got {dims}")

        # Crude norm check — pgvector stores floats; the encoder normalises,
        # so ||v|| should be ~1.0.
        floats = [float(x) for x in vec_text.strip("[]").split(",")]
        norm = sum(x * x for x in floats) ** 0.5
        print(f"  ||v||         = {norm:.4f}")
        if not (0.95 <= norm <= 1.05):
            fail(f"vector norm {norm:.4f} outside [0.95, 1.05] — encoder not normalising?")

    # ---- 4. Cleanup ------------------------------------------------------
    print("▶ Cleaning up sentinel row + embedding")
    with psycopg.connect(db_url) as teardown, teardown.cursor() as cur:
        cur.execute(
            "DELETE FROM employer_embeddings WHERE employer_id = %s",
            (sentinel_id,),
        )
        cur.execute(
            "DELETE FROM canonical_employers WHERE id = %s",
            (sentinel_id,),
        )
        teardown.commit()

    dedup.close()
    elapsed = time.time() - t_start
    print(f"\nPASS  embed_pending smoke test ({elapsed:.1f}s total)")


if __name__ == "__main__":
    main()
