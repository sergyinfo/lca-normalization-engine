"""
Entity Resolution — Company Deduplication
==========================================
Resolves employer identity across LCA records using a three-layer pipeline.
Each layer is applied in order; the first match wins.

  Layer 1 — Deterministic (FEIN)      ✅ implemented
  Layer 2 — Probabilistic (pg_trgm)   stub
  Layer 3 — Semantic (pgvector HNSW)  stub

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
    ) -> None:
        self._db_url = db_url
        self.settings_path = Path(settings_path) if settings_path else None
        self._db_conn: Optional[psycopg.Connection] = None  # type: ignore[type-arg]
        log.info("entity_resolution.init", db_connected=db_url is not None)

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
    # Layer 2 — Probabilistic (pg_trgm) — stub
    # ------------------------------------------------------------------

    def resolve_trgm(
        self,
        employer_name: str,
        employer_state: Optional[str] = None,
        threshold: float = 0.85,
    ) -> Optional[UUID]:
        """Layer 2: trigram similarity match. Not yet implemented."""
        log.debug("entity_resolution.trgm_stub", employer_name=employer_name)
        return None

    # ------------------------------------------------------------------
    # Layer 3 — Semantic (pgvector) — stub
    # ------------------------------------------------------------------

    def resolve_vector(
        self,
        employer_name: str,
        max_distance: float = 0.15,
    ) -> Optional[UUID]:
        """Layer 3: vector embedding similarity. Not yet implemented."""
        log.debug("entity_resolution.vector_stub", employer_name=employer_name)
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
