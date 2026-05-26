"""
Entity Resolution — Company Deduplication
==========================================
Resolves employer identity across LCA records using a three-layer pipeline.
Each layer is applied in order; the first match wins.

  Layer 1 — Deterministic (FEIN)
  Layer 2 — Probabilistic (pg_trgm trigram similarity, blocked by state)
  Layer 3 — Semantic (pgvector HNSW cosine on canonical_name embeddings)

Usage (CLI):
    dedup-companies --db postgresql://... --settings /app/models/company_dedup.settings
"""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path
from typing import Any, Optional
from uuid import UUID

import psycopg
import structlog

log = structlog.get_logger(__name__)

CompanyRecord = dict[str, Any]

_FEIN_RE = re.compile(r"^\d{2}-\d{7}$")


class CompanyDeduplicator:
    """
    Three-layer employer deduplication.

    Layer 1 (FEIN) is fully implemented.
    Layers 2 and 3 are stubs pending pg_trgm / pgvector query implementation.
    """

    def __init__(
        self,
        db_url: Optional[str] = None,
        settings_path: Optional[str | Path] = None,
        encoder: Any = None,
    ) -> None:
        self._db_url = db_url
        self.settings_path = Path(settings_path) if settings_path else None
        self._db_conn: Optional[psycopg.Connection] = None  # type: ignore[type-arg]
        # Sentence-transformer for Layer 3. Inject from the worker so we don't
        # load the model twice when the SocClassifier already has it.
        self._encoder: Any = encoder
        log.info(
            "entity_resolution.init",
            db_connected=db_url is not None,
            encoder=encoder is not None,
        )

    def connect(self) -> None:
        if not self._db_url:
            log.warning("entity_resolution.no_db_url", detail="Layer 1 FEIN resolution disabled")
            return
        try:
            self._db_conn = psycopg.connect(self._db_url)
            log.info("entity_resolution.db_connected")
        except Exception:
            log.exception("entity_resolution.db_connect_failed")

    def close(self) -> None:
        if self._db_conn is not None:
            self._db_conn.close()
            self._db_conn = None

    # ------------------------------------------------------------------
    # Layer 1 — Deterministic FEIN match
    # ------------------------------------------------------------------

    def resolve_fein(
        self,
        employer_name: str,
        fein: Optional[str],
        employer_city: Optional[str] = None,
        employer_state: Optional[str] = None,
    ) -> Optional[UUID]:
        """
        Upsert into canonical_employers by FEIN and return the canonical UUID.

        Returns None when:
          - FEIN is missing or invalid
          - DB connection is unavailable
        """
        if not fein or not _FEIN_RE.match(fein):
            return None
        if self._db_conn is None:
            log.warning("entity_resolution.no_connection", fein=fein)
            return None

        try:
            with self._db_conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM canonical_employers WHERE fein = %s",
                    (fein,),
                )
                row = cur.fetchone()
                if row:
                    cur.execute(
                        """
                        UPDATE canonical_employers
                        SET record_count = record_count + 1,
                            updated_at   = NOW()
                        WHERE id = %s
                        """,
                        (row[0],),
                    )
                    self._db_conn.commit()
                    return UUID(str(row[0]))

                cur.execute(
                    """
                    INSERT INTO canonical_employers
                        (canonical_name, fein, employer_city, employer_state)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id
                    """,
                    (employer_name, fein, employer_city, employer_state),
                )
                row = cur.fetchone()
            self._db_conn.commit()
            return UUID(str(row[0])) if row else None
        except psycopg.OperationalError:
            log.warning("entity_resolution.db_reconnect")
            self._db_conn.rollback()
            self.connect()
            return None
        except Exception:
            log.exception("entity_resolution.resolve_fein_failed", fein=fein)
            self._db_conn.rollback()
            return None

    # ------------------------------------------------------------------
    # Layer 2 — Probabilistic (pg_trgm)
    # ------------------------------------------------------------------

    # GIN trigram filter (`canonical_name %% %s`) handles recall via the
    # idx_canonical_employers_name_trgm index; the ORDER BY similarity + Python
    # threshold check is the precision gate. State blocking keeps each query
    # bounded to that state's slice of canonical_employers (~50–2000 rows).
    _TRGM_SQL = """
        SELECT id, similarity(canonical_name, %(name)s) AS sim
        FROM canonical_employers
        WHERE canonical_name %% %(name)s
          AND (%(state)s::char(2) IS NULL OR employer_state = %(state)s)
        ORDER BY sim DESC
        LIMIT 1
    """

    def resolve_trgm(
        self,
        employer_name: str,
        employer_state: Optional[str] = None,
        threshold: float = 0.85,
    ) -> Optional[UUID]:
        """Layer 2: trigram similarity match against FEIN-anchored canonicals.

        Returns the canonical UUID when the closest match has similarity >=
        `threshold`; otherwise None. Bumps record_count on accept so the
        canonical reflects the additional filing.
        """
        if not employer_name or self._db_conn is None:
            return None
        try:
            with self._db_conn.cursor() as cur:
                cur.execute(
                    self._TRGM_SQL,
                    {"name": employer_name, "state": employer_state},
                )
                row = cur.fetchone()
                if not row:
                    return None
                cid, sim = row
                if sim < threshold:
                    return None
                cur.execute(
                    """
                    UPDATE canonical_employers
                    SET record_count = record_count + 1,
                        updated_at   = NOW()
                    WHERE id = %s
                    """,
                    (cid,),
                )
            self._db_conn.commit()
            log.debug(
                "entity_resolution.trgm_match",
                employer_name=employer_name,
                state=employer_state,
                sim=float(sim),
            )
            return UUID(str(cid))
        except psycopg.OperationalError:
            log.warning("entity_resolution.db_reconnect", layer="trgm")
            self._db_conn.rollback()
            self.connect()
            return None
        except Exception:
            log.exception("entity_resolution.resolve_trgm_failed", employer_name=employer_name)
            self._db_conn.rollback()
            return None

    # ------------------------------------------------------------------
    # Layer 3 — Semantic (pgvector HNSW)
    # ------------------------------------------------------------------

    _VECTOR_SQL = """
        SELECT employer_id, embedding <=> %s::vector AS dist
        FROM employer_embeddings
        ORDER BY embedding <=> %s::vector
        LIMIT 1
    """

    def _ensure_encoder(self) -> Any:
        """Load the sentence-transformer on demand (lazy)."""
        if self._encoder is not None:
            return self._encoder
        try:
            from sentence_transformers import SentenceTransformer
        except Exception:
            log.exception("entity_resolution.vector_import_failed")
            return None
        model = os.environ.get(
            "NLP_STAGE2_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
        )
        device = os.environ.get("NLP_DEVICE", "cpu")
        try:
            self._encoder = SentenceTransformer(model, device=device)
            log.info("entity_resolution.vector_encoder_loaded", model=model, device=device)
        except Exception:
            log.exception("entity_resolution.vector_encoder_failed", model=model)
            self._encoder = None
        return self._encoder

    def resolve_vector(
        self,
        employer_name: str,
        max_distance: float = 0.15,
    ) -> Optional[UUID]:
        """Layer 3: nearest-neighbour cosine match against employer_embeddings.

        Returns the canonical UUID when the closest match has cosine distance
        <= `max_distance` (default 0.15 ≈ cosine similarity 0.85). Bumps
        record_count on accept.
        """
        if not employer_name or self._db_conn is None:
            return None
        encoder = self._ensure_encoder()
        if encoder is None:
            return None
        try:
            vec = encoder.encode(
                [employer_name],
                normalize_embeddings=True,
                show_progress_bar=False,
            )[0]
            vec_lit = "[" + ",".join(f"{x:.6f}" for x in vec) + "]"
            with self._db_conn.cursor() as cur:
                cur.execute(self._VECTOR_SQL, (vec_lit, vec_lit))
                row = cur.fetchone()
                if not row:
                    return None
                cid, dist = row
                if dist > max_distance:
                    return None
                cur.execute(
                    """
                    UPDATE canonical_employers
                    SET record_count = record_count + 1,
                        updated_at   = NOW()
                    WHERE id = %s
                    """,
                    (cid,),
                )
            self._db_conn.commit()
            log.debug(
                "entity_resolution.vector_match",
                employer_name=employer_name,
                dist=float(dist),
            )
            return UUID(str(cid))
        except psycopg.OperationalError:
            log.warning("entity_resolution.db_reconnect", layer="vector")
            self._db_conn.rollback()
            self.connect()
            return None
        except Exception:
            log.exception("entity_resolution.resolve_vector_failed", employer_name=employer_name)
            self._db_conn.rollback()
            return None

    # ------------------------------------------------------------------
    # Combined resolution (tries all layers in order)
    # ------------------------------------------------------------------

    def resolve(
        self,
        employer_name: str,
        fein: Optional[str] = None,
        employer_city: Optional[str] = None,
        employer_state: Optional[str] = None,
    ) -> Optional[UUID]:
        """Apply all layers in order; return the first match."""
        return (
            self.resolve_fein(employer_name, fein, employer_city, employer_state)
            or self.resolve_trgm(employer_name, employer_state)
            or self.resolve_vector(employer_name)
        )

    # ------------------------------------------------------------------
    # Incremental embedding sweep (used by NLP worker post-batch)
    # ------------------------------------------------------------------

    # Mirrors the `embed-employers` CLI but reuses the worker's in-memory
    # encoder so we don't pay the model-load cost on every batch. Idempotent:
    # the LEFT JOIN + ON CONFLICT keep concurrent or repeated runs safe.
    _EMBED_FETCH_SQL = """
        SELECT ce.id, ce.canonical_name
        FROM canonical_employers ce
        LEFT JOIN employer_embeddings ee ON ee.employer_id = ce.id
        WHERE ee.employer_id IS NULL
          AND ce.canonical_name IS NOT NULL
          AND length(btrim(ce.canonical_name)) > 0
        ORDER BY ce.id
        LIMIT %s
    """

    _EMBED_INSERT_SQL = """
        INSERT INTO employer_embeddings (employer_id, embedding, model_version)
        VALUES (%s, %s::vector, %s)
        ON CONFLICT (employer_id) DO NOTHING
    """

    # 64-bit int — ascii "LCAEMBED". Globally unique to this sweep so it never
    # collides with other code that might also take advisory locks.
    _EMBED_ADVISORY_LOCK_KEY = 0x4C4341454D424544

    def embed_pending(
        self,
        max_rows: int = 1000,
        batch_size: int = 256,
    ) -> int:
        """Embed any canonical_employers that don't yet have a vector.

        Returns the number of rows newly embedded. Safe to call after every
        NLP batch — when there's nothing to embed the SELECT returns 0 rows
        and the call is effectively a no-op.

        Concurrent workers: protected by a non-blocking Postgres advisory
        lock. If another worker is already sweeping, this call returns 0
        instead of blocking or double-encoding.
        """
        if self._db_conn is None:
            return 0
        encoder = self._ensure_encoder()
        if encoder is None:
            return 0

        try:
            with self._db_conn.cursor() as cur:
                cur.execute(
                    "SELECT pg_try_advisory_lock(%s)",
                    (self._EMBED_ADVISORY_LOCK_KEY,),
                )
                got_lock = cur.fetchone()[0]
                if not got_lock:
                    self._db_conn.commit()
                    return 0

                try:
                    cur.execute(self._EMBED_FETCH_SQL, (max_rows,))
                    todo = [
                        (str(eid), name)
                        for eid, name in cur.fetchall()
                        if name and name.strip()
                    ]
                    if not todo:
                        return 0

                    model = os.environ.get(
                        "NLP_STAGE2_MODEL",
                        "sentence-transformers/all-MiniLM-L6-v2",
                    )
                    model_short = model.rsplit("/", 1)[-1]

                    n_written = 0
                    for start in range(0, len(todo), batch_size):
                        chunk = todo[start : start + batch_size]
                        ids = [eid for eid, _ in chunk]
                        names = [name for _, name in chunk]
                        vecs = encoder.encode(
                            names,
                            batch_size=batch_size,
                            normalize_embeddings=True,
                            show_progress_bar=False,
                        )
                        rows = [
                            (
                                eid,
                                "[" + ",".join(f"{x:.6f}" for x in v) + "]",
                                model_short,
                            )
                            for eid, v in zip(ids, vecs)
                        ]
                        cur.executemany(self._EMBED_INSERT_SQL, rows)
                        n_written += len(rows)

                    log.info(
                        "entity_resolution.embed_pending",
                        written=n_written,
                        model=model_short,
                    )
                    return n_written
                finally:
                    cur.execute(
                        "SELECT pg_advisory_unlock(%s)",
                        (self._EMBED_ADVISORY_LOCK_KEY,),
                    )
                    self._db_conn.commit()
        except psycopg.OperationalError:
            log.warning("entity_resolution.db_reconnect", layer="embed_pending")
            try:
                self._db_conn.rollback()
            except Exception:
                pass
            self.connect()
            return 0
        except Exception:
            log.exception("entity_resolution.embed_pending_failed")
            try:
                self._db_conn.rollback()
            except Exception:
                pass
            return 0

    # ------------------------------------------------------------------
    # Legacy batch API (kept for CLI compat)
    # ------------------------------------------------------------------

    def cluster(
        self, records: list[CompanyRecord], threshold: float = 0.5
    ) -> dict[str, str]:
        """Returns {record_id: canonical_cluster_id}. Layers 2/3 stub."""
        log.warning("entity_resolution.cluster_stub", n=len(records))
        return {str(r.get("id", i)): str(i) for i, r in enumerate(records)}


def cli_main() -> None:
    parser = argparse.ArgumentParser(description="Deduplicate company names in LCA records")
    parser.add_argument("--db", default=os.environ.get("DATABASE_URL"), help="PostgreSQL DSN")
    parser.add_argument("--settings", help="Path to dedupe settings file (Layers 2/3)")
    parser.add_argument("--threshold", type=float, default=0.85, help="pg_trgm similarity threshold")
    args = parser.parse_args()

    dedup = CompanyDeduplicator(db_url=args.db, settings_path=args.settings)
    dedup.connect()
    log.info("entity_resolution.cli", db=args.db, threshold=args.threshold)
    print("Entity resolution: Layer 1 (FEIN) active. Layers 2/3 (pg_trgm, pgvector) are stubs.")
    dedup.close()
