# LCA Normalization Engine

A high-load monorepo for ingesting, validating, and normalizing **12 million+** historical
LCA (Labor Condition Application) records from the US Department of Labor (DOL), with an
ongoing production pipeline for quarterly updates.

---

## Architecture Overview

```
lca-normalization-engine/
│
├── packages/
│   ├── db-lib/          # Shared PG client: pg-copy-streams, schema DDL, Zod validation helpers
│   └── nlp-engine/      # Python: SOC/BERT classification + 3-layer employer deduplication
│
├── apps/
│   ├── ingestor/        # BullMQ worker: xlstream → validate → COPY to JSONB partitions
│   │                    #   FLAG mode: JOINs LCA_Disclosure + LCA_Worksites + LCA_Appendix_A
│   ├── harvester/       # Cron service: scrapes DOL quarterly releases → Shared Volume → BullMQ
│   └── cli-tool/        # CLI: DB init, schema migrations, task-tree seeding for backfill
│
├── infra/
│   └── postgres/        # init.sql (extensions: pg_trgm, pgvector, btree_gin)
│
└── docker-compose.yml   # Local stack: db, redis, nlp-worker, ingestion-worker
```

### Data Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│  HISTORICAL BACKFILL (one-time)                                          │
│                                                                          │
│  Local Archive ──▶ cli-tool seed ──▶ BullMQ (ingest-tasks)               │
│                                            │                             │
│                                            ▼                             │
│                                    ingestor worker                       │
│                                    (xlstream, ≤250MB RAM)                │
│                                            │                             │
│                          ┌─────────────────┴──────────────────┐          │
│                          ▼                                    ▼          │
│                  valid records                         invalid records   │
│                  pg-copy-streams                       staging.          │
│                  lca_records (JSONB)                   quarantine_records│
│                          │                                               │
│                          ▼                                               │
│                  BullMQ (nlp-tasks) ──▶ nlp-worker (Python)              │
│                                              │                           │
│                                    SOC classification (BERT)             │
│                                    Employer dedup (3-layer)              │
│                                              │                           │
│                                              ▼                           │
│                                    lca_records UPDATE (soc_code,         │
│                                               canonical_employer_id)     │
└──────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  PRODUCTION MODE (ongoing quarterly)                                    │
│                                                                         │
│  DOL Website ──▶ harvester (cron) ──▶ Shared Volume (/data/downloads)   │
│                                              │                          │
│                                              ▼                          │
│                                    BullMQ (ingest-tasks)                │
│                                    (same ingestor + nlp pipeline)       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime (JS) | Node.js 20+ (ESM) | All packages use `"type": "module"` |
| Runtime (Python) | Python 3.11+ | `pyproject.toml`, `src/` layout |
| Database | PostgreSQL 16 | Docker image: `pgvector/pgvector:pg16`; declarative range partitioning by `filing_year` |
| PG extension | `pg_trgm` | Fuzzy company name matching (probabilistic layer) |
| PG extension | `pgvector` | HNSW semantic embeddings (semantic layer); bundled in the `pgvector/pgvector:pg16` image |
| PG extension | `jsonb_path_ops` | GIN operator class — ~60% smaller indexes vs default |
| PG extension | `btree_gin` | Composite GIN + btree indexes |
| Queue | BullMQ 5 on Redis 7 | Flow producers, DLQ, exponential backoff |
| Bulk ingestion | `pg-copy-streams` | `COPY FROM STDIN` — 10–30× faster than `INSERT` |
| XLSX streaming | `xlstream` | Row-level async iterator, bounded memory (≤250MB) |
| Validation (JS) | `zod` | Schema enforcement before every COPY batch |
| Validation (Python) | `pydantic` v2 | NLP job input/output contracts |
| NLP / Classification | `transformers`, `torch` | Fine-tuned BERT for SOC code prediction |
| Semantic embeddings | `sentence-transformers` | Employer name vector embeddings for pgvector |
| Entity Resolution | `dedupe` | Probabilistic record linkage training |
| Package manager | pnpm 9 (workspaces) | `workspace:*` protocol for cross-package linking |

---

## Database Design

### Partitioning

`lca_records` is partitioned by `filing_year` using PostgreSQL 16 declarative range
partitioning. Each annual partition is independently queryable and detachable, which
allows year-scoped bulk operations and efficient `DETACH`/`ATTACH` for archival.

