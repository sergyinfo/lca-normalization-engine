# Project Status Report

**Date:** 2026-05-02

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
| `lca_records` | 107,414 | All ingested, ~54K classified with `soc_code` set |
| `canonical_employers` | 13,882 | Unique employers resolved by FEIN (Layer 1) |
| `staging.quarantine_records` | 52,998 | Low-confidence titles awaiting BERT (Stage 2 stub) |

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
| **SOC classification** | Stage 1 exact-match against `soc_aliases` (~1.0 confidence DMTF hits) | Stage 2 BERT/zero-shot for titles not in the DMTF — currently returns `00-0000 / UNCLASSIFIED` (confidence 0.0) and routes to quarantine |
| **Entity resolution** | Layer 1 FEIN matching is fully working — `canonical_employers` populated, `canonical_employer_id` written back to `lca_records` | Layer 2 (`pg_trgm` similarity) and Layer 3 (`pgvector` HNSW) — records without a valid FEIN are not matched |

---

## What's Not Working Yet

- **Stage 2 SOC classification** — job titles outside the BLS DMTF (~50% of records)
  get the `UNCLASSIFIED` placeholder. A zero-shot HuggingFace classifier or a
  fine-tuned BERT model would close this gap.
- **Layers 2 & 3 entity resolution** — records without a valid FEIN don't get a
  `canonical_employer_id`. Trigram and vector similarity matching are stubbed.
- **Quarantine reprocessing** — records flagged for review accumulate in
  `staging.quarantine_records`; there's no CLI tool yet to bulk-correct and
  re-ingest them.
- **Tests and CI/CD** — no automated test suite or GitHub Actions workflows.

---

## Next Steps

These are ordered by impact — each one unlocks something visible in the pipeline.

### Step 1 — BERT / zero-shot fallback for Stage 2 *(next up)*

About half the FY2025 Q1 records (~53K) currently land in quarantine because
their job titles aren't in the DMTF. The fastest path without training data is a
zero-shot classifier from HuggingFace (e.g. `facebook/bart-large-mnli`) using
SOC titles as candidate labels — no fine-tuning required.

**Outcome:** Every record gets a SOC code. Confident predictions update
`lca_records`; low-confidence ones still route to quarantine for human review.

### Step 2 — Trigram and vector employer matching (Layers 2 & 3)

For the ~30% of records without a valid FEIN, employers are matched by name
similarity. Layer 2 uses `pg_trgm` Jaccard similarity (>0.85 threshold). Layer 3
uses `sentence-transformers` embeddings stored in `pgvector` with HNSW indexes.
Both database indexes are already created; only the Python query logic remains.

**Outcome:** Employers like `"Google Inc."`, `"Google LLC"`, and `"GOOGLE"`
collapse into a single canonical entity even when a FEIN isn't present.

### Step 3 — Quarantine reprocessing CLI

Add `reprocess:quarantine` to the CLI tool. Reads rows from
`staging.quarantine_records`, allows the operator to correct or augment them,
and re-enqueues them through the normal NLP pipeline. Idempotent on rerun.

**Outcome:** Operators can fix data quality issues without manual SQL.

### Step 4 — Tests + CI/CD

Add unit tests for the classifier, entity resolver, Pydantic models, and
ingestor; integration tests that exercise the full Docker stack; GitHub Actions
to run lint + test + Docker build on every PR.

**Outcome:** Production-grade reliability and a safety net for future changes.

---

## Technical Summary

| Layer | Completeness | Notes |
|---|---|---|
| **Node.js ingestion pipeline** | **100%** | 107,414 records from FY2025 Q1 ingested cleanly |
| **Python NLP enrichment** | **~70%** | Stage 1 SOC, Layer 1 entity resolution, Pydantic validation, and PostgreSQL write-back all working; Stage 2 (BERT) and Layers 2/3 (trgm, vector) still pending |
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
| **Entity Resolution — Layer 1** | `.../entity_resolution.py` | FEIN deterministic match with SELECT-then-INSERT pattern; populates `canonical_employers` |
| **NLP Worker** | `.../worker.py` | Async Redis consumer, Pydantic validation, batch UPDATE write-back to `lca_records`, INSERT to `staging.quarantine_records` for low-confidence records |
| **Documentation** | `README.md`, `PROJECT_STATUS.md` | Architecture diagrams, data flow, database design, commands reference |

### Partially Complete

| Component | What Works | What's Missing |
|---|---|---|
| **SOC Classifier — Stage 2** | Code path is wired, returns `00-0000 / UNCLASSIFIED` placeholder | BERT model checkpoint or zero-shot HuggingFace pipeline |
| **Entity Resolution — Layers 2 & 3** | Method stubs (`resolve_trgm`, `resolve_vector`), DB indexes ready (`gin_trgm_ops`, HNSW) | Actual SQL queries against `canonical_employers` and `employer_embeddings` |

### Not Yet Implemented

| Item | Notes |
|---|---|
| **BERT model checkpoint** | No fine-tuned model at `models/soc-bert`; zero-shot HuggingFace fallback is the fastest path |
| **Quarantine reprocessing** | `reprocess:quarantine` CLI command not implemented |
| **Training pipeline** | `lca_nlp_engine.train_soc` script does not exist |
| **Tests** | No test files in any package (JS or Python) |
| **CI/CD** | No GitHub Actions workflows |
