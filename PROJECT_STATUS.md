# Project Status Report

**Date:** 2026-05-04

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

The full pipeline is now closed-loop end-to-end: ingest → classify → resolve
employer → write back to PostgreSQL.

### One-shot setup

```bash
pnpm docker:up        # PostgreSQL (with pgvector) + Redis + workers
pnpm db:init          # create all tables, indexes, extensions

# Seed the SOC alias table (~6.5K BLS title mappings) — only once
DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db \
  load-dmtf --file ./data/dmtf.xlsx

pnpm db:status        # verify everything is healthy and empty
```

### Ingest and enrich

```bash
pnpm seed             # ingest XLSX files from ./data
pnpm queue:stats      # watch the queue drain
pnpm db:status        # see records, classifications, canonical employers
```

### What gets produced

A fully-loaded FY2025 Q1 file (~107K records) currently produces:

| Table | Rows | Notes |
|---|---|---|
| `lca_records` | 107,414 | All ingested; **103,367 classified** (96.2%) with confidence ≥ 0.7 |
| `soc_aliases` | 13,003 | 6,520 BLS DMTF + 6,483 self-bootstrapped from `lca_records` consensus |
| `canonical_employers` | 19,970 | Unique employers resolved by FEIN (Layer 1) |
| `staging.quarantine_records` | 4,047 | Below-threshold titles awaiting human review (3.8%) |

SOC classification breakdown:

| Source | Count | Confidence |
|---|---|---|
| Stage 1 — alias exact match | 64,849 | 1.0 |
| Stage 2 — Semantic retrieval (≥ 0.9) | 15,759 | very high |
| Stage 2 — Semantic retrieval (0.8–0.89) | 15,781 | high |
| Stage 2 — Semantic retrieval (0.7–0.79) | 6,978 | acceptable |
| Quarantined (< 0.7) | 4,047 | requires review |

### Query the database

```sql
-- Top 10 employers by LCA filing volume
SELECT canonical_name, fein, employer_state, record_count
FROM   canonical_employers
ORDER  BY record_count DESC
LIMIT  10;

-- Classified Software Engineer filings with their canonical employer
SELECT data->>'JOB_TITLE'              AS job_title,
       data->>'soc_code'               AS soc,
       data->>'canonical_employer_id'  AS canonical_id,
       data->>'EMPLOYER_NAME'          AS raw_employer
FROM   lca_records
WHERE  data->>'soc_code' = '15-1252'
LIMIT  5;
```

---

## What's Partially Working

| Feature | What works | What's still missing |
|---|---|---|
| **SOC classification** | Stage 1 (alias exact match) + Stage 2 (sentence-transformer semantic retrieval over `soc_aliases`) + self-bootstrap from cross-employer consensus in `lca_records`. 96.2% coverage at confidence ≥ 0.7 | A fine-tuned BERT classifier would beat semantic retrieval on edge cases. Optional and not on the critical path |
| **Entity resolution** | Layer 1 FEIN matching is fully working — `canonical_employers` populated, `canonical_employer_id` written back to `lca_records` | Layer 2 (`pg_trgm` similarity) and Layer 3 (`pgvector` HNSW) — records without a valid FEIN are not matched |

---

## What's Not Working Yet

- **Layers 2 & 3 entity resolution** — records without a valid FEIN don't get a
  `canonical_employer_id`. Trigram and vector similarity matching are stubbed.
- **Quarantine reprocessing** — records flagged for review accumulate in
  `staging.quarantine_records`; there's no CLI tool yet to bulk-correct and
  re-ingest them.
- **Tests and CI/CD** — no automated test suite or GitHub Actions workflows.

---

## Next Steps

These are ordered by impact — each one unlocks something visible in the pipeline.

### Step 1 — Trigram and vector employer matching (Layers 2 & 3) *(next up)*

For the ~30% of records without a valid FEIN, employers are matched by name
similarity. Layer 2 uses `pg_trgm` Jaccard similarity (>0.85 threshold). Layer 3
uses `sentence-transformers` embeddings stored in `pgvector` with HNSW indexes.
Both database indexes are already created; only the Python query logic remains.

**Outcome:** Employers like `"Google Inc."`, `"Google LLC"`, and `"GOOGLE"`
collapse into a single canonical entity even when a FEIN isn't present.

### Step 2 — Quarantine reprocessing CLI

Add `reprocess:quarantine` to the CLI tool. Reads rows from
`staging.quarantine_records`, allows the operator to correct or augment them,
and re-enqueues them through the normal NLP pipeline. Idempotent on rerun.