```sql
CREATE TABLE lca_records (
  id            BIGSERIAL,
  filing_year   SMALLINT NOT NULL,
  source_file   TEXT,
  data          JSONB     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, filing_year)
) PARTITION BY RANGE (filing_year);
```

### JSONB Indexing Strategy

| Index | Operator class | Purpose |
|---|---|---|
| GIN on `data` | `jsonb_path_ops` | `@>` containment queries — ~60% smaller than default `jsonb_ops` |
| GIN on `data->>'soc_code'` | btree_gin | Fast equality lookups on classified records |
| GIN on `data->>'employer_name'` | `gin_trgm_ops` | Fuzzy trigram search via `pg_trgm` |
| HNSW on `employer_embedding` | pgvector | Approximate nearest-neighbour for semantic dedup |

### NLP Enrichment Tables

Created by `ensureSchema()` alongside the core tables:

```sql
-- Deduplicated employer registry; canonical target for entity resolution
CREATE TABLE canonical_employers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL,
  fein           TEXT,                   -- UNIQUE when non-null
  employer_city  TEXT,
  employer_state CHAR(2),
  record_count   INT NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 768-dim pgvector embeddings for Layer 3 semantic dedup (HNSW)
CREATE TABLE employer_embeddings (
  employer_id   UUID PRIMARY KEY REFERENCES canonical_employers(id) ON DELETE CASCADE,
  embedding     vector(768),
  model_version TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- BLS Direct Match Title File (DMTF) + human-reviewed aliases for Stage 1 SOC lookup
CREATE TABLE soc_aliases (
  id         BIGSERIAL PRIMARY KEY,
  job_title  TEXT NOT NULL,             -- UNIQUE lower(job_title)
  soc_code   CHAR(7) NOT NULL,
  soc_title  TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'dmtf',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`soc_aliases` is populated by the `load-dmtf` CLI command before the NLP
worker starts. Human-reviewed corrections from `staging.quarantine_records`
can also be merged here to progressively reduce BERT invocations over time.

### Quarantine Schema

Invalid records (Zod/Pydantic validation failures, low-confidence SOC predictions)
are never silently dropped:

```sql
CREATE SCHEMA IF NOT EXISTS staging;

