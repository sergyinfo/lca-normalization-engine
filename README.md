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
│   └── nlp-engine/      # Python: 4-stage SOC classifier (consensus / DMTF / semantic / LLM)
│                        #         + 3-layer employer deduplication (FEIN / trgm / pgvector)
│
├── apps/
│   ├── ingestor/        # BullMQ worker: xlstream → validate → COPY to JSONB partitions
│   │                    #   FLAG mode: JOINs LCA_Disclosure + LCA_Worksites + LCA_Appendix_A
│   ├── harvester/       # Cron service: scrapes DOL quarterly releases → Shared Volume → BullMQ
│   ├── cli-tool/        # CLI: DB init, schema migrations, task-tree seeding for backfill
│   ├── operator-ui/     # Fastify + EJS web app (port 8080): walks the three HITL queues
│   │                    #   (requires_review records, staging.quarantine_records,
│   │                    #    staging.unresolved_employers) — accept/override/merge/reject
│   └── analytics-ui/    # Fastify + EJS + Chart.js (port 8081): public read-only dashboard
│                        #   over the canonicalised corpus. Four persona pages backed by
│                        #   12 materialized views in analytics.* schema.
│
├── infra/
│   └── postgres/        # init.sql (extensions: pg_trgm, pgvector, btree_gin)
│
└── docker-compose.yml   # Local stack: db, redis, nlp-worker, ingestion-worker, operator-ui, analytics-ui
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
│                                    SOC classification (DMTF + ST)        │
│                                    Employer dedup (3-layer)              │
│                                              │                           │
│                                              ▼                           │
│                                    lca_records UPDATE (soc_code,         │
│                                               canonical_employer_id)     │
│                                              │                           │
│                          ┌───────────────────┴────────────────────┐      │
│                          ▼                                        ▼      │
│                  requires_review = true                  staging.        │
│                  staging.unresolved_employers            quarantine_     │
│                          │                               records         │
│                          └────────────┬──────────────────┘               │
│                                       ▼                                  │
│                              operator-ui (HITL)                          │
│                              http://localhost:8080                       │
│                              accept / override / merge / reject          │
│                              writes back to lca_records                  │
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
| NLP / Classification | `sentence-transformers`, `torch` | Semantic-retrieval SOC classifier over the BLS DMTF alias corpus |
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

| Index | Operator class / kind | Purpose |
|---|---|---|
| GIN on `data` | jsonb_ops (default) | `@>` containment queries. Note: this is the live shape — README originally specified `jsonb_path_ops` and that's the recommended rebuild target (~60 % smaller). |
| btree partial on `data->>'soc_code'` | btree | Equality lookups on classified records (rows with `soc_code` only) |
| btree partial on `data->>'_nlp_id'` | btree | NLP write-back correlation lookups |
| btree partial on `(lower(data->>'EMPLOYER_NAME'), data->>'EMPLOYER_STATE')` | btree composite expression | Bulk canonical-merge JOINs (`backfill-canonical-full`, Operator UI merges). Drops per-merge UPDATE from ~14 s to ~2 s across all partitions. |
| btree partial on `(id, filing_year) WHERE NOT (data ? 'canonical_employer_id')` | btree | Orphan-record scans during canonical backfill |
| btree partial on `data->>'EMPLOYER_FEIN'` | btree | Reverse FEIN lookups for analytics + consensus refresh |
| GIN trigram on `canonical_employers.canonical_name` | `gin_trgm_ops` | Layer 2 entity-resolution `%` operator + similarity ranking |
| HNSW on `employer_embeddings.embedding` | `vector_cosine_ops` | Layer 3 approximate nearest-neighbour over 384-dim `all-MiniLM-L6-v2` vectors |

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