**Outcome:** Operators can fix data quality issues without manual SQL.

### Step 3 — Tests + CI/CD

Add unit tests for the classifier, entity resolver, Pydantic models, and
ingestor; integration tests that exercise the full Docker stack; GitHub Actions
to run lint + test + Docker build on every PR.

**Outcome:** Production-grade reliability and a safety net for future changes.

---

## Technical Summary

| Layer | Completeness | Notes |
|---|---|---|
| **Node.js ingestion pipeline** | **100%** | 107,414 records from FY2025 Q1 ingested cleanly |
| **Python NLP enrichment** | **~85%** | Stage 1 + Stage 2 SOC, Layer 1 entity resolution, Pydantic validation, and PostgreSQL write-back all working; Layers 2/3 (trgm, vector) still pending |
| **Infrastructure & DevOps** | **95%** | Docker stack with pgvector fully working; missing CI/CD and tests |
| **Documentation** | **98%** | Reflects current implementation accurately |

---

## Detailed Component Status

### 100% Complete

| Component | Path | Description |
|---|---|---|
| **Database Library** | `packages/db-lib` | Singleton PG pool, `pg-copy-streams` bulk COPY, idempotent `ensureSchema()`, partitioned tables, GIN + expression indexes (incl. `_nlp_id` write-back index), all NLP tables |
| **Ingestor** | `apps/ingestor` | BullMQ worker: XLSX streaming via `xlstream`, UUID-tagged records (`_nlp_id`), enriched NLP payload (FEIN, state, city), batch flushing, ≤250 MB memory cap |
| **Harvester** | `apps/harvester` | Scrapes DOL site for new XLSX files, dedup via `harvested_files` table |
| **CLI Tool** | `apps/cli-tool` | `db:init`, `db:reset`, `db:status`, `seed` (with dry-run), `queue:stats`, `queue:drain` |
| **Infrastructure** | `docker-compose.yml` | `pgvector/pgvector:pg16`, Redis 7, nlp-worker, ingestion-worker — all healthy |
| **Pydantic Models** | `.../models.py` | `RecordItem` (with `nlp_id`), `NlpJobPayload` (duplicate-ID guard), `SocResult` (with `filing_year`) |
| **DMTF Loader** | `.../dmtf_loader.py` | Downloads / parses BLS Direct Match Title File, auto-detects column layouts, bulk-upserts into `soc_aliases` |
| **SOC Classifier — Stage 1** | `.../soc_classifier.py` | DMTF exact-match via `soc_aliases`, psycopg3 with reconnect; ~1.0 confidence on hit |
| **SOC Classifier — Stage 2** | `.../soc_classifier.py` | Sentence-transformer (`all-MiniLM-L6-v2`) semantic retrieval over the alias corpus; cosine similarity argmax with 0.7 confidence gate |
| **Self-bootstrapped aliases** | `.../alias_bootstrap.py` | Mines high-agreement `(JOB_TITLE, SOC_CODE)` pairs from `lca_records` (cross-employer consensus) and inserts them into `soc_aliases` with `source='lca_bootstrap'`. Cuts quarantine ~91% on the FY2025 Q1 sample |
| **Entity Resolution — Layer 1** | `.../entity_resolution.py` | FEIN deterministic match with SELECT-then-INSERT pattern; populates `canonical_employers` |
| **NLP Worker** | `.../worker.py` | Async Redis consumer, Pydantic validation, batch UPDATE write-back to `lca_records`, INSERT to `staging.quarantine_records` for low-confidence records |
| **Documentation** | `README.md`, `PROJECT_STATUS.md` | Architecture diagrams, data flow, database design, commands reference |

### Partially Complete

| Component | What Works | What's Missing |
|---|---|---|
| **Entity Resolution — Layers 2 & 3** | Method stubs (`resolve_trgm`, `resolve_vector`), DB indexes ready (`gin_trgm_ops`, HNSW) | Actual SQL queries against `canonical_employers` and `employer_embeddings` |

### Not Yet Implemented

| Item | Notes |
|---|---|
| **BERT fine-tuning pipeline** | Optional — semantic retrieval (Stage 2) covers the use case; a fine-tuned model would only improve edge cases |
| **Quarantine reprocessing** | `reprocess:quarantine` CLI command not implemented |
| **Tests** | No test files in any package (JS or Python) |
| **CI/CD** | No GitHub Actions workflows |
