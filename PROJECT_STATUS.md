# Project Status Report

**Date:** 2026-05-12 (updated: full 6-year re-ingest run completed end-to-end — FY2020 through FY2025, 3.83 M records, 0 errors. See `INGEST_RUN_REPORT.md` for the full timeline.)

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

State of the database after a full 6-year re-ingest run (FY2020 → FY2025,
24 LCA Disclosure files, **3,831,919** records):

| Table | Rows | Notes |
|---|---:|---|
| `lca_records` | 3,831,919 | All six years; partitioned by `filing_year`. **3,650,080 classified (95.3 %)**; 0 records with `requires_review=true` after the run. |
| `soc_aliases` | 16,079 | 13,003 BLS DMTF + 3,076 self-bootstrapped via `bootstrap-aliases` after ingestion |
| `employer_soc_consensus` | 17,354 | Per-(FEIN, normalised title) → SOC mapping, rebuilt by `consensus:refresh` post-ingest |
| `canonical_employers` | 92,289 | All from Layer 1 FEIN matches on FY2024 + FY2025 batches (pre-2024 disclosures have 0 % FEIN, so Layer 1 is data-dead on those years) |
| `employer_embeddings` | 92,289 | 384-dim sentence-transformer vectors of `canonical_name`; HNSW cosine index ready for Layer 3 |
| `staging.unresolved_employers` (open) | 157,612 | Aggregated unique `(employer_name, employer_state)` pairs that missed all three layers — almost entirely pre-2024 records where FEIN was absent |
| `staging.quarantine_records` (open) | 181,839 | Low Stage 2 confidence — deferred for Stage 3 LLM reclassify on GPU (250+ h on Mac CPU) |

SOC classification breakdown across the full 3.83 M run:

| Source | Count | % of classified | Notes |
|---|---:|---:|---|
| Stage 1 — DMTF / bootstrap exact match | 1,516,117 | 41.5 % | BLS Direct Match Title File + cross-employer aliases |
| Stage 2 — Semantic retrieval (≥ 0.7) | 1,898,690 | 52.0 % | sentence-transformer cosine similarity |
| Stage 0 — Employer consensus | 235,273 | 6.4 % | Per-(FEIN, title) authoritative; accrues during the run as the per-employer table fills |
| **Classified total** | **3,650,080** | **100 %** | (= 95.3 % of `lca_records`) |
| Quarantined (low Stage 2 confidence) | 181,839 | — | 4.7 % of `lca_records`; awaiting Stage 3 LLM reclassify |
| Flagged `requires_review` | 0 | — | None left active at end of run |

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
| **SOC classification** | Stages 0 → 1 → 2 all firing inline at scale — 95.3 % coverage across 3.83 M records, 0 errors. | Stage 3 LLM-on-residual is in code but **skipped** for this run: 181,839 quarantined records × 5–10 s Ollama call ≈ 250+ hours on Mac CPU. Needs batched-LLM mode and/or a GPU host before it can be run end-to-end. |
| **Entity resolution** | Layer 1 (FEIN) populated 92,289 canonicals on FY2024+FY2025 data. Layer 2 (`pg_trgm`) and Layer 3 (`pgvector` HNSW with 92,289 embeddings) wired in. `staging.unresolved_employers` operator queue functioning. | Pre-2024 disclosures lack `EMPLOYER_FEIN` (**DOL data quirk**, not a bug). 1.4 M+ pre-2024 records get Layer-2-matched against whatever canonicals exist at write time, or fall into `unresolved_employers`. Layer-1-only `canonical:backfill` CLI can't UPSERT new canonicals for the 181 K orphans — needs a Layer-2/3 + UPSERT variant. |

---

## What's Not Working Yet

- **Stage 3 LLM reclassify at scale** — `quarantine:reclassify` works, but
  181,839 records on a Mac CPU is uneconomical (~250 h). Needs batched-LLM
  mode (Ollama `/api/generate` with `stream=false` over a connection pool)
  and/or running on an A10G/L4 GPU. Until then, the 4.7 % quarantine
  residue stays unresolved.
