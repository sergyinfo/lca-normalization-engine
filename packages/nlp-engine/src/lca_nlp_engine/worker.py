"""
NLP Worker — BullMQ-compatible Redis queue consumer
=====================================================
Polls a Redis list for NLP classification tasks enqueued by the ingestor,
runs SOC classification + entity resolution, and writes results back to PostgreSQL.

Queue protocol (compatible with BullMQ v4 job data format):
  Job name  : "nlp:classify"
  Job data  : { "batch_id": str, "records": [{ "id": int, "job_title": str, ... }] }

Entry point: `nlp-worker` (see pyproject.toml [project.scripts])
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys

import redis.asyncio as aioredis
import structlog

from lca_nlp_engine.soc_classifier import SocClassifier, SocPrediction
from lca_nlp_engine.entity_resolution import CompanyDeduplicator

log = structlog.get_logger(__name__)

QUEUE_KEY = "bull:nlp-tasks:wait"
PROCESSING_KEY = "bull:nlp-tasks:active"


class NlpWorker:
    def __init__(
        self,
        redis_url: str,
        model_path: str,
        concurrency: int = 2,
    ) -> None:
        self.redis_url = redis_url
        self.concurrency = concurrency
        self.classifier = SocClassifier.from_pretrained(model_path)
        self.deduplicator = CompanyDeduplicator()
        self._running = True

    async def run(self) -> None:
        redis = await aioredis.from_url(self.redis_url, decode_responses=True)
        log.info("nlp_worker.started", concurrency=self.concurrency, queue=QUEUE_KEY)

        sem = asyncio.Semaphore(self.concurrency)

        async def process_one() -> None:
            async with sem:
                # BRPOPLPUSH — atomically move job to active list
                job_str = await redis.brpoplpush(QUEUE_KEY, PROCESSING_KEY, timeout=5)
                if not job_str:
                    return
                try:
                    job = json.loads(job_str)
                    await self._handle_job(redis, job)
                except Exception:
                    log.exception("nlp_worker.job_failed", job=job_str[:200])
                finally:
                    await redis.lrem(PROCESSING_KEY, 1, job_str)

        while self._running:
            await asyncio.gather(*[process_one() for _ in range(self.concurrency)])

        await redis.aclose()

    async def _handle_job(self, redis: aioredis.Redis, job: dict) -> None:
        batch_id = job.get("batch_id", "?")
        records = job.get("records", [])
        log.info("nlp_worker.processing", batch_id=batch_id, n=len(records))

        job_titles = [r.get("job_title", "") for r in records]
        predictions: list[SocPrediction] = self.classifier.predict_batch(job_titles)

        results = [
            {"id": r["id"], "soc_code": p.code, "soc_confidence": p.confidence}
            for r, p in zip(records, predictions)
        ]

        # Publish results back to a results stream for the ingestor to consume
        await redis.xadd(
            "lca:nlp-results",
            {"batch_id": batch_id, "results": json.dumps(results)},
        )
        log.info("nlp_worker.batch_done", batch_id=batch_id)

    def stop(self) -> None:
        self._running = False


def main() -> None:
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    model_path = os.environ.get("NLP_MODEL_PATH", "/app/models/soc-bert")
    concurrency = int(os.environ.get("NLP_WORKER_CONCURRENCY", "2"))

    worker = NlpWorker(redis_url=redis_url, model_path=model_path, concurrency=concurrency)

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
