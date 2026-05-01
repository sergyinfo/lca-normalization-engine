# Project Status Report

**Date:** 2026-05-01

---

## What This Project Does

US employers must file a **Labor Condition Application (LCA)** with the Department
of Labor every time they sponsor a foreign worker (most commonly on an H-1B visa).
The DOL publishes all of these filings publicly as quarterly Excel files. Over the
last decade they add up to **12 million+ records**.

This project is a data pipeline that:

1. **Collects** every historical and future LCA Excel file from the DOL website
   automatically.
2. **Stores** all records in a partitioned PostgreSQL database, queryable by year,
   employer, job title, wage, and location.
3. **Normalises job titles** — free-text entries like `"Sr. Software Eng III"` or
   `"SWE"` are mapped to a standard government occupational code (SOC) so records
   across different employers and years can be compared consistently.
4. **Deduplicates employers** — the same company appears under hundreds of spelling
   variants (`"Google Inc."`, `"Google LLC"`, `"GOOGLE"`, `"Google US"`). The
   pipeline resolves all of these to a single canonical entity.

The end result is a clean, queryable dataset ready for labour market analysis,
wage trend research, and employer benchmarking.

---

## What You Can Do Right Now

### Ingest LCA data

The ingestion pipeline is fully working. You can load any DOL LCA Excel file —
historical or current — into PostgreSQL with a single command:

```bash
pnpm docker:up        # start PostgreSQL + Redis
pnpm db:init          # create all tables and indexes
pnpm db:status        # verify extensions and confirm all tables are empty
pnpm seed -- --files-dir /path/to/lca-archive
pnpm db:status        # verify row counts after ingestion completes
```

The ingestor streams each file row-by-row (memory stays ≤ 250 MB regardless of
file size), validates every record, bulk-copies valid rows into `lca_records`, and
routes invalid rows to `staging.quarantine_records` with the full error list.
107,414 records from FY2025 Q1 have already been loaded this way.

### Watch for new DOL releases automatically

The harvester service polls the DOL website on a configurable interval, detects
newly published quarterly files, downloads them, and enqueues ingestion jobs
automatically — no manual intervention required:

```bash
docker compose up -d harvester
```

### Query the database

Once records are ingested, you can query `lca_records` directly in PostgreSQL.
The JSONB `data` column holds the full record; GIN indexes make field-level
queries fast:

```sql
-- All H-1B filings for software roles in California in 2024
SELECT data->>'EMPLOYER_NAME', data->>'JOB_TITLE', data->>'WAGE_RATE_OF_PAY_FROM'
FROM   lca_records
WHERE  filing_year = 2024
AND    data @> '{"EMPLOYER_STATE": "CA", "VISA_CLASS": "H-1B"}';
```

### Run Stage 1 SOC classification

If you seed the SOC alias table from the BLS Direct Match Title File (~56K
official title mappings), the NLP worker can already classify job titles that
appear verbatim in that file with 100% confidence — no ML model required:

```bash
# Seed once after db:init
DATABASE_URL=postgresql://... load-dmtf --url

# Confirm soc_aliases is populated (~56K rows expected)
pnpm db:status

# Then start the NLP worker
docker compose up -d nlp-worker
```

Any title that matches a DMTF entry is classified immediately. Titles that don't
match fall through to Stage 2 (BERT), which currently returns a placeholder — see
"What's Not Working Yet" below.

---

## What's Partially Working

| Feature | What works | What's still missing |
|---|---|---|
| **SOC classification** | Stage 1 exact-match against `soc_aliases` (DMTF titles → SOC code, confidence = 1.0) | Stage 2 BERT model — titles not in the DMTF get `"00-0000 / UNCLASSIFIED"` |
| **NLP worker** | Receives BullMQ jobs from Redis, validates payloads with Pydantic, calls the classifier, marks low-confidence records as `requires_review` | Results are published to a Redis stream but never written back to `lca_records` in PostgreSQL |
| **Employer deduplication** | Database tables and indexes for all three layers are ready (`canonical_employers`, `employer_embeddings`) | All matching logic is stubbed — every employer is currently treated as unique |

---

## What's Not Working Yet

- **BERT fallback (Stage 2 SOC)** — job titles not found in the DMTF are returned
  as `UNCLASSIFIED`. A fine-tuned BERT model (or a zero-shot HuggingFace model)
  is needed to handle these.
- **Employer deduplication** — none of the three matching layers (FEIN lookup,
  trigram similarity, vector embeddings) are implemented yet. All employers remain
  distinct entries.
- **NLP write-back** — after classification the results sit in a Redis stream but
  `lca_records.data` is never updated with `soc_code` or `canonical_employer_id`.
  The pipeline loop is not yet closed.
- **Quarantine reprocessing** — records that fail validation or get flagged for
  review accumulate in `staging.quarantine_records` with no tooling to bulk-correct
  and re-ingest them yet.
- **Tests and CI/CD** — no automated tests exist in any package.

---

## Next Steps

These are ordered by impact — each one unlocks something visible in the pipeline.

### Step 1 — FEIN-based employer deduplication *(next up)*

Most LCA records include a Federal Employer Identification Number (FEIN). Two
records with the same FEIN are definitively the same company. This is pure SQL —
no ML involved — and resolves the majority of duplicates instantly.

