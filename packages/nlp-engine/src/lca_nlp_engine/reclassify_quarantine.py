"""
Quarantine reclassifier (Stage 3 — LLM-on-residual)
====================================================
Drains `staging.quarantine_records` by feeding each title's top-K Stage 2
retrieval candidates to an LLM and asking it to pick the best one.

Policy
------
- Only records flagged `errors->>'type' = 'low_soc_confidence'` are processed.
- For each, JOB_TITLE is recovered by joining `lca_records` on `_nlp_id`.
- Stage 2 retrieval supplies up to --top-k candidates (deduped by SOC code).
- LLM picks one. If the LLM marks the choice `confident`, we:
    * UPDATE lca_records to set the new soc_code / soc_title / soc_confidence
      (confidence stamped from the original retrieval score of the chosen
      candidate, plus a `llm_reclassified` audit flag).
    * DELETE the row from staging.quarantine_records.
  Otherwise the row stays in quarantine for human review.
- Idempotent: re-running picks up only rows still in quarantine.

CLI:
    DATABASE_URL=...  reclassify-quarantine \\
        --top-k 10 --batch 100 --limit 0
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Optional

import psycopg
import structlog

from lca_nlp_engine.llm_classifier import (
    AnthropicBackend,
    LlmClassifier,
    OllamaBackend,
    make_default_backend,
)
from lca_nlp_engine.soc_classifier import SocClassifier

log = structlog.get_logger(__name__)


_FETCH_SQL = """
SELECT
    q.id                             AS quarantine_id,
    q.filing_year                    AS filing_year,
    q.raw_data->>'_nlp_id'           AS nlp_id,
    lr.data->>'JOB_TITLE'            AS job_title,
    q.raw_data->>'employer_name'     AS employer_name,
    q.raw_data->>'employer_state'    AS employer_state,
    (q.errors->>'soc_confidence')::float AS prior_confidence
FROM staging.quarantine_records q
LEFT JOIN lca_records lr
       ON lr.data->>'_nlp_id' = q.raw_data->>'_nlp_id'
      AND lr.filing_year     = q.filing_year
WHERE q.errors->>'type' = 'low_soc_confidence'
  AND lr.data->>'JOB_TITLE' IS NOT NULL
  AND length(trim(lr.data->>'JOB_TITLE')) > 0
  AND q.id > %s
ORDER BY q.id
LIMIT %s;
"""


_UPDATE_SQL = """
UPDATE lca_records
SET data = data || %s::jsonb
WHERE data->>'_nlp_id' = %s
  AND filing_year = %s
