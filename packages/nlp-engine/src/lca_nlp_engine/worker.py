"""
NLP Worker — BullMQ-compatible Redis queue consumer
=====================================================
Polls Redis for NLP classification tasks enqueued by the ingestor, runs
SOC classification + entity resolution, and writes results back to PostgreSQL.

Pipeline per batch:
  1. Validate payload (Pydantic)
  2. Stage 1 SOC classification (DMTF exact match)
  3. Stage 2 SOC classification (BERT fallback — stub)
  4. Layer 1 entity resolution (FEIN)
  5. Write classified records back to lca_records
  6. Route low-confidence records to staging.quarantine_records

Queue protocol (BullMQ v4):
  Job name : "nlp:classify"
  Job data : { "batch_id": str, "records": [RecordItem, ...] }

Entry point: `nlp-worker` (see pyproject.toml [project.scripts])
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
from datetime import datetime, timezone
from typing import Optional

import psycopg
import redis.asyncio as aioredis
import structlog
from pydantic import ValidationError

from lca_nlp_engine.models import NlpJobPayload, RecordItem, SocResult
from lca_nlp_engine.soc_classifier import (
    DEFAULT_STAGE2_MODEL,
    DEFAULT_STAGE2_THRESHOLD,
    SocClassifier,
    SocPrediction,
)
from lca_nlp_engine.entity_resolution import CompanyDeduplicator

log = structlog.get_logger(__name__)

QUEUE_KEY = "bull:nlp-tasks:wait"
PROCESSING_KEY = "bull:nlp-tasks:active"


class NlpWorker:
    def __init__(
        self,
        redis_url: str,
        db_url: str,
        concurrency: int = 2,
        stage2_model: str = DEFAULT_STAGE2_MODEL,
        stage2_threshold: float = DEFAULT_STAGE2_THRESHOLD,
    ) -> None:
        self.redis_url = redis_url
        self._db_url = db_url
        self.concurrency = concurrency
        self._stage2_threshold = stage2_threshold
        self.classifier = SocClassifier.from_pretrained(
            db_url=db_url,
            stage2_model=stage2_model,
            stage2_threshold=stage2_threshold,
        )
        self.deduplicator = CompanyDeduplicator(db_url=db_url)
        self.deduplicator.connect()
        self._db_conn: Optional[psycopg.Connection] = None  # type: ignore[type-arg]
        self._running = True

    def _connect_db(self) -> None:
        try:
            self._db_conn = psycopg.connect(self._db_url)
            log.info("nlp_worker.db_connected")
        except Exception:
            log.exception("nlp_worker.db_connect_failed")

    async def run(self) -> None:
        self._connect_db()
        redis = await aioredis.from_url(self.redis_url, decode_responses=True)
        log.info("nlp_worker.started", concurrency=self.concurrency, queue=QUEUE_KEY)

        sem = asyncio.Semaphore(self.concurrency)

        async def process_one() -> None:
            async with sem:
                job_id = await redis.brpoplpush(QUEUE_KEY, PROCESSING_KEY, timeout=5)
                if not job_id:
                    return
                try:
                    job_data_str = await redis.hget(f"bull:nlp-tasks:{job_id}", "data")
                    if not job_data_str:
                        log.warning("nlp_worker.missing_job_data", job_id=job_id)
                        return
                    job = json.loads(job_data_str)
                    await self._handle_job(job)
                except Exception:
                    log.exception("nlp_worker.job_failed", job_id=job_id)
                finally:
                    await redis.lrem(PROCESSING_KEY, 1, job_id)

        while self._running:
            await asyncio.gather(*[process_one() for _ in range(self.concurrency)])

        await redis.aclose()
        if self._db_conn:
            self._db_conn.close()

    async def _handle_job(self, job: dict) -> None:
        try:
            payload = NlpJobPayload.model_validate(job)
        except ValidationError as exc:
            log.error("nlp_worker.invalid_payload", errors=exc.errors())
            return

        batch_id = payload.batch_id
        log.info("nlp_worker.processing", batch_id=batch_id, n=len(payload.records))

        # SOC classification (Stage 0 employer consensus → Stage 1 DMTF → Stage 2 retrieval)
        job_titles = [r.job_title for r in payload.records]
        feins = [r.fein for r in payload.records]
        predictions: list[SocPrediction] = self.classifier.predict_batch(job_titles, feins=feins)

        # Entity resolution + build results
        results: list[tuple[SocResult, str]] = []  # (result, job_title) — job_title kept for quarantine context
        for record, prediction in zip(payload.records, predictions):
            canonical_id = self.deduplicator.resolve(
                employer_name=record.employer_name,
                fein=record.fein,
                employer_city=record.employer_city,
                employer_state=record.employer_state,
            )
            requires_review = prediction.confidence < self._stage2_threshold
            review_reason = "low_soc_confidence" if requires_review else None
            results.append((SocResult(
                nlp_id=record.nlp_id,
                filing_year=record.filing_year,
                soc_code=prediction.code,
                soc_title=prediction.title,
                soc_confidence=prediction.confidence,
                soc_source=prediction.source,
                requires_review=requires_review,
                review_reason=review_reason,
                canonical_employer_id=canonical_id,
                employer_name=record.employer_name,
                employer_state=record.employer_state,
            ), record.job_title))

        self._write_results(results)

        classified = sum(1 for r, _ in results if not r.requires_review)
        quarantined = sum(1 for r, _ in results if r.requires_review)
        log.info(
            "nlp_worker.batch_done",
            batch_id=batch_id,
            classified=classified,
            quarantined=quarantined,
        )

    def _write_results(self, results: list[tuple[SocResult, str]]) -> None:
        if self._db_conn is None:
            log.error("nlp_worker.write_skipped", reason="no db connection")
            return

        classified = [(r, t) for r, t in results if not r.requires_review]
        quarantined = [(r, t) for r, t in results if r.requires_review]

        try:
            with self._db_conn.cursor() as cur:
                if classified:
                    now = datetime.now(timezone.utc).isoformat()
                    cur.executemany(
                        """
                        UPDATE lca_records
                        SET data = data || %s::jsonb
                        WHERE data->>'_nlp_id' = %s
                          AND filing_year = %s
                        """,
                        [
                            (
                                json.dumps({
                                    "soc_code": r.soc_code,
                                    "soc_title": r.soc_title,
                                    "soc_confidence": r.soc_confidence,
                                    "soc_source": r.soc_source,
                                    "canonical_employer_id": str(r.canonical_employer_id) if r.canonical_employer_id else None,
                                    "nlp_processed_at": now,
                                }),
                                r.nlp_id,
                                r.filing_year,
                            )
                            for r, _ in classified
                        ],
                    )

                if quarantined:
                    cur.executemany(
                        """
                        INSERT INTO staging.quarantine_records
                            (filing_year, raw_data, errors)
                        VALUES (%s, %s::jsonb, %s::jsonb)
                        """,
                        [
                            (
                                r.filing_year,
                                json.dumps({
                                    "_nlp_id": r.nlp_id,
                                    "job_title": title,
                                    "employer_name": r.employer_name,
                                    "employer_state": r.employer_state,
                                    "soc_code": r.soc_code,
                                }),
                                json.dumps({
                                    "type": "low_soc_confidence",
                                    "soc_code": r.soc_code,
                                    "soc_confidence": r.soc_confidence,
                                }),
                            )
                            for r, title in quarantined
                        ],
                    )

            self._db_conn.commit()

        except psycopg.OperationalError:
            log.warning("nlp_worker.db_reconnect")
            self._db_conn.rollback()
            self._connect_db()
        except Exception:
            log.exception("nlp_worker.write_failed")
            self._db_conn.rollback()

    def stop(self) -> None:
        self._running = False


def main() -> None:
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    db_url = os.environ.get("DATABASE_URL", "")
    concurrency = int(os.environ.get("NLP_WORKER_CONCURRENCY", "2"))
    stage2_model = os.environ.get("NLP_STAGE2_MODEL", DEFAULT_STAGE2_MODEL)
    stage2_threshold = float(os.environ.get("NLP_STAGE2_THRESHOLD", DEFAULT_STAGE2_THRESHOLD))

    worker = NlpWorker(
        redis_url=redis_url,
        db_url=db_url,
        concurrency=concurrency,
        stage2_model=stage2_model,
        stage2_threshold=stage2_threshold,
    )

    loop = asyncio.get_event_loop()

    def _shutdown(*_: object) -> None:
        log.info("nlp_worker.shutdown_signal")
        worker.stop()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    try:
        loop.run_until_complete(worker.run())
    finally:
        loop.close()
        log.info("nlp_worker.stopped")
        sys.exit(0)