- **Periodic embedding refresh** — `embed-employers` is one-shot. Wire it
  into the post-ingest flow so freshly inserted canonicals get encoded
  without a manual run. (`backfill-canonical-full` does encode-on-insert
  inline, so this only matters for canonicals created elsewhere — e.g.
  Operator UI `createCanonicalAndMerge`.)
- **DEBUG-level `pg_trgm` log spam in `nlp-worker`** — visible in
  `INGEST_RUN_REPORT.md` snapshots; lower `LOG_LEVEL` to `INFO` for the
  worker in `.env` to cut disk pressure on long runs.
- **Tests and CI/CD** — no automated test suite or GitHub Actions
  workflows.

---

## Next Steps

These are ordered by impact — each one unlocks something visible in the pipeline.

### Step 1 — Operator HITL UI ✅ *(done 2026-05-10)*

Shipped as `apps/operator-ui` — Fastify + EJS web app, single shared
password (`OPERATOR_PASSWORD`) with a signed-cookie session
(`SESSION_SECRET`). Runs as a Docker Compose service `operator-ui` on
port 8080.

Walks all three queues:
* `requires_review = true` records in `lca_records` — accept SOC /
  override SOC / reject to quarantine.
* `staging.quarantine_records` — assign SOC manually (writes back to
  `lca_records` via `_nlp_id`) / drop.
* `staging.unresolved_employers` — merge into existing canonical
  (with `pg_trgm` similarity search and state filter), create new
  canonical, or reject. Merge backfills `canonical_employer_id` on
  matching `lca_records`.

Bring up:
```bash
docker compose up -d operator-ui   # http://localhost:8080
# or for host iteration:
pnpm operator:dev
```

**Outcome:** All HITL surfaces are now walkable through a browser. No
more ad-hoc SQL.

### Step 2 — Full 6-year re-ingest exercise ✅ *(done 2026-05-11/12)*

FY2020 → FY2025 (24 LCA Disclosure files, 3.83 M records) ingested
end-to-end with 0 errors and 0 failed BullMQ jobs over ~13 h 45 m of
unattended NLP drain. Full timeline, snapshots, and findings recorded in
[`INGEST_RUN_REPORT.md`](INGEST_RUN_REPORT.md).

Key takeaways from this exercise:

* **DOL FEIN coverage cliff** — FY2020–FY2023 disclosure files have
  **0 % EMPLOYER_FEIN**; FY2024–FY2025 have 100 %. Layer 1 is therefore
  data-dead on the first four years. Documented as a data quirk to plan
  around, not a code defect.
* **Layer 1 explosion confirmed** — `canonical_employers` jumped from
  3 → 92,289 the moment FY2024/FY2025 batches surfaced, matching the
  pre-run hypothesis.
* **Post-ingest chain** (`consensus:refresh` → `bootstrap-aliases` →
  `employers:embed`) ran cleanly. `canonical:backfill` is a no-op for
  our quarantined-record orphans because their FEINs were never
  registered as canonicals.
* **Stage 3 reclassify** skipped because the 181 K residue is too large
  for Mac CPU latency.

### Step 3 — Layer-2/3 + UPSERT canonical backfill ✅ *(shipped 2026-05-12, awaiting full run)*

New CLI `backfill-canonical-full` resolves `staging.unresolved_employers`
end-to-end via the full Layer 1 → 2 → 3 cascade and **inserts a fresh
`canonical_employers` row + its embedding when no match is found above
threshold** (the older `backfill-canonical-ids` was Layer-1-only and could
not UPSERT, which is why it ran 9 hours as a no-op on this corpus).

What was built:

* **`packages/nlp-engine/src/lca_nlp_engine/backfill_canonical_full.py`** —
  batched cascade with state-blocked `pg_trgm`, HNSW `pgvector`, and
  per-batch encoder calls (5–10× faster than per-row). Includes
  `--dry-run`, `--no-backfill`, `--trgm-threshold`, and
  `--vector-max-distance` flags. Registered as `pnpm canonical:backfill-full`.