**Outcome:** Employers with a valid FEIN get a `canonical_employer_id` in
`canonical_employers`. The `lca_records` table can be updated accordingly.

### Step 2 — Write NLP results back to PostgreSQL

Right now processed records disappear into a Redis stream that nothing reads.
This step adds an `UPDATE lca_records SET data = data || $result WHERE id = $id`
call to the NLP worker so that `soc_code` and `canonical_employer_id` are
persisted. This closes the pipeline loop.

**Outcome:** After NLP processing you can query classified and deduplicated records
directly from PostgreSQL.

### Step 3 — BERT / zero-shot fallback for Stage 2

For job titles not covered by the DMTF (unusual or abbreviated titles), a language
model is needed. The fastest path without training data is a zero-shot classifier
from HuggingFace using SOC titles as candidate labels — no fine-tuning required.

**Outcome:** All records get a SOC code. Low-confidence predictions are flagged
`requires_review` and routed to the quarantine table for human review.

### Step 4 — Trigram and vector employer matching (Layers 2 & 3)

After FEIN matching, remaining employers are matched by name similarity using
PostgreSQL's `pg_trgm` extension, then by semantic vector distance using
`pgvector`. Both indexes are already created; only the Python query logic needs
to be written.

**Outcome:** Employers without a FEIN (or with formatting variants) are still
deduplicated, dramatically reducing the number of distinct canonical employers.

### Step 5 — Quarantine reprocessing CLI + tests

Add `reprocess:quarantine` to the CLI tool and write unit/integration tests for
the classifier, entity resolver, and worker.

**Outcome:** Production-grade reliability and a safety net for future changes.

---

## Technical Summary

| Layer | Completeness | Notes |
|---|---|---|
| **Node.js ingestion pipeline** | **100%** | Fully functional — 107,414 records from FY2025 Q1 loaded successfully |
| **Python NLP enrichment** | **~40%** | Worker orchestration, Pydantic validation, and Stage 1 SOC classification complete; BERT, entity resolution, and write-back still pending |
| **Infrastructure & DevOps** | **95%** | Docker stack with pgvector fully working; missing CI/CD and tests |
| **Documentation** | **98%** | Reflects current implementation accurately |

---

## Detailed Component Status

### 100% Complete

| Component | Path | Description |
|---|---|---|
| **Database Library** | `packages/db-lib` | Singleton PG pool, `pg-copy-streams` bulk COPY, idempotent `ensureSchema()`, partitioned tables, GIN indexes, all NLP tables (`canonical_employers`, `employer_embeddings`, `soc_aliases`, `staging.quarantine_records`) |
| **Ingestor** | `apps/ingestor` | BullMQ worker: XLSX streaming via `xlstream`, batch flushing (5K rows), NLP job enqueueing, bounded memory ≤250 MB, graceful shutdown |
| **Harvester** | `apps/harvester` | Scrapes DOL site for new XLSX files, dedup via `harvested_files` table, auto-enqueues ingest jobs, configurable poll interval |
| **CLI Tool** | `apps/cli-tool` | `db:init`, `seed` (with dry-run), `queue:stats`, `queue:drain` |
| **Infrastructure** | `docker-compose.yml` | `pgvector/pgvector:pg16`, Redis 7, nlp-worker, ingestion-worker — all healthy with proper healthchecks |
| **Pydantic Models** | `packages/nlp-engine/.../models.py` | `RecordItem`, `NlpJobPayload` (duplicate-ID guard), `SocResult` — full v2 validation |
| **DMTF Loader** | `packages/nlp-engine/.../dmtf_loader.py` | Downloads / parses BLS Direct Match Title File, bulk-upserts into `soc_aliases`; idempotent |
| **Documentation** | `README.md` | Architecture diagrams, data flow, database design, commands reference |

### Partially Complete

| Component | Path | What Works | What's Missing |
|---|---|---|---|
| **SOC Classifier** | `.../soc_classifier.py` | Stage 1 DMTF exact-match via `soc_aliases`, psycopg3 connection with reconnect, CLI entry point | Stage 2 BERT model loading (checkpoint not yet available) |
| **NLP Worker** | `.../worker.py` | Async Redis consumer, Pydantic validation, semaphore concurrency, graceful shutdown, `requires_review` flag | PostgreSQL write-back; depends on stubbed entity resolver |
| **Entity Resolution** | `.../entity_resolution.py` | Class structure, CLI entry point | All matching layers stubbed — returns identity mapping |

### Not Yet Implemented

| Item | Notes |
|---|---|
| **BERT model checkpoint** | No fine-tuned model at `models/soc-bert`; zero-shot HuggingFace fallback is the fastest path |
| **PostgreSQL write-back** | NLP worker publishes to Redis stream but never UPDATEs `lca_records` |
| **Layer 1 entity resolution** | FEIN deterministic matching not yet written |
| **Layers 2 & 3 entity resolution** | pg_trgm and pgvector matching not yet written |
| **Quarantine reprocessing** | `reprocess:quarantine` CLI command not implemented |
| **Training pipeline** | `lca_nlp_engine.train_soc` script does not exist |
| **Tests** | No test files in any package (JS or Python) |
| **CI/CD** | No GitHub Actions workflows |