CREATE TABLE staging.quarantine_records (
  id             BIGSERIAL PRIMARY KEY,
  source_file    TEXT,
  filing_year    SMALLINT,
  raw_data       JSONB NOT NULL,
  errors         JSONB NOT NULL,   -- Zod/Pydantic error list
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reprocessed_at TIMESTAMPTZ        -- NULL until successfully reprocessed
);
```

Quarantined records can be corrected and re-ingested idempotently via
`INSERT ... ON CONFLICT DO UPDATE`.

---

## Data Validation & Quarantine

Every batch processed by the ingestor passes through a strict validation gate
**before** being written to `lca_records`:

1. **Schema validation** — Zod (Node.js) enforces required fields, types, and formats
   (e.g., `CASE_NUMBER`, `EMPLOYER_NAME`, `SOC_CODE`, wage ranges).
2. **FEIN format check** — Employer FEIN is validated against the regex
   `^\d{2}-\d{7}$` as a precondition for the deterministic deduplication layer.
3. **Split routing**:
   - Valid records → `bulkCopyJsonb()` → `lca_records`
   - Invalid records → inserted into `staging.quarantine_records` with the full
     Zod error list serialised as JSONB

This guarantees **zero silent data loss** and enables idempotent reprocessing of
quarantined records once upstream data quality issues are resolved.

---

## FLAG System: Multi-File JOIN (2020–2024+)

DOL switched from a single flat disclosure file to the **FLAG system** starting
with FY2020. The ingestor handles this transparently:

| File | Content |
|---|---|
| `LCA_Disclosure_Data_FY<YYYY>.xlsx` | Primary case record (one row per LCA) |
| `LCA_Worksites_FY<YYYY>.xlsx` | Secondary worksite locations (1:N per case) |
| `LCA_Appendix_A_FY<YYYY>.xlsx` | Wage level attestations |

The ingestor detects FLAG-era files by year and performs an in-memory streaming
JOIN on `CASE_NUMBER` across all three files before writing the merged document
into the JSONB `data` column. This keeps downstream queries simple — one row
always represents one complete case with all its worksites and wage data embedded.

---

## Memory Constraint Guarantee

Node.js workers are architecturally bounded to **≤ 250 MB of RSS** regardless
of source file size (individual files can exceed 5 GB):

- **`xlstream`** emits rows as a lazy async iterator — only one row is in memory
  at a time; the rest remains on the filesystem/OS buffer cache.
- **`pg-copy-streams`** pipes directly from a `Readable` stream into the PostgreSQL
  wire protocol without materialising the full batch as a string in the V8 heap.
- Batches are flushed every `INGESTOR_BATCH_SIZE` rows (default: 5,000) and the
  array is garbage-collected immediately.

This design avoids V8 heap exhaustion under `--max-old-space-size` constraints
and makes the worker safe to run at high concurrency on standard container sizes.

---

## Employer Deduplication: 3-Layer Pipeline

The NLP engine resolves employer identity using a layered strategy that balances
precision and recall:

### Layer 1 — Deterministic (FEIN)
Match on Federal Employer Identification Number using the canonical format
`^\d{2}-\d{7}$`. This is a perfect match when available and takes precedence
over all other layers.

### Layer 2 — Probabilistic (pg_trgm)
For records missing a FEIN or with formatting variants, trigram similarity
(`similarity(a, b) > 0.85`) on the `employer_name` field identifies likely
duplicates. Powered by the `pg_trgm` extension.

### Layer 3 — Semantic (pgvector)
Employer name sentences are encoded with `sentence-transformers` into 768-
dimensional vectors and stored in a `pgvector` column. An HNSW approximate
nearest-neighbour index (`m=16, ef_construction=64`) retrieves semantically
similar names that trigram matching misses (e.g., abbreviations, legal-entity
suffixes like "LLC" vs "Inc.").

The three layers are applied in order; the first match wins. Results are written
as `canonical_employer_id` back to `lca_records`.

---

## Prerequisites

- Node.js >= 20
- pnpm >= 9 (`npm i -g pnpm`)
- Python >= 3.11
- Docker & Docker Compose v2 — the stack uses `pgvector/pgvector:pg16` which bundles the `vector` extension; no manual pgvector installation is required

---

## Mode 1: Historical Backfill (one-time)

```bash
# 1. Install all JS dependencies across workspaces
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit DATABASE_URL, REDIS_URL, LOCAL_FILES_DIR

# 3. Start infrastructure
pnpm docker:up
# Waits for db and redis healthchecks before workers start

# 4. Initialise PostgreSQL schema (extensions, partitions, indexes)
pnpm db:init

# 5. Dry-run to verify file discovery (no jobs enqueued)
node apps/cli-tool/index.js seed --files-dir /path/to/lca-archive --dry-run

# 6. Seed the BullMQ task tree (one job per XLSX file, grouped by year)
node apps/cli-tool/index.js seed --files-dir /path/to/lca-archive

# 7. Monitor queue depth
node apps/cli-tool/index.js queue:stats

# 8. Tail worker logs
pnpm docker:logs
```

## Mode 2: Production Run (Ongoing Quarterly Updates)

The `harvester` service runs as a persistent cron process that monitors the DOL
[performance data page](https://www.dol.gov/agencies/eta/foreign-labor/performance)
for newly published quarterly disclosure files.

```bash
# Start only the harvester alongside the shared infrastructure
docker compose up -d db redis nlp-worker ingestion-worker harvester
```

**Internal workflow:**

1. `harvester` polls the DOL page every `HARVESTER_POLL_INTERVAL_MS` (default: 1h).
2. New `.xlsx` links are compared against the `harvested_files` PostgreSQL table.
3. Newly detected files are **downloaded** to the Shared Volume (`/data/downloads`).
4. One `ingest` BullMQ job is enqueued per downloaded file, pointing at the local path.
5. `ingestion-worker` picks up the job and runs the same validation + COPY + NLP
   pipeline used in the historical backfill — no separate code path.

This design means production incremental runs are fully idempotent: re-running the
harvester for an already-processed file is a no-op (blocked at the `harvested_files`
table check).

---

## Workspace Dependency Graph

```
cli-tool ──┐
ingestor ──┤──▶ @lca/db-lib ──▶ PostgreSQL 16
harvester ─┘         │                │
                     │           (pg_trgm, pgvector,
                     │            jsonb_path_ops)
                     │
               zod (validation)