* **Three new expression indexes in `ensureSchema()`**, propagated to
  every `lca_records_YYYY` partition:
    - `idx_lca_records_employer_name_state` —
      `(lower(EMPLOYER_NAME), EMPLOYER_STATE)` for the bulk merge JOIN.
    - `idx_lca_records_canonical_missing` —
      `(id, filing_year) WHERE NOT (data ? 'canonical_employer_id')`
      for orphan scans.
    - `idx_lca_records_employer_fein` —
      partial expression on `EMPLOYER_FEIN`.

  EXPLAIN ANALYZE confirms the new composite index drops per-merge
  UPDATE wall time from **~14 s → ~2 s** (with `enable_seqscan = off`
  in the backfill session to dodge stale-stats planner mispicks).
* Operator-UI's `mergeUnresolved` / `createCanonicalAndMerge` SQL also
  benefits from the same composite index — same write path, now indexed.

Smoke test (256 rows, dry-run, 22 s wall):

| Layer | Hit rate | Note |
|---|---:|---|
| Layer 1 (FEIN) | 0 % | Expected — most unresolved are pre-2024, FEIN-less |
| Layer 2 (`pg_trgm`) | 73.4 % | Against 92 K canonicals from FY2024/FY2025 |
| Layer 3 (`pgvector`) | 12.5 % | Semantic matches trgm missed |
| New canonical | 14.1 % | Truly novel employer names |

→ **85.9 % match rate** = the cascade is doing real work. Extrapolated
full-run wall time: ~3-5 h (was estimated 7-10 h before indexes).

**Outcome:** every record gets a real `canonical_employer_id`, not a
collision-prone trgm match against whatever existed at processing time.

To execute:
```bash
DATABASE_URL=... pnpm canonical:backfill-full          # process all open
DATABASE_URL=... packages/nlp-engine/.venv/bin/backfill-canonical-full \
    --dry-run --limit 1000                             # sample first
```

### Step 4 — Stage 3 LLM reclassify on GPU

Run `quarantine:reclassify` on a rented A10G/L4 against the 181,839 open
quarantine records (expected wall time ~5–10 h on a single GPU vs
~250 h on Mac CPU). Drives quarantine residue to near zero.

### Step 5 — Tests + CI/CD

Add unit tests for the classifier, entity resolver, Pydantic models, and
ingestor; integration tests that exercise the full Docker stack; GitHub Actions
to run lint + test + Docker build on every PR.

**Outcome:** Production-grade reliability and a safety net for future changes.

---

## Technical Summary