-- 384-dim pgvector embeddings for Layer 3 semantic dedup (HNSW cosine)
-- Dimension matches the all-MiniLM-L6-v2 sentence-transformer output.
CREATE TABLE employer_embeddings (
  employer_id   UUID PRIMARY KEY REFERENCES canonical_employers(id) ON DELETE CASCADE,
  embedding     vector(384),
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
can also be merged here — every new alias is automatically picked up at the
next NLP-worker restart, both growing the Stage 1 hit rate and improving
Stage 2 retrieval recall (since the encoded alias matrix grows with it).

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
Employer name sentences are encoded with `sentence-transformers/all-MiniLM-L6-v2`
into 384-dimensional vectors and stored in a `pgvector` column. An HNSW
approximate nearest-neighbour index (`m=16, ef_construction=64`) retrieves
semantically similar names that trigram matching misses (e.g., abbreviations,
legal-entity suffixes like "LLC" vs "Inc.").

The three layers are applied in order; the first match wins. Results are written
as `canonical_employer_id` back to `lca_records`.

### A note on FEIN coverage (DOL data quirk)

The DOL changed disclosure-file schemas between FY2023 and FY2024:

| Year | `EMPLOYER_FEIN` populated |
|---|---|
| FY2020 – FY2023 | **0 %** — field absent from the file |
| FY2024 – FY2025 | **100 %** — field present and well-formed |

Layer 1 is therefore data-dead on pre-2024 records: it has nothing to match
against until FY2024 batches surface and populate `canonical_employers`. Once
they do, Layer 2 (`pg_trgm`) and Layer 3 (`pgvector`) cover the older years by
name. The full 6-year re-ingest recorded in
[`INGEST_RUN_REPORT.md`](project_notes/INGEST_RUN_REPORT.md) shows this play out exactly:
`canonical_employers` jumped from 3 to 92,289 the moment FY2024/FY2025 batches
were processed; the subsequent `backfill-canonical-full` cascade then drained
all 157,612 entries from `unresolved_employers` and inserted 53,917 more
canonicals on miss, finishing at **146,206 canonicals and 99.47 % LCA
canonical-id coverage**.

---

## Human-in-the-Loop (Operator UI)

Records the automated pipeline cannot resolve on its own surface in three
queues, all walkable through a browser at `http://localhost:8080` once
`operator-ui` is up:

| Queue | Source | Why records land here |
|---|---|---|
| **Reviews** | `lca_records.data->>'requires_review' = 'true'` | Low Stage 2 confidence; Stage 3 LLM picked a SOC against a literal-string risk (short-title gate) |
| **Quarantine** | `staging.quarantine_records` (`reprocessed_at IS NULL`) | LLM declined to classify; Zod validation failed at ingest |
| **Unresolved** | `staging.unresolved_employers` (`resolved_at IS NULL`) | All three entity-resolution layers (FEIN / `pg_trgm` / `pgvector`) missed |

For each record, the operator can accept the automated pick, override it,
merge an unresolved employer into an existing canonical (with `pg_trgm`
similarity search and a state filter to surface candidates), create a new
canonical, or reject. Merge / create-new transactionally backfills
`canonical_employer_id` on every matching `lca_records` row. The UI is
guarded by a single shared password (`OPERATOR_PASSWORD`) and a signed
session cookie (`SESSION_SECRET`, ≥ 32 chars). See
[`apps/operator-ui/README.md`](apps/operator-ui/README.md) for routes and
write-back semantics.

---

## Analytics Dashboard (Analytics UI)

Public, read-only, persona-driven dashboard over the canonicalised corpus.
Runs at `http://localhost:8081` once `analytics-ui` is up. Four pages:

| Page | Audience | Headline question |
|---|---|---|
| `/journalist` | Public, reporters | Who sponsors H-1Bs, where, how much? |
| `/jobseeker`  | Career researchers | What's the prevailing wage for my role + city? |
| `/policy`     | Labour economists | How is the program evolving over time? |
| `/academic`   | Thesis examiner | How does the pipeline actually produce these numbers? |

Every aggregation panel is backed by a materialized view in the
`analytics.*` schema (12 matviews + 1 plain view, ~29 MB total). This is
what makes the dashboard demoable: a naive `count(*)` on the 3.83 M-row
`lca_records` takes ~75 s cold-cache; reading from the pre-aggregated
matviews paints in 16-552 ms.

Bring up:
```bash
# Build the matviews once (after ingest / backfill)
DATABASE_URL=...  pnpm analytics:bootstrap-views

# Run the app
docker compose up -d analytics-ui                    # http://localhost:8081
# or for host iteration:
pnpm analytics:dev

# Refresh the matviews after a data update
DATABASE_URL=...  pnpm analytics:refresh-views
```

See [`apps/analytics-ui/README.md`](apps/analytics-ui/README.md) for the
files layout and [`project_notes/analytics_ui.md`](project_notes/analytics_ui.md)
for a full data walkthrough (worked examples per persona + analysis).

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

# 5. Seed the SOC alias table for Stage 1 NLP classification (~56K BLS title mappings)
#    Option A — download automatically from BLS (requires outbound internet):
DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db \
  load-dmtf --url
#    Option B — download manually first, then load from file:
#      curl -o dmtf.xlsx "https://www.bls.gov/soc/2018/soc_2018_direct_match_title_file.xlsx"
#      DATABASE_URL=... load-dmtf --file ./dmtf.xlsx
#    Note: load-dmtf is a Python CLI — activate the nlp-engine venv first:
#      source packages/nlp-engine/.venv/bin/activate

# 6. Verify schema and table counts
pnpm db:status

# 7. Dry-run to verify file discovery (only LCA_*.xlsx files are picked up)
#    Default data directory (./data):
pnpm seed -- --dry-run
#    Custom directory:
node apps/cli-tool/index.js seed --files-dir /path/to/lca-archive --dry-run

# 8. Seed the BullMQ task tree (one job per XLSX file, grouped by year)
pnpm seed                                                # uses ./data
node apps/cli-tool/index.js seed --files-dir /path/to/lca-archive  # custom path

# 9. (Recommended after first ingestion) Self-bootstrap the alias corpus
#    Mines high-agreement (JOB_TITLE, SOC_CODE) pairs from already-ingested
#    lca_records and adds them to soc_aliases. Restart nlp-worker afterwards
#    so the larger alias matrix is re-encoded for Stage 2.
pnpm aliases:bootstrap                                   # default thresholds
docker compose restart nlp-worker

# 9. Monitor queue depth
pnpm queue:stats

# 10. Tail worker logs
pnpm docker:logs

# 11. Verify ingestion completed
pnpm db:status

# 12. Walk any HITL queues left by the pipeline (low-confidence SOCs,
#     LLM-refused records, unresolved employers).
#     Set OPERATOR_PASSWORD and SESSION_SECRET in .env first.
docker compose up -d operator-ui   # then open http://localhost:8080

# 13. Bring up the analytics dashboard. Bootstrap matviews once, then start.
DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db \
  pnpm analytics:bootstrap-views
docker compose up -d analytics-ui  # then open http://localhost:8081
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
cli-tool ─────┐
ingestor ─────┤
harvester ────┤──▶ @lca/db-lib ──▶ PostgreSQL 16
operator-ui ──┤         │                │
analytics-ui ─┘         │           (pg_trgm, pgvector,
                        │            jsonb_path_ops)
                        │
                  zod (validation)

nlp-engine (Python) ──▶ PostgreSQL 16 (soc_code, canonical_employer_id writes)
                    └──▶ Redis (results stream: lca:nlp-results)

  Browser ──▶ operator-ui  (Fastify, port 8080, auth)  ──▶ Postgres write-back
                                                             (clears requires_review,
                                                              resolves quarantine,
                                                              merges unresolved)

  Browser ──▶ analytics-ui (Fastify, port 8081, public) ──▶ analytics.mv_* reads
                                                             (4 persona pages,
                                                              12 matviews + 1 view)
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
| `pnpm db:status` | Print installed extensions and live row counts for all tables (`lca_records` by year, `soc_aliases`, `canonical_employers`, `staging.quarantine_records`) |

### Data Pipeline

| Command | Description |
|---|---|
| `pnpm seed` | Seed the BullMQ task tree — enqueues one ingest job per XLSX file, grouped by filing year. Pass args via `pnpm seed -- --files-dir /path --dry-run` |
| `pnpm queue:stats` | Display current BullMQ queue depth, active/waiting/completed/failed job counts |
| `pnpm ingestor:start` | Start the ingestor BullMQ worker (XLSX streaming → validation → `COPY` to PostgreSQL) |
| `pnpm ingestor:dev` | Start the ingestor in watch mode — auto-restarts on file changes |
| `pnpm harvester:start` | Start the harvester cron service (polls DOL for new quarterly releases) |
| `pnpm harvester:dev` | Start the harvester in watch mode — auto-restarts on file changes |
| `pnpm operator:start` | Start the operator HITL web UI (Fastify, default port 8080). Requires `OPERATOR_PASSWORD` and `SESSION_SECRET` (≥32 chars) in `.env`. |
| `pnpm operator:dev` | Start the operator UI in watch mode — auto-restarts on file changes |
| `pnpm analytics:start` | Start the public analytics dashboard (Fastify, default port 8081). No auth. Requires the matviews to be bootstrapped. |
| `pnpm analytics:dev` | Start the analytics UI in watch mode — auto-restarts on file changes |
| `pnpm analytics:bootstrap-views` | Build the 12 `analytics.mv_*` materialized views + the `v_overview_kpis` view. One-shot after a re-ingest. Wall time: ~30-45 min on a 3.83M-row corpus. |
| `pnpm analytics:refresh-views` | Refresh every `analytics.mv_*` materialized view. Run after any pipeline change (ingest / backfill / HITL writes). Wall time: ~5-10 min. |
| `pnpm consensus:refresh` | Rebuild `employer_soc_consensus` from `lca_records` aggregations. Powers Stage 0 of the classifier. Run post-ingest. |
| `pnpm aliases:bootstrap` | Mine consensus `(JOB_TITLE, SOC_CODE)` pairs from `lca_records` into `soc_aliases` (self-supervised). Run post-ingest. |
| `pnpm employers:embed` | Encode every `canonical_employers.canonical_name` lacking an entry in `employer_embeddings` (Layer 3 backfill). Idempotent. |
| `pnpm canonical:backfill` | Layer-1-only orphan sweep — fills `canonical_employer_id` on `lca_records` whose FEIN is already registered as a canonical. Cheap post-ingest housekeeping. |
| `pnpm canonical:backfill-full` | Full Layer 1/2/3 cascade against `staging.unresolved_employers`. Inserts new canonicals on miss, encodes + bulk-backfills matching `lca_records`. Use `--dry-run --limit N` first to sanity-check the layer-hit mix. |
| `pnpm quarantine:reclassify` | Stage 3 LLM-on-residual drain (Ollama / Anthropic). Cost-heavy — recommend GPU or batched-LLM mode for >5K records. |

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
| `classify-soc` | CLI entry point for SOC code classification (DMTF + sentence-transformer retrieval) |
| `dedup-companies` | CLI entry point for the 3-layer employer deduplication pipeline |
| `load-dmtf --file <path>` | Load BLS Direct Match Title File into `soc_aliases` for Stage 1 exact-match (pass `--url` to download automatically from BLS) |
| `bootstrap-aliases --min-hits 5 --min-employers 2 --min-agreement 0.8` | Mine consensus `(title, SOC)` pairs from `lca_records` and add them to `soc_aliases` (self-supervised) |
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
| `operator-ui` | `start`, `dev`, `lint` |
| `analytics-ui` | `start`, `dev`, `lint` |

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
| `NLP_STAGE2_MODEL` | `sentence-transformers/all-MiniLM-L6-v2` | Encoder used for Stage 2 semantic SOC retrieval |
| `NLP_STAGE2_THRESHOLD` | `0.7` | Cosine-similarity cutoff; below it records go to quarantine |
| `NLP_DEVICE` | `cpu` | `cpu` or `cuda` |
| `OPERATOR_PASSWORD` | — | Shared password for the operator HITL UI. Required to start `operator-ui`. |
| `SESSION_SECRET` | — | HMAC key for signing the operator session cookie. **Must be ≥ 32 characters** — generate with `openssl rand -hex 32`. |
| `OPERATOR_UI_PORT` | `8080` | Host port the operator UI binds to |
| `ANALYTICS_UI_PORT` | `8081` | Host port the analytics dashboard binds to |
