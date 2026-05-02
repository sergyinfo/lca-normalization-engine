"""
SOC Code Classifier
===================
Classifies free-text job titles into Standard Occupational Classification (SOC)
codes using a two-stage pipeline:

  Stage 1 — DMTF exact match
      Query soc_aliases (populated by load-dmtf) for an exact case-insensitive
      title hit. Returns confidence=1.0. Fast, no model required.

  Stage 2 — Semantic retrieval (sentence-transformers)
      Embed all (job_title, soc_code) pairs from soc_aliases once at startup,
      then for each non-DMTF input compute cosine similarity and return the
      best-matching SOC code. Functionally equivalent to a zero-shot classifier
      but ~1000× faster on CPU because each record needs only one forward pass
      through a small encoder rather than an NLI pass per candidate label.

      Records below NLP_STAGE2_THRESHOLD (default 0.7) are still returned but
      the caller should set requires_review=True and route to quarantine.

Usage (programmatic):
    classifier = SocClassifier.from_pretrained(db_url="postgresql://...")
    result = classifier.predict("Software Engineer III")
    # SocPrediction(code='15-1252', title='Software Developers', confidence=0.94)

Usage (CLI):
    classify-soc --input records.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Sequence

import psycopg
import structlog

log = structlog.get_logger(__name__)

DEFAULT_STAGE2_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_STAGE2_THRESHOLD = 0.7
UNCLASSIFIED = "00-0000"


@dataclass(frozen=True, slots=True)
class SocPrediction:
    code: str
    title: str
    confidence: float


class SocClassifier:
    """Two-stage SOC classifier: DMTF exact match → semantic retrieval."""

    def __init__(
        self,
        db_url: Optional[str] = None,
        stage2_model: str = DEFAULT_STAGE2_MODEL,
        stage2_threshold: float = DEFAULT_STAGE2_THRESHOLD,
        model_path: Optional[str | Path] = None,
    ) -> None:
        self._db_url = db_url
        self._stage2_model_name = stage2_model
        self._stage2_threshold = stage2_threshold
        self._model_path = Path(model_path) if model_path else None  # legacy, unused
        self._db_conn: Optional[psycopg.Connection] = None  # type: ignore[type-arg]
        self._encoder: Any = None
        self._alias_codes: list[tuple[str, str]] = []
        self._alias_embeddings: Any = None
        log.info(
            "soc_classifier.init",
            db_connected=db_url is not None,
            stage2_model=stage2_model,
            stage2_threshold=stage2_threshold,
        )

    @classmethod
    def from_pretrained(
        cls,
        model_path: Optional[str | Path] = None,
        db_url: Optional[str] = None,
        stage2_model: str = DEFAULT_STAGE2_MODEL,
        stage2_threshold: float = DEFAULT_STAGE2_THRESHOLD,
    ) -> "SocClassifier":
        instance = cls(
            db_url=db_url,
            stage2_model=stage2_model,
            stage2_threshold=stage2_threshold,
            model_path=model_path,
        )
        instance._connect_db()
        instance._load_stage2()
        return instance

    # ------------------------------------------------------------------
    # Initialisation helpers
    # ------------------------------------------------------------------

    def _connect_db(self) -> None:
        if not self._db_url:
            log.warning("soc_classifier.no_db_url", detail="Stage 1 + Stage 2 disabled")
            return
        try:
            self._db_conn = psycopg.connect(self._db_url, autocommit=True)
            log.info("soc_classifier.db_connected")
        except Exception:
            log.exception("soc_classifier.db_connect_failed")

    def _load_stage2(self) -> None:
        """Load sentence-transformer and pre-compute alias embeddings."""
        if self._db_conn is None:
            log.warning("soc_classifier.stage2_skipped", reason="no db connection")
            return

        try:
            with self._db_conn.cursor() as cur:
                cur.execute(
                    "SELECT job_title, soc_code, soc_title FROM soc_aliases WHERE job_title IS NOT NULL AND length(trim(job_title)) > 0"
                )
                rows = cur.fetchall()
        except Exception:
            log.exception("soc_classifier.stage2_alias_fetch_failed")
            return

        if not rows:
            log.warning("soc_classifier.stage2_no_aliases", detail="run load-dmtf to populate soc_aliases")
            return

        try:
            from sentence_transformers import SentenceTransformer
        except Exception:
            log.exception("soc_classifier.stage2_import_failed")
            return

        device = os.environ.get("NLP_DEVICE", "cpu")
        try:
            self._encoder = SentenceTransformer(self._stage2_model_name, device=device)
        except Exception:
            log.exception("soc_classifier.stage2_model_load_failed", model=self._stage2_model_name)
            return

        titles = [r[0] for r in rows]
        self._alias_codes = [(r[1], r[2]) for r in rows]

        try:
            self._alias_embeddings = self._encoder.encode(
                titles,
                batch_size=128,
                convert_to_tensor=True,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            log.info(
                "soc_classifier.stage2_loaded",
                aliases=len(titles),
                model=self._stage2_model_name,
                device=device,
            )
        except Exception:
            log.exception("soc_classifier.stage2_encode_failed")
            self._encoder = None

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
            log.warning("soc_classifier.db_reconnect")
            self._connect_db()
        return None

    # ------------------------------------------------------------------
    # Stage 2 — Semantic retrieval via sentence-transformers
    # ------------------------------------------------------------------

    def _predict_stage2_batch(self, job_titles: Sequence[str]) -> list[SocPrediction]:
        """Embed inputs and pick the most similar alias by cosine similarity."""
        if not job_titles:
            return []
        if self._encoder is None or self._alias_embeddings is None:
            return [SocPrediction(UNCLASSIFIED, "UNCLASSIFIED", 0.0) for _ in job_titles]

        try:
            embs = self._encoder.encode(
                list(job_titles),
                batch_size=64,
                convert_to_tensor=True,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            # Normalised embeddings → dot product == cosine similarity
            sims = embs @ self._alias_embeddings.T  # (M, N)
            scores, indices = sims.max(dim=1)
            best_idx = indices.tolist()
            best_score = scores.tolist()
        except Exception:
            log.exception("soc_classifier.stage2_inference_failed", n=len(job_titles))
            return [SocPrediction(UNCLASSIFIED, "UNCLASSIFIED", 0.0) for _ in job_titles]

        out: list[SocPrediction] = []
        for idx, score in zip(best_idx, best_score):
            code, title = self._alias_codes[idx]
            out.append(SocPrediction(code=code, title=title, confidence=round(float(score), 4)))
        return out

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def predict(self, job_title: str) -> SocPrediction:
        """Classify a single job title. Stage 1 first, semantic retrieval fallback."""
        if not job_title or not job_title.strip():
            return SocPrediction(code=UNCLASSIFIED, title="UNCLASSIFIED", confidence=0.0)

        dmtf_hit = self._lookup_dmtf(job_title)
        if dmtf_hit is not None:
            log.debug("soc_classifier.dmtf_hit", job_title=job_title, code=dmtf_hit.code)
            return dmtf_hit

        log.debug("soc_classifier.dmtf_miss", job_title=job_title)
        return self._predict_stage2_batch([job_title])[0]

    def predict_batch(self, job_titles: Sequence[str]) -> list[SocPrediction]:
        """Classify a batch of job titles.

        Stage 1 runs as a per-record DB lookup (fast). All Stage 1 misses are
        then encoded together in a single Stage 2 batch — this is what makes
        the worker viable on CPU.
        """
        n = len(job_titles)
        out: list[Optional[SocPrediction]] = [None] * n
        miss_indices: list[int] = []
        miss_titles: list[str] = []

        for i, title in enumerate(job_titles):
            if not title or not title.strip():
                out[i] = SocPrediction(code=UNCLASSIFIED, title="UNCLASSIFIED", confidence=0.0)
                continue
            hit = self._lookup_dmtf(title)
            if hit is not None:
                out[i] = hit
            else:
                miss_indices.append(i)
                miss_titles.append(title)

        if miss_titles:
            stage2 = self._predict_stage2_batch(miss_titles)
            for idx, pred in zip(miss_indices, stage2):
                out[idx] = pred

        log.debug(
            "soc_classifier.batch_done",
            total=n,
            stage1_hits=n - len(miss_titles),
            stage2_hits=len(miss_titles),
        )
        return out  # type: ignore[return-value]

    def close(self) -> None:
        if self._db_conn is not None:
            self._db_conn.close()
            self._db_conn = None


def cli_main() -> None:
    parser = argparse.ArgumentParser(description="Classify job titles into SOC codes")
    parser.add_argument(
        "--db",
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL DSN for soc_aliases lookup (default: $DATABASE_URL)",
    )
    parser.add_argument(
        "--stage2-model",
        default=os.environ.get("NLP_STAGE2_MODEL", DEFAULT_STAGE2_MODEL),
        help="sentence-transformer model id for Stage 2",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=float(os.environ.get("NLP_STAGE2_THRESHOLD", DEFAULT_STAGE2_THRESHOLD)),
        help="Confidence cutoff for requires_review",
    )
    parser.add_argument("--input", default="-", help="JSONL input file (default: stdin)")
    parser.add_argument("--field", default="job_title", help="Field name in each JSON record")
    args = parser.parse_args()

    classifier = SocClassifier.from_pretrained(
        db_url=args.db,
        stage2_model=args.stage2_model,
        stage2_threshold=args.threshold,
    )
    source = sys.stdin if args.input == "-" else open(args.input)

    try:
        for line in source:
            record = json.loads(line)
            job_title = record.get(args.field, "")
            prediction = classifier.predict(job_title)
            record["soc_code"] = prediction.code
            record["soc_title"] = prediction.title
            record["soc_confidence"] = prediction.confidence
            record["requires_review"] = prediction.confidence < args.threshold
            print(json.dumps(record))
    finally:
        classifier.close()
