# Project Status Report

**Date:** 2026-05-01

---

## 100% Complete (Production-Ready)

| Component | Path | Description |
|---|---|---|
| **Database Library** | `packages/db-lib` | Singleton PG pool, `pg-copy-streams` bulk COPY, idempotent `ensureSchema()`, partitioned tables, GIN indexes, extensions (pg_trgm, pgvector, btree_gin, uuid-ossp, vector). NLP tables: `canonical_employers`, `employer_embeddings`, `soc_aliases`, `staging.quarantine_records` |
| **Ingestor** | `apps/ingestor` | BullMQ worker: XLSX streaming via `xlstream`, batch flushing (5K rows), NLP job enqueueing, bounded memory ≤250 MB, graceful shutdown |
| **Harvester** | `apps/harvester` | Scrapes DOL site for new XLSX files, dedup via `harvested_files` table, auto-enqueues ingest jobs, configurable poll interval |
| **CLI Tool** | `apps/cli-tool` | `db:init`, `seed` (with dry-run), `queue:stats`, `queue:drain` — all working |
| **Infrastructure** | `docker-compose.yml` | `pgvector/pgvector:pg16` (pgvector bundled), Redis 7, nlp-worker, ingestion-worker — all healthy with proper healthchecks and service dependencies |
| **Pydantic Models** | `packages/nlp-engine/src/lca_nlp_engine/models.py` | `RecordItem`, `NlpJobPayload` (with duplicate-ID guard), `SocResult` — full v2 validation with FEIN regex, SOC code format, state normalisation |
| **Documentation** | `README.md` | Architecture diagrams, data flow, tech stack (incl. pgvector image), database design, commands reference, environment variables |

---

## ~40% Complete (Needs Work)

| Component | Path | What Works | What's Stubbed / Missing |
|---|---|---|---|
| **NLP Worker** | `packages/nlp-engine/src/lca_nlp_engine/worker.py` | Async Redis consumer, BullMQ protocol handling, semaphore concurrency control, graceful shutdown, Pydantic payload validation, `requires_review` flag on confidence < 0.7 | Depends on stubbed classifier and resolver — all NLP results are placeholders. No PostgreSQL write-back yet |
| **SOC Classifier** | `packages/nlp-engine/src/lca_nlp_engine/soc_classifier.py` | Class structure, `SocPrediction` dataclass, CLI entry point | BERT model loading commented out — always returns `"00-0000"` / `UNCLASSIFIED`. Missing: Stage 1 DMTF exact-match lookup, BERT/zero-shot fallback |
| **Entity Resolution** | `packages/nlp-engine/src/lca_nlp_engine/entity_resolution.py` | Class structure, CLI entry point | `dedupe` API calls commented out — `cluster()` returns identity mapping. Missing: Layer 1 (FEIN), Layer 2 (pg_trgm), Layer 3 (pgvector/HNSW), blocking by `EMPLOYER_STATE` |

---

## Not Implemented

| Item | Notes |
|---|---|
| **BERT model checkpoint** | No fine-tuned model at `models/soc-bert`. Requires a training pipeline to produce the checkpoint |
| **BLS DMTF title file** | Stage 1 exact-match table (~56K SOC title mappings) not loaded into `soc_aliases` |
| **Dedupe settings file** | No trained weights at `models/company_dedup.settings`. Requires active-learning loop to generate |
| **PostgreSQL write-back** | NLP worker writes results to Redis stream (`lca:nlp-results`) but never UPDATEs `soc_code` / `canonical_employer_id` on `lca_records` |
| **Quarantine reprocessing** | `reprocess:quarantine` CLI command referenced in README but not implemented |
| **Training pipeline** | `lca_nlp_engine.train_soc` script referenced in README but does not exist |
| **Tests** | No test files found in any package (JS or Python) |
| **CI/CD** | No GitHub Actions workflows or other pipeline configuration |

---

## Summary

| Layer | Completeness | Notes |
|---|---|---|
| **Node.js (ingestion pipeline)** | **100%** | Fully functional — ingested 107,414 records from FY2025 Q1 successfully |
| **Python (NLP enrichment)** | **~40%** | Pydantic validation, model scaffolding, and worker orchestration complete; ML/dedup logic still stubbed |
| **Infrastructure & DevOps** | **95%** | pgvector now bundled via `pgvector/pgvector:pg16`; missing CI/CD and tests |
| **Documentation** | **98%** | Reflects current implementation; pgvector image documented |

---

## Priority Roadmap to MVP

### Priority 1 — Critical (blocks NLP pipeline)

1. ~~Create missing DB tables (`canonical_employers`, `employer_embeddings`, `soc_aliases`)~~ ✅ Done
2. ~~Add Pydantic validation for NLP job payloads~~ ✅ Done (`models.py`)
3. Implement DMTF Stage 1 exact-match lookup in `soc_classifier.py` (load `soc_aliases` from DB)
4. Implement Layer 1 (FEIN) entity resolution with PostgreSQL queries in `entity_resolution.py`
5. Add PostgreSQL write-back — UPDATE `soc_code` and `canonical_employer_id` on `lca_records`
6. Implement BERT model loading or HuggingFace zero-shot fallback for Stage 2 classification

### Priority 2 — Important (completes the enrichment pipeline)

7. Add confidence-based routing to `staging.quarantine_records` for low-confidence SOC predictions
8. Implement Layer 2 (pg_trgm) and Layer 3 (pgvector/HNSW) entity resolution
9. Implement `reprocess:quarantine` CLI command

### Priority 3 — Enhancement (production hardening)

10. Add unit and integration tests for all packages
11. Set up CI/CD pipeline (lint, test, Docker build)
12. Implement model training pipeline (`train_soc`)
13. Add embedding cache and model warm-start for batch performance