| Layer | Completeness | Notes |
|---|---|---|
| **Node.js ingestion pipeline** | **100 %** | All six years (3.83 M records, 24 XLSX files) ingested cleanly via SAX streaming + `pg-copy-streams`, 0 failed jobs |
| **Python NLP enrichment** | **95 %** | Stages 0/1/2 run inline and processed 3.65 M records (95.3 % coverage) with 0 errors. Stage 3 LLM is in code but unrun at scale (181 K residue × Mac CPU is uneconomical — needs GPU). All three entity-resolution layers wired in; `employer_embeddings` populated with 92,289 384-dim vectors. |
| **Infrastructure & DevOps** | **95 %** | Docker stack with pgvector, Redis, ingestor, nlp-worker, operator-ui all healthy; nlp-worker image rebuilt 2026-05-11 with current Layer 2/3 code. Still missing CI/CD and tests. |
| **Documentation** | **98 %** | README + this status file reflect current implementation. Full re-ingest run captured in `INGEST_RUN_REPORT.md`. Entity-resolution evolution in `project_notes/`. |

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
| **Entity Resolution — Layer 1** | `.../entity_resolution.py` | FEIN deterministic match; populates `canonical_employers`. Carries 100 % of FY2024+FY2025 traffic; dead on FY2020-FY2023 (DOL data quirk). |
| **Entity Resolution — Layer 2** | `.../entity_resolution.py` | `pg_trgm` similarity, blocked by `employer_state`. GIN trigram filter for recall + Python precision gate. |
| **Entity Resolution — Layer 3** | `.../entity_resolution.py` | `pgvector` HNSW cosine over 384-dim sentence-transformer embeddings of `canonical_name`. Encoder shared with `SocClassifier` (no duplicate model load). |
| **Employer embedder** | `.../employer_embedder.py` | Encodes all `canonical_employers.canonical_name` into `employer_embeddings`. Idempotent. Last run: 92,289 vectors in 7m 27s. Run as `pnpm employers:embed`. |
| **Canonical-id backfill (Layer 1 only)** | `.../backfill_canonical_ids.py` | Keyset-paginated CLI that resolves `canonical_employer_id` for orphan `lca_records` via FEIN-only lookup. Idempotent. Run as `pnpm canonical:backfill`. Best for the quick post-ingest sweep on FEIN-having records. |
| **Canonical-id full-cascade backfill** | `.../backfill_canonical_full.py` | New (2026-05-12): full Layer 1/2/3 cascade against `staging.unresolved_employers`. Inserts new `canonical_employers` rows + embeddings on miss. Bulk-updates matching `lca_records` via the new composite expression index. Per-batch encoder calls + `enable_seqscan = off` for ~6× speedup over per-row writes. Smoke test: 73 % Layer 2 hits, 13 % Layer 3, 14 % new-canonical inserts. Run as `pnpm canonical:backfill-full`. |
| **Unresolved-employers queue** | `staging.unresolved_employers` + `worker._write_unresolved` | Aggregated UPSERT queue for records missed by all three layers. 157,612 open after the full re-ingest run (almost entirely pre-2024 records, no FEIN). |
| **NLP Worker** | `.../worker.py` | Async Redis consumer; runs SOC pipeline + 3-layer entity resolution; writes `soc_source`, `requires_review`, `review_reason`, `canonical_employer_id`; UPSERTs misses into `staging.unresolved_employers`. |
| **Reclassify-quarantine** | `.../reclassify_quarantine.py` | LLM-on-residual drain. Now also calls `resolve_fein` inline so quarantine drains never leave `canonical_employer_id` unset. |
| **Operator HITL UI** | `apps/operator-ui` | New: Fastify + EJS web app on port 8080. Walks all three review queues with list / inspect / accept / override / merge / reject actions. Single shared password (`OPERATOR_PASSWORD`) + signed-cookie session (`SESSION_SECRET`). Reuses `@lca/db-lib` pool. Unresolved-employer merges run a transactional `lca_records` backfill. Ships as Docker Compose service `operator-ui`. |
| **Documentation** | `README.md`, `PROJECT_STATUS.md`, `project_notes/` | Architecture, status, plus full evolution narratives for the SOC classifier (`soc_classifier_evolution.md`) and the entity-resolution cascade (`entity_resolution_evolution.md`). |

### Not Yet Implemented

| Item | Notes |
|---|---|
| **BERT fine-tuning pipeline** | **Tested and rejected** — see `project_notes/soc_classifier_evolution.md`. Fine-tuned `bert-base-uncased` on 49 K bootstrap labels lost to Stage 2 retrieval by 11 pp exact / 3 pp major. Documented as a thesis finding. |
| **Stage 3 LLM reclassify at scale** | Code exists; running against 181,839 quarantined records needs batched-LLM mode + GPU (~5–10 h on A10G/L4 vs ~250 h on Mac CPU). |
| **Periodic embedding refresh** | `embed-employers` is one-shot; needs to be wired into the post-ingest flow so Layer 3 sees freshly-inserted canonicals automatically. |
| **Tests** | No test files in any package (JS or Python). |
| **CI/CD** | No GitHub Actions workflows. |
