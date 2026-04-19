"""
Entity Resolution — Company Deduplication
==========================================
Deduplicates employer/company names across LCA records using the `dedupe` library
(probabilistic record linkage).

Workflow:
  1. Train a dedupe model on a labelled sample (or load a pre-trained settings file)
  2. Cluster raw company names into canonical entities
  3. Write canonical_id back to the database

Usage (CLI):
    dedup-companies --db postgresql://... --settings /app/models/company_dedup.settings
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Any

import structlog

log = structlog.get_logger(__name__)

# Type alias for a company record dict
CompanyRecord = dict[str, Any]


class CompanyDeduplicator:
    """
    Probabilistic company deduplication using dedupe.

    Stub implementation — the real training loop and clustering are
    implemented once the `dedupe` settings file (trained weights) is available.
    """

    def __init__(self, settings_path: str | Path | None = None) -> None:
        self.settings_path = Path(settings_path) if settings_path else None
        self._deduper = None
        log.info("entity_resolution.init", settings=str(self.settings_path))

    def load_or_train(self, records: list[CompanyRecord], sample_size: int = 15_000) -> None:
        """
        Load pre-trained dedupe settings or run active-learning training.

        In the backfill pipeline this is called once during setup; the resulting
        settings file is persisted and reused for incremental runs.
        """
        # TODO: implement with actual dedupe API
        # import dedupe
        # fields = [
        #     dedupe.variables.String("employer_name", has_missing=False),
        #     dedupe.variables.String("employer_city", has_missing=True),
        #     dedupe.variables.String("employer_state", has_missing=True),
        # ]
        # if self.settings_path and self.settings_path.exists():
        #     with open(self.settings_path, "rb") as f:
        #         self._deduper = dedupe.StaticDedupe(f)
        # else:
        #     self._deduper = dedupe.Dedupe(fields)
        #     self._deduper.prepare_training(records, sample_size=sample_size)
        log.warning("entity_resolution.stub_mode")

    def cluster(
        self, records: list[CompanyRecord], threshold: float = 0.5
    ) -> dict[str, str]:
        """
        Returns a mapping {record_id: canonical_cluster_id}.

        Stub: identity mapping until real model is wired in.
        """
        log.warning("entity_resolution.cluster_stub", n=len(records))
        return {str(r.get("id", i)): str(i) for i, r in enumerate(records)}

    def save_settings(self, path: str | Path) -> None:
        """Persist trained dedupe settings for future runs."""
        # TODO: self._deduper.write_settings(open(path, "wb"))
        log.info("entity_resolution.save_settings_stub", path=str(path))


def cli_main() -> None:
    parser = argparse.ArgumentParser(description="Deduplicate company names in LCA records")
    parser.add_argument("--db", default=os.environ.get("DATABASE_URL"), help="PostgreSQL DSN")
    parser.add_argument("--settings", help="Path to dedupe settings file")
    parser.add_argument("--threshold", type=float, default=0.5, help="Cluster threshold")
    args = parser.parse_args()

    dedup = CompanyDeduplicator(settings_path=args.settings)

    # TODO: load records from DB, run clustering, write canonical_id back
    log.info("entity_resolution.cli_stub", db=args.db, threshold=args.threshold)
    print("Entity resolution stub — implement DB load/write loop.")