"""

_DELETE_SQL = """
DELETE FROM staging.quarantine_records WHERE id = %s
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Drain quarantine via LLM-on-residual classification")
    parser.add_argument(
        "--db",
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL DSN (default: $DATABASE_URL)",
    )
    parser.add_argument("--top-k", type=int, default=10, help="Stage 2 candidates to show LLM")
    parser.add_argument("--batch", type=int, default=200, help="Rows per fetch batch")
    parser.add_argument("--limit", type=int, default=0, help="Stop after this many rows (0 = all)")
    parser.add_argument(
        "--backend",
        choices=("auto", "ollama", "anthropic"),
        default="auto",
        help="auto picks Anthropic if ANTHROPIC_API_KEY else Ollama",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run LLM and print decisions but do not write back",
    )
    args = parser.parse_args()

    if not args.db:
        print("ERROR: DATABASE_URL is required", file=sys.stderr)
        sys.exit(2)

    if args.backend == "ollama":
        backend = OllamaBackend(
            model=os.environ.get("LLM_MODEL", "llama3.1:8b"),
            host=os.environ.get("OLLAMA_HOST", "http://localhost:11434"),
        )
    elif args.backend == "anthropic":
        backend = AnthropicBackend(model=os.environ.get("LLM_MODEL", "claude-haiku-4-5-20251001"))
    else:
        backend = make_default_backend()

    classifier = SocClassifier.from_pretrained(db_url=args.db)
    if classifier._encoder is None:  # type: ignore[attr-defined]
        print("ERROR: Stage 2 encoder failed to load — cannot supply candidates.", file=sys.stderr)
        sys.exit(3)

    llm = LlmClassifier(backend=backend)

    n_seen = 0
    n_confident = 0
    n_unconfident = 0
    n_skipped = 0
    n_errors = 0
    last_id = 0

    started = time.time()
    log.info(
        "reclassify.start",
        backend=backend.name(),
        top_k=args.top_k,
        dry_run=args.dry_run,
    )

    with psycopg.connect(args.db) as conn:
        while True:
            with conn.cursor() as cur:
                cur.execute(_FETCH_SQL, (last_id, args.batch))
                rows = cur.fetchall()
            if not rows:
                break
            last_id = rows[-1][0]

            for row in rows:
                qid, filing_year, nlp_id, title, employer, state, prior = row
                n_seen += 1
                if args.limit and n_seen > args.limit:
                    break

                candidates = classifier.topk_candidates(title, k=args.top_k)
                if not candidates:
                    n_skipped += 1
                    continue

                outcome = llm.classify(
                    title=title,
                    candidates=candidates,
                    employer_name=employer,
                    employer_state=state,
                )
                if outcome is None:
                    n_errors += 1
                    continue

                chosen, decision = outcome

                # Treat the pick as actionable if the LLM was confident OR a gate
                # downgraded a confident pick to "needs review" (e.g. short-title).
                # In the latter case we still write the SOC but flag requires_review.
                gate_flagged = decision.review_reason is not None
                actionable = (
                    decision.choice_index != 0
                    and (decision.confident or gate_flagged)
                )

                if not actionable:
                    n_unconfident += 1
                    if n_seen % 25 == 0:
                        log.info(
                            "reclassify.progress",
                            seen=n_seen,
                            confident=n_confident,
                            unconfident=n_unconfident,
                            errors=n_errors,
                            elapsed=int(time.time() - started),
                        )
                    continue

                # Confident pick — write back and remove from quarantine
                n_confident += 1
                if args.dry_run:
                    if n_confident <= 10:
                        log.info(
                            "reclassify.dry_run_pick",
                            title=title[:60],
                            choice=f"{chosen.code} {chosen.title}",
                            score=chosen.confidence,
                            reason=decision.reason,
                            review_reason=decision.review_reason,
                        )
                    continue

                patch = {
                    "soc_code": chosen.code,
                    "soc_title": chosen.title,
                    "soc_confidence": chosen.confidence,
                    "soc_source": "llm",
                    "llm_reclassified": True,
                    "llm_backend": backend.name(),
                    "llm_reason": decision.reason,
                    "llm_processed_at": datetime.now(timezone.utc).isoformat(),
                }
                if gate_flagged:
                    patch["requires_review"] = True
                    patch["review_reason"] = decision.review_reason
                try:
                    with conn.cursor() as cur:
                        cur.execute(_UPDATE_SQL, (json.dumps(patch), nlp_id, filing_year))
                        cur.execute(_DELETE_SQL, (qid,))
                    conn.commit()
                except Exception:
                    log.exception("reclassify.write_failed", quarantine_id=qid)
                    conn.rollback()
                    n_errors += 1

                if n_seen % 25 == 0:
                    log.info(
                        "reclassify.progress",
                        seen=n_seen,
                        confident=n_confident,
                        unconfident=n_unconfident,
                        errors=n_errors,
                        elapsed=int(time.time() - started),
                    )

            if args.limit and n_seen >= args.limit:
                break

    elapsed = int(time.time() - started)
    print()
    print("=== Reclassification Summary ===")
    print(f"  backend            : {backend.name()}")
    print(f"  rows seen          : {n_seen}")
    print(f"  confident picks    : {n_confident}  ({(100.0*n_confident/n_seen if n_seen else 0):.1f}%)")
    print(f"  unconfident / pass : {n_unconfident}")
    print(f"  skipped (no cand.) : {n_skipped}")
    print(f"  errors             : {n_errors}")
    print(f"  elapsed            : {elapsed}s")
    if not args.dry_run and n_confident:
        print(f"  → quarantine drained by {n_confident} rows")


if __name__ == "__main__":
    main()
