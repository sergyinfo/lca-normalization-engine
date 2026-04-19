# @lca/db-lib

Shared PostgreSQL 16 client library for the LCA Normalization Engine. Provides
connection pooling, extension bootstrapping, TSV-transform bulk COPY streaming into
partitioned JSONB staging tables, and schema DDL for all three pipeline schemas
(`staging`, `core`, `audit`).

---

## Responsibilities

| Concern | Detail |
|---|---|
| **Connection pooling** | Singleton `pg.Pool` configured via `DATABASE_URL`; shared across all workers in the same process |
| **Extension bootstrap** | `ensureSchema()` installs `pg_trgm`, `pgvector`, `btree_gin`, and `uuid-ossp` before creating any tables |
| **Bulk COPY streaming** | `bulkCopyJsonb()` pipelines JSON row objects through a Node.js `Transform` stream that serialises them to TSV on-the-fly, then feeds the byte stream into `pg-copy-streams` (`COPY FROM STDIN`) — bypassing the row-by-row `INSERT` path entirely |
| **Target table** | Raw ingestion writes to `staging.raw_lca_data` (partitioned by `filing_year`), **not** to `core.lca_applications`; the NLP worker promotes enriched rows downstream |
| **GIN index strategy** | All JSONB GIN indexes are created with the `jsonb_path_ops` operator class for ~60% index size reduction and faster `@>` containment queries |
| **Schema DDL** | Owns idempotent DDL for `staging.raw_lca_data`, `staging.quarantine_records`, `core.lca_applications`, and `audit.harvested_files` |

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| `pg-copy-streams` over `INSERT` | 10–30× faster for bulk loads; critical for the 12M-record backfill and ongoing quarterly ingestion |
| TSV `Transform` stream | `COPY FROM STDIN` requires raw bytes, not JSON strings; serialising to `col1\tcol2\tjson\n` on-the-fly keeps the V8 heap flat and avoids a second serialisation pass inside PostgreSQL |
| `staging.raw_lca_data` as landing table | Decouples raw ingestion throughput from normalisation (SOC enrichment, deduplication); the NLP worker reads from staging and writes to `core.lca_applications` only after enrichment completes |
| JSONB `data` column | DOL field names and types are heterogeneous across fiscal years; a single JSONB column absorbs schema drift without DDL changes |
| Declarative range partitioning by `filing_year` | Enables partition pruning for year-scoped queries; child partitions can be independently `DETACH`ed for archival or reprocessing |
| `jsonb_path_ops` GIN operator class | Supports only `@>` and `@?` operators but produces indexes ~60% smaller than the default `jsonb_ops`; the `@>` containment pattern covers all analytical query patterns used in this system |
| `pg_trgm` extension | Enables `gin_trgm_ops` indexes on `data->>'employer_name'` for sub-linear fuzzy employer name matching (probabilistic dedup layer) |
| `pgvector` extension | Enables HNSW indexes on `employer_embedding` columns for semantic nearest-neighbour employer resolution (semantic dedup layer) |

---

## Schema Layout

```
staging
  ├── raw_lca_data          ← bulk COPY target (partitioned by filing_year)
  └── quarantine_records    ← Zod validation failures; reprocessed via lca-cli

core
  └── lca_applications      ← enriched, production-ready records (post-NLP)

audit
  └── harvested_files       ← tracks every file the harvester has downloaded
```

### `staging.raw_lca_data` DDL (abridged)

```sql
CREATE SCHEMA IF NOT EXISTS staging;

CREATE TABLE staging.raw_lca_data (
  id          BIGSERIAL,
  filing_year SMALLINT    NOT NULL,
  source_file TEXT,
  data        JSONB       NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, filing_year)
) PARTITION BY RANGE (filing_year);

-- jsonb_path_ops: ~60% smaller than default jsonb_ops; covers all @> queries
CREATE INDEX idx_raw_lca_data_gin
  ON staging.raw_lca_data
  USING GIN (data jsonb_path_ops);

-- Trigram index for fuzzy employer name matching (pg_trgm required)
CREATE INDEX idx_raw_lca_data_employer_trgm
  ON staging.raw_lca_data
  USING GIN ((data->>'employer_name') gin_trgm_ops);
```

---

## API

### `ensureSchema()`

Idempotent bootstrap — safe to call on every container start.

```js
import { ensureSchema } from '@lca/db-lib';

// Installs extensions, creates schemas, tables, and all indexes.
// Must be called before any bulkCopyJsonb() invocation.
await ensureSchema();
```

Internally executes in order:
1. `CREATE EXTENSION IF NOT EXISTS pg_trgm`
2. `CREATE EXTENSION IF NOT EXISTS pgvector`
3. `CREATE EXTENSION IF NOT EXISTS btree_gin`
4. `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`
5. Schema + table DDL (`staging`, `core`, `audit`)
6. GIN indexes with `jsonb_path_ops` and `gin_trgm_ops`
7. HNSW index on `employer_embedding` (pgvector)

### `bulkCopyJsonb({ table, columns, rows, client? })`

Streams an array of plain JS objects into a PostgreSQL table via `COPY FROM STDIN`.
Internally uses a `Transform` stream to serialise each object to a TSV line before
it enters the `pg-copy-streams` pipeline — the full batch is never held as a single
string in the V8 heap.

```js
import { bulkCopyJsonb, ensureSchema, closePool } from '@lca/db-lib';

await ensureSchema();

// Bulk-insert a validated batch into the staging table.
// Columns must match the COPY target exactly.
await bulkCopyJsonb({
  table: 'staging.raw_lca_data',
  // TSV column order must match the COPY column list
  columns: ['filing_year', 'source_file', 'data'],
  rows: validatedBatch,   // plain JS objects; Transform handles serialisation
});

// Graceful pool shutdown (call once on process exit)
await closePool();
```

**TSV wire format** (one line per row, tab-separated):

```
2023\tLCA_Disclosure_Data_FY2023_Q1.xlsx\t{"CASE_NUMBER":"I-200-...","EMPLOYER_NAME":"..."}\n
```

PostgreSQL casts the third column directly to JSONB at the wire level — no
intermediate string manipulation inside the database engine.

### `getPool()` / `closePool()`

```js
import { getPool, closePool } from '@lca/db-lib';

const pool = getPool();                  // returns singleton pg.Pool
const client = await pool.connect();
// ... use client for transactional work
client.release();

await closePool();                       // drains pool; call once on SIGTERM
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | Full PostgreSQL 16 connection string |
