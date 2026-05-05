# Project Status Report

**Date:** 2026-05-05 (updated: Layers 2 & 3 entity resolution + canonical-id backfill + unresolved-employers queue)

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
| `lca_records` | 107,414 | **107,409 classified** (99.99%); 103 flagged for review (short-title LLM picks); **100% have `canonical_employer_id`** |
| `soc_aliases` | 13,003 | 6,520 BLS DMTF + 6,483 self-bootstrapped from cross-employer consensus |
| `employer_soc_consensus` | 1,597 | Per-employer (FEIN, title) → SOC lookup, refreshed from `lca_records` |
| `canonical_employers` | 19,970 | Unique employers resolved by FEIN (Layer 1) |
| `employer_embeddings` | 19,970 | New: 384-dim sentence-transformer vectors of `canonical_name`; HNSW cosine index for Layer 3 |
| `staging.unresolved_employers` | 0 | New: operator queue for records missed by all 3 layers (empty — FY2025 Q1 has 100% FEIN coverage) |
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
| **Entity resolution** | All three layers implemented and validated. Layer 1 (FEIN) carries 100% on FY2025 Q1; Layers 2 & 3 ready for historical / dirtier corpora. `staging.unresolved_employers` operator queue receives any layer-3 misses. | Operator HITL CLI to merge/promote rows in `unresolved_employers`. The current ingest produces 0 rows there because FY2025 Q1 has 100% FEIN coverage; CLI is deferred until historical data with real misses is loaded — see `project_notes/entity_resolution_evolution.md`. |

---

## What's Not Working Yet

- **HITL review UI** — the 103 short-title flagged records, 5 quarantine
  residue records, and (eventually) any rows in `staging.unresolved_employers`
  carry the right metadata, but there's no operator interface to walk through
  them. SQL only for now.
- **Periodic embedding refresh** — `embed-employers` populates
  `employer_embeddings` from `canonical_employers`. New canonicals inserted
  later (via Layer 1 misses on future ingests) won't be embedded until the
  CLI is rerun. Needs to be wired into the post-ingest flow, or scheduled.
- **Tests and CI/CD** — no automated test suite or GitHub Actions workflows.
- **`nlp-worker` Docker image is stale** — source code is baked in at
  build-time and the recent Python changes (Layers 2/3, unresolved-employers
  write path) haven't been rebuilt into the image. Run
  `docker compose build nlp-worker && docker compose up -d nlp-worker`
  before the next ingest. Host-venv CLIs (`backfill-canonical-ids`,
  `embed-employers`, `reclassify-quarantine`) are unaffected.

---

## Next Steps

These are ordered by impact — each one unlocks something visible in the pipeline.

### Step 1 — Operator HITL CLI *(next up)*

A single CLI tool that lets the operator walk three review queues:
* `requires_review = true` records in `lca_records` (103 short-title LLM picks).
* `staging.quarantine_records` (5 LLM-refused residue).
* `staging.unresolved_employers` (currently 0; will grow on historical /
  dirtier corpora).

Each queue exposes list / inspect / accept / merge / reject actions. Writes
the operator's decision back to the source row.

**Outcome:** All HITL surfaces become walkable without ad-hoc SQL.

### Step 2 — Historical corpus exercise (Layers 2/3 + unresolved queue)

Ingest a pre-2020 LCA quarter (when FEIN discipline was looser) so Layers 2
and 3 actually carry traffic. Use the resulting `unresolved_employers`
population to tune trigram and vector thresholds against real misses
instead of synthetic probes.

**Outcome:** Validation that the entity-resolution cascade behaves on the
data it was built for, plus calibrated thresholds.

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
| **Python NLP enrichment** | **~95%** | All four SOC stages + all three entity-resolution layers + unresolved-employers queue + Pydantic validation + PostgreSQL write-back all implemented. Operator HITL CLI is the only remaining critical-path item. |
| **Infrastructure & DevOps** | **95%** | Docker stack with pgvector fully working; missing CI/CD and tests; nlp-worker image needs a rebuild to pick up Layers 2/3 |
| **Documentation** | **98%** | Reflects current implementation accurately; entity-resolution evolution documented in `project_notes/` |

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
| **Entity Resolution — Layer 1** | `.../entity_resolution.py` | FEIN deterministic match; populates `canonical_employers`. Carries 100% of FY2025 Q1 traffic. |
| **Entity Resolution — Layer 2** | `.../entity_resolution.py` | New: `pg_trgm` similarity, blocked by `employer_state`, threshold 0.85. GIN trigram filter for recall + Python precision gate. |
| **Entity Resolution — Layer 3** | `.../entity_resolution.py` | New: `pgvector` HNSW cosine over 384-dim sentence-transformer embeddings of `canonical_name`. Threshold 0.15. Encoder shared with `SocClassifier` (no duplicate model load). |
| **Employer embedder** | `.../employer_embedder.py` | New: encodes all `canonical_employers.canonical_name` into `employer_embeddings`. Idempotent. Run as `pnpm employers:embed` after each canonical-set growth. |
| **Canonical-id backfill** | `.../backfill_canonical_ids.py` | New: keyset-paginated CLI that resolves `canonical_employer_id` for any orphan `lca_records`. Closed the 4,047-record gap left by quarantine drains. Run as `pnpm canonical:backfill`. |
| **Unresolved-employers queue** | `staging.unresolved_employers` table + `worker._write_unresolved` | New: aggregated UPSERT queue for records missed by all three layers. Empty on FY2025 Q1 (100% FEIN coverage); populated on dirtier corpora. |
| **NLP Worker** | `.../worker.py` | Async Redis consumer; runs SOC pipeline + 3-layer entity resolution; writes `soc_source`, `requires_review`, `review_reason`, `canonical_employer_id`; UPSERTs misses into `staging.unresolved_employers`. |
| **Reclassify-quarantine** | `.../reclassify_quarantine.py` | LLM-on-residual drain. Now also calls `resolve_fein` inline so quarantine drains never leave `canonical_employer_id` unset. |
| **Documentation** | `README.md`, `PROJECT_STATUS.md`, `project_notes/` | Architecture, status, plus full evolution narratives for the SOC classifier (`soc_classifier_evolution.md`) and the entity-resolution cascade (`entity_resolution_evolution.md`). |

### Not Yet Implemented

| Item | Notes |
|---|---|
| **BERT fine-tuning pipeline** | **Tested and rejected** — see `project_notes/soc_classifier_evolution.md`. Fine-tuned `bert-base-uncased` on 49K bootstrap labels lost to Stage 2 retrieval by 11pp exact / 3pp major. Documented as a thesis finding. |
| **HITL review CLI / UI** | 103 short-title flagged + 5 quarantine residue records + (eventually) `staging.unresolved_employers` rows carry the right metadata; no operator interface yet |
| **Periodic embedding refresh** | `embed-employers` is one-shot; needs to be wired into the post-ingest flow so Layer 3 sees freshly-inserted canonicals |
| **Tests** | No test files in any package (JS or Python) |
| **CI/CD** | No GitHub Actions workflows |