nlp-engine (Python) ──▶ PostgreSQL 16 (soc_code, canonical_employer_id writes)
                    └──▶ Redis (results stream: lca:nlp-results)
```

---

## Commands Reference

All commands are run from the **monorepo root** via `pnpm`.

### Infrastructure (Docker)

| Command | Short | Description |
|---|---|---|
| `pnpm docker:up` | `pnpm up` | Start all Docker services (db, redis, workers) in detached mode |
| `pnpm docker:down` | `pnpm down` | Stop and remove all Docker containers |
| `pnpm docker:logs` | `pnpm logs` | Tail logs from all running Docker services |
| `pnpm docker:build` | — | Rebuild all Docker images (nlp-worker, ingestion-worker) |
| `pnpm docker:restart` | — | Stop all containers and start them again |

### Database

| Command | Description |
|---|---|
| `pnpm db:init` | Initialise PostgreSQL schema — creates extensions (`pg_trgm`, `pgvector`, `btree_gin`), partitioned tables, indexes, and the quarantine schema |

### Data Pipeline

| Command | Description |
|---|---|
| `pnpm seed` | Seed the BullMQ task tree — enqueues one ingest job per XLSX file, grouped by filing year. Pass args via `pnpm seed -- --files-dir /path --dry-run` |
| `pnpm queue:stats` | Display current BullMQ queue depth, active/waiting/completed/failed job counts |
| `pnpm ingestor:start` | Start the ingestor BullMQ worker (XLSX streaming → validation → `COPY` to PostgreSQL) |
| `pnpm ingestor:dev` | Start the ingestor in watch mode — auto-restarts on file changes |
| `pnpm harvester:start` | Start the harvester cron service (polls DOL for new quarterly releases) |
| `pnpm harvester:dev` | Start the harvester in watch mode — auto-restarts on file changes |

### Code Quality

| Command | Description |
|---|---|
| `pnpm lint` | Run ESLint across all JavaScript/TypeScript workspaces recursively |
| `pnpm build` | Build all packages and apps across the monorepo |
| `pnpm test` | Run `node --test` in every workspace that defines a test script |

### NLP Engine (Python)

Run from `packages/nlp-engine/` after installing with `pip install -e ".[dev]"`:

| Command | Description |
|---|---|
| `nlp-worker` | Start the Python NLP worker — listens for BullMQ jobs from Redis |
| `classify-soc` | CLI entry point for SOC code classification using the fine-tuned BERT model |
| `dedup-companies` | CLI entry point for the 3-layer employer deduplication pipeline |
| `load-dmtf --file <path>` | Load BLS Direct Match Title File into `soc_aliases` for Stage 1 exact-match (pass `--url` to download automatically from BLS) |
| `ruff check .` | Lint Python source code |
| `mypy .` | Run static type checking on Python source |
| `pytest` | Run Python test suite |

### Per-Package Scripts

Each workspace exposes its own scripts, runnable via `pnpm --filter <name> run <script>`:

| Package | Scripts |
|---|---|
| `@lca/db-lib` | `test`, `lint` |
| `ingestor` | `start`, `dev`, `test`, `lint` |
| `harvester` | `start`, `dev`, `test`, `lint` |
| `cli-tool` | `start`, `db:init`, `seed`, `test`, `lint` |

---

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | Full PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis / BullMQ connection |
| `DOL_BASE_URL` | `https://www.dol.gov/...` | DOL performance data page |
| `HARVESTER_POLL_INTERVAL_MS` | `3600000` | How often harvester polls DOL (ms) |
| `LOCAL_FILES_DIR` | `./data` | Host path mounted into ingestion-worker |
| `INGESTOR_CONCURRENCY` | `4` | Parallel XLSX files per worker |
| `INGESTOR_BATCH_SIZE` | `5000` | Rows per `COPY` call |
| `NLP_WORKER_CONCURRENCY` | `2` | Parallel NLP jobs per Python worker |
| `NLP_MODEL_PATH` | `/app/models/soc-bert` | Fine-tuned BERT checkpoint path |
| `NLP_DEVICE` | `cpu` | `cpu` or `cuda` |
