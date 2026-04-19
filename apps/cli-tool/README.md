# cli-tool (lca-cli)

CLI script for database initialisation, BullMQ task-tree seeding, queue inspection,
and quarantine reprocessing for the LCA Data Normalization pipeline.

---

## Commands

| Command | Description |
|---|---|
| `lca-cli db:init` | Bootstrap PostgreSQL: install extensions, create partitioned schema, build optimised indexes |
| `lca-cli seed --files-dir <path>` | Build a BullMQ Flow (parent-child task tree) from a local XLSX archive, with FLAG file grouping |
| `lca-cli queue:stats` | Print per-queue job counts: waiting / active / completed / failed / delayed |
| `lca-cli queue:drain` | **Destructive** — flush all waiting jobs from `ingest-tasks` |
| `lca-cli reprocess:quarantine` | Idempotently re-enqueue failed records from `staging.quarantine_records` or the BullMQ DLQ |

---

## `db:init` — What It Does

`db:init` is more than a schema creator. It runs a full, idempotent bootstrap sequence:

1. **Install PostgreSQL extensions**
   - `pg_trgm` — trigram similarity for probabilistic employer name matching
   - `pgvector` — HNSW index for semantic employer embeddings
   - `btree_gin` — composite GIN + btree index support

2. **Create the partitioned table**
   ```sql
   CREATE TABLE lca_records (
     id          BIGSERIAL,
     filing_year SMALLINT NOT NULL,
     data        JSONB    NOT NULL,
     ...
     PRIMARY KEY (id, filing_year)
   ) PARTITION BY RANGE (filing_year);
   ```
   One child partition per year is created for the 10-year historical range.

3. **Build optimised indexes**
   - GIN on `data` using `jsonb_path_ops` (≈60% smaller than default `jsonb_ops`)
   - Trigram GIN on `data->>'employer_name'` via `gin_trgm_ops`
   - HNSW index on `employer_embedding` via `pgvector`

4. **Create the quarantine schema**
   ```sql
   CREATE SCHEMA IF NOT EXISTS staging;
   CREATE TABLE IF NOT EXISTS staging.quarantine_records (...);
   ```

All steps use `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` — safe to run repeatedly
without side effects.

---

## `seed` — BullMQ Flow (Task Tree)

The `seed` command does **not** flat-add individual jobs. It builds a
**BullMQ Flow** — a parent-child job tree — so that year-level progress is
visible in the queue dashboard and child failures do not block sibling years.

### Job Tree Structure

```
ingest-tasks (Flow)
├── [Parent] FY2014
│   ├── [Child] LCA_Disclosure_Data_FY2014_Q1.xlsx
│   ├── [Child] LCA_Disclosure_Data_FY2014_Q2.xlsx
│   └── ...
├── [Parent] FY2020  ← FLAG era begins
│   ├── [Child:Group] Q1
│   │   ├── LCA_Disclosure_Data_FY2020_Q1.xlsx
│   │   ├── LCA_Worksites_FY2020_Q1.xlsx
│   │   └── LCA_Appendix_A_FY2020_Q1.xlsx
│   └── [Child:Group] Q2
│       └── ...
└── [Parent] FY2024
    └── ...
```

Parent jobs are created via BullMQ's `FlowProducer`. A parent transitions to
`completed` only after **all** its child jobs succeed, enabling year-granular
progress tracking and targeted retries.

### FLAG File Grouping (Post-2020)

Starting with FY2020, the DOL FLAG system publishes multiple related files per
quarter. The `seed` command detects FLAG-era archives by year and groups the
three file types into a single logical child unit:

| File pattern | Role |
|---|---|
| `LCA_Disclosure_Data_FY<YYYY>_Q<N>.xlsx` | Primary case record |
| `LCA_Worksites_FY<YYYY>_Q<N>.xlsx` | Secondary worksite locations (1:N) |
| `LCA_Appendix_A_FY<YYYY>_Q<N>.xlsx` | Wage level attestations |

The ingestor receives the full group as a single job payload and performs an
in-memory streaming JOIN on `CASE_NUMBER` before writing the merged document
into the JSONB `data` column.

---

## `reprocess:quarantine` — Idempotent Failure Recovery

Records that fail Zod validation during ingestion are never dropped — they land
in `staging.quarantine_records`. The `reprocess:quarantine` command provides a
selective, safe path to retry them after the underlying data quality issue is resolved.

### Behaviour

1. Queries `staging.quarantine_records WHERE reprocessed_at IS NULL` (or filters
   by `--source-file` / `--filing-year`).
2. Re-validates each raw JSONB record against the current Zod schema.
3. Rows that now pass are re-inserted into `lca_records` using
   `INSERT ... ON CONFLICT (id, filing_year) DO UPDATE` — preventing duplicates
   if the record was partially written in a prior attempt.
4. Rows that still fail remain in quarantine; their `errors` column is updated
   with the latest validation output.
5. Successfully reprocessed rows have `reprocessed_at` stamped with the current
   timestamp.

```bash
# Reprocess all quarantined records
lca-cli reprocess:quarantine

# Reprocess only a specific source file
lca-cli reprocess:quarantine --source-file LCA_Disclosure_Data_FY2021_Q3.xlsx

# Reprocess a specific filing year
lca-cli reprocess:quarantine --filing-year 2021

# Dry-run: report counts without writing
lca-cli reprocess:quarantine --dry-run
```

---

## Historical Backfill Workflow

```bash
# 1. Bootstrap the database (extensions, partitions, indexes, quarantine schema)
node apps/cli-tool/index.js db:init

# 2. Dry-run to verify file discovery and FLAG grouping
node apps/cli-tool/index.js seed --files-dir /data/lca-archive --dry-run

# 3. Seed the BullMQ Flow task tree (workers must be running)
node apps/cli-tool/index.js seed --files-dir /data/lca-archive

# 4. Monitor the queue hierarchy
node apps/cli-tool/index.js queue:stats

# 5. After ingestion completes, reprocess any quarantined records
node apps/cli-tool/index.js reprocess:quarantine
```

---

## Advanced Features

### BullMQ Flows

`FlowProducer` creates atomic parent-child job relationships in a single Redis
transaction. This means:

- A parent job is only marked `completed` when every child finishes successfully.
- Failed children are retried independently (with exponential backoff) without
  affecting other years.
- The BullMQ dashboard (Bull Board) displays the tree hierarchy, giving a clear
  view of per-year and per-quarter ingestion progress.

### FLAG File Grouping

The `seed` command uses a filename-pattern heuristic to identify FLAG-era files
and group them by year + quarter before creating child job payloads. The grouping
key is `FY<YYYY>_Q<N>` extracted from the filename. If a quarter is missing one
of its three files (e.g., `LCA_Appendix_A` is absent), the group is still enqueued
with a `missingFiles` flag so the ingestor can handle it gracefully rather than fail.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis / BullMQ connection |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `DEFAULT_FILES_DIR` | `./data/lca-archive` | Default archive path for `seed` |
