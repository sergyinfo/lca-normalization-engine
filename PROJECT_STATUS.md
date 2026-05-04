# Project Status Report

**Date:** 2026-05-04 (updated: Stage 0 employer-consensus + LLM-on-residual + short-title gate)

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
| `lca_records` | 107,414 | **107,409 classified** (99.99%); 103 flagged for review (short-title LLM picks) |
| `soc_aliases` | 13,003 | 6,520 BLS DMTF + 6,483 self-bootstrapped from cross-employer consensus |
| `employer_soc_consensus` | 1,597 | New: per-employer (FEIN, title) → SOC lookup, refreshed from `lca_records` |
| `canonical_employers` | 19,970 | Unique employers resolved by FEIN (Layer 1) |
| `staging.quarantine_records` | 5 | Residual HITL queue (LLM-refused titles) — 0.005% of input |

SOC classification breakdown after the full pipeline (Stage 0 → 1 → 2 → 3 LLM):

| Source | Count | Confidence | Notes |
|---|---|---|---|
| Stage 0 — Employer consensus | 8 (backfill) | ≥0.80 (capped 0.99) | Per-FEIN authoritative; Stage 0 fires inline for new ingestions |
| Stage 1 — DMTF / bootstrap exact match | 64,849 | 1.0 | BLS Direct Match Title File + cross-employer aliases |
| Stage 2 — Semantic retrieval (≥ 0.7) | 38,518 | 0.7 – 0.99 | sentence-transformer cosine similarity |
| Stage 3 — LLM-on-residual | 4,034 | LLM-picked from top-10 candidates | Llama 3.1 8B local via Ollama |
| Flagged short-title HITL | 103 | (subset of above) | `requires_review=true, review_reason='short_title_llm_pick'` |
| Quarantined (LLM declined) | 5 | < 0.7 + LLM refused | True residue |

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
| **SOC classification** | Stage 0 (employer consensus) + Stage 1 (DMTF/bootstrap) + Stage 2 (semantic retrieval) + Stage 3 (LLM-on-residual). 99.99% coverage; 5-record HITL residue | None on the critical path. BERT fine-tuning was empirically tested and rejected (lost to retrieval by 11pp on this corpus — see `project_notes/`) |
| **Entity resolution** | Layer 1 FEIN matching is fully working — `canonical_employers` populated, `canonical_employer_id` written back to `lca_records` | Layer 2 (`pg_trgm` similarity) and Layer 3 (`pgvector` HNSW) — records without a valid FEIN are not matched |

---

## What's Not Working Yet

- **Layers 2 & 3 entity resolution** — records without a valid FEIN don't get a
  `canonical_employer_id`. Trigram and vector similarity matching are stubbed.
- **HITL review UI** — the 103 short-title flagged records and 5 quarantine
  residue records carry `requires_review=true`/quarantine status, but there's
  no operator interface to walk through them. SQL only for now.
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
| **Database Library** | `packages/db-lib` | Singleton PG pool, `pg-copy-streams` bulk COPY, idempotent `ensureSchema()`, partitioned tables, GIN + expression indexes, all NLP tables incl. new `employer_soc_consensus` |
| **Ingestor** | `apps/ingestor` | BullMQ worker: XLSX streaming via `xlstream`, UUID-tagged records (`_nlp_id`), enriched NLP payload (FEIN, state, city), batch flushing, ≤250 MB memory cap |
| **Harvester** | `apps/harvester` | Scrapes DOL site for new XLSX files, dedup via `harvested_files` table |
| **CLI Tool** | `apps/cli-tool` | `db:init`, `db:reset`, `db:status`, `seed`, `queue:stats`, `queue:drain` |
| **Infrastructure** | `docker-compose.yml` | `pgvector/pgvector:pg16`, Redis 7, nlp-worker, ingestion-worker — all healthy |
| **Pydantic Models** | `.../models.py` | `RecordItem`, `NlpJobPayload`, `SocResult` (now with `soc_source`, `review_reason`) |
| **DMTF Loader** | `.../dmtf_loader.py` | Downloads / parses BLS Direct Match Title File, auto-detects column layouts, bulk-upserts into `soc_aliases` |
| **SOC Classifier — Stage 0** | `.../soc_classifier.py` | New: per-employer consensus lookup via `employer_soc_consensus` (FEIN + normalized title). Runs **before** Stage 1. |
| **SOC Classifier — Stage 1** | `.../soc_classifier.py` | DMTF / bootstrap exact-match via `soc_aliases`; ~1.0 confidence on hit |
| **SOC Classifier — Stage 2** | `.../soc_classifier.py` | Sentence-transformer (`all-MiniLM-L6-v2`) semantic retrieval; cosine argmax with 0.7 confidence gate |
| **SOC Classifier — Stage 3 (LLM)** | `.../llm_classifier.py`, `.../reclassify_quarantine.py` | LLM picks from top-K Stage 2 candidates. Backends: Ollama (local Llama 3.1 8B) or Anthropic API. Includes built-in short-title gate that re-routes literal-string risks to HITL. |
| **Cross-employer alias bootstrap** | `.../alias_bootstrap.py` | Mines consensus `(JOB_TITLE, SOC_CODE)` pairs from `lca_records` into `soc_aliases` |
| **Per-employer consensus refresh** | `.../employer_consensus.py` | New: rebuilds `employer_soc_consensus` from `lca_records` aggregations |
| **Entity Resolution — Layer 1** | `.../entity_resolution.py` | FEIN deterministic match; populates `canonical_employers` |
| **NLP Worker** | `.../worker.py` | Async Redis consumer; passes FEIN through Stage 0; writes back `soc_source`, `requires_review`, `review_reason` |
| **Documentation** | `README.md`, `PROJECT_STATUS.md`, `project_notes/` | Architecture, status, plus a full evolution narrative of the classifier design (`project_notes/soc_classifier_evolution.md`) |

### Partially Complete

| Component | What Works | What's Missing |
|---|---|---|
| **Entity Resolution — Layers 2 & 3** | Method stubs (`resolve_trgm`, `resolve_vector`), DB indexes ready (`gin_trgm_ops`, HNSW) | Actual SQL queries against `canonical_employers` and `employer_embeddings` |

### Not Yet Implemented

| Item | Notes |
|---|---|
| **BERT fine-tuning pipeline** | **Tested and rejected** — see `project_notes/soc_classifier_evolution.md`. Fine-tuned `bert-base-uncased` on 49K bootstrap labels lost to Stage 2 retrieval by 11pp exact / 3pp major. Documented as a thesis finding. |
| **HITL review CLI / UI** | 103 short-title flagged + 5 quarantine residue records carry the right metadata; no operator interface yet |
| **Tests** | No test files in any package (JS or Python) |
| **CI/CD** | No GitHub Actions workflows |
