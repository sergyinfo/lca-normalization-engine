"""
SOC Code Classifier
===================
Classifies free-text job titles into Standard Occupational Classification (SOC)
codes using a two-stage pipeline:

  Stage 1 — DMTF exact match
      Query soc_aliases (populated by load-dmtf) for an exact case-insensitive
      title hit. Returns confidence=1.0. Fast, no model required.

  Stage 2 — BERT / zero-shot fallback
      Fine-tuned HuggingFace text-classification model. If confidence < 0.7
      the prediction is still returned but the caller should flag requires_review.

Usage (programmatic):
    classifier = SocClassifier.from_pretrained(
        model_path="/app/models/soc-bert",
        db_url="postgresql://...",
    )
    result = classifier.predict("Software Engineer III")
    # SocPrediction(code='15-1252', title='Software Developers', confidence=0.94)

Usage (CLI):
    classify-soc --model /app/models/soc-bert --input records.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence

import psycopg
import structlog

log = structlog.get_logger(__name__)


@dataclass(frozen=True, slots=True)
class SocPrediction:
    code: str
    title: str
    confidence: float


class SocClassifier:
    """Two-stage SOC classifier: DMTF exact match → BERT fallback."""

    def __init__(self, model_path: str | Path, db_url: Optional[str] = None) -> None:
        self.model_path = Path(model_path)
        self._db_url = db_url
        self._db_conn: Optional[psycopg.Connection] = None  # type: ignore[type-arg]
        self._pipeline = None
        log.info("soc_classifier.init", model_path=str(self.model_path), db_connected=db_url is not None)

    @classmethod
    def from_pretrained(
        cls,
        model_path: str | Path,
        db_url: Optional[str] = None,
    ) -> "SocClassifier":
        instance = cls(model_path, db_url=db_url)
        instance._connect_db()
        instance._load_model()
        return instance

    # ------------------------------------------------------------------
    # Initialisation helpers
    # ------------------------------------------------------------------

    def _connect_db(self) -> None:
        if not self._db_url:
            log.warning("soc_classifier.no_db_url", detail="Stage 1 DMTF lookup disabled")
            return
        try:
            self._db_conn = psycopg.connect(self._db_url, autocommit=True)
            log.info("soc_classifier.db_connected")
        except Exception:
            log.exception("soc_classifier.db_connect_failed", detail="Stage 1 disabled")

    def _load_model(self) -> None:
        if not self.model_path.exists():
            log.warning("soc_classifier.model_not_found", path=str(self.model_path))
            return
        try:
            import torch
            from transformers import pipeline as hf_pipeline

            device = 0 if torch.cuda.is_available() else -1
            self._pipeline = hf_pipeline(
                "text-classification",
                model=str(self.model_path),
                device=device,
            )
            log.info("soc_classifier.model_loaded", path=str(self.model_path), device=device)
        except Exception:
            log.exception("soc_classifier.model_load_failed")

    # ------------------------------------------------------------------
    # Stage 1 — DMTF exact match
    # ------------------------------------------------------------------

    def _lookup_dmtf(self, job_title: str) -> Optional[SocPrediction]:
        """Query soc_aliases for a case-insensitive exact match."""
        if self._db_conn is None:
            return None
        try:
            with self._db_conn.cursor() as cur:
                cur.execute(
                    "SELECT soc_code, soc_title FROM soc_aliases WHERE lower(job_title) = lower(%s) LIMIT 1",
                    (job_title,),
                )
                row = cur.fetchone()
            if row:
                return SocPrediction(code=row[0], title=row[1], confidence=1.0)
        except psycopg.OperationalError:
            # Reconnect once on stale connection
            log.warning("soc_classifier.db_reconnect")
            self._connect_db()
        return None

    # ------------------------------------------------------------------
    # Stage 2 — BERT model
    # ------------------------------------------------------------------

    def _predict_bert(self, job_title: str) -> SocPrediction:
        if self._pipeline is None:
            log.warning("soc_classifier.model_not_loaded", job_title=job_title)
            return SocPrediction(code="00-0000", title="UNCLASSIFIED", confidence=0.0)

        result = self._pipeline(job_title, top_k=1)[0]
        return SocPrediction(
            code=result["label"],
            title=result.get("title", ""),
            confidence=round(result["score"], 4),
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def predict(self, job_title: str) -> SocPrediction:
        """Classify a single job title. Stage 1 first, BERT fallback."""
        dmtf_hit = self._lookup_dmtf(job_title)
        if dmtf_hit is not None:
            log.debug("soc_classifier.dmtf_hit", job_title=job_title, code=dmtf_hit.code)
            return dmtf_hit

        log.debug("soc_classifier.dmtf_miss", job_title=job_title)
        return self._predict_bert(job_title)

    def predict_batch(self, job_titles: Sequence[str], batch_size: int = 64) -> list[SocPrediction]:
        """Classify a batch of job titles."""
        return [self.predict(t) for t in job_titles]

    def close(self) -> None:
        if self._db_conn is not None:
            self._db_conn.close()
            self._db_conn = None


def cli_main() -> None:
    parser = argparse.ArgumentParser(description="Classify job titles into SOC codes")
    parser.add_argument("--model", required=True, help="Path to fine-tuned SOC BERT model")
    parser.add_argument(
        "--db",
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL DSN for DMTF Stage 1 lookup (default: $DATABASE_URL)",
    )
    parser.add_argument("--input", default="-", help="JSONL input file (default: stdin)")
    parser.add_argument("--field", default="job_title", help="Field name in each JSON record")
    args = parser.parse_args()

    classifier = SocClassifier.from_pretrained(args.model, db_url=args.db)
    source = sys.stdin if args.input == "-" else open(args.input)

    try:
        for line in source:
            record = json.loads(line)
            job_title = record.get(args.field, "")
            prediction = classifier.predict(job_title)
            record["soc_code"] = prediction.code
            record["soc_title"] = prediction.title
            record["soc_confidence"] = prediction.confidence
            print(json.dumps(record))
    finally:
        classifier.close()
