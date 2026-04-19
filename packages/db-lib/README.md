# @lca/db-lib

Shared PostgreSQL client library for the LCA Normalization Engine.

## Responsibilities

- **Connection pooling** via `pg.Pool` (singleton, configurable via `DATABASE_URL`)
- **Bulk COPY streaming** — streams thousands of rows per second into JSONB-typed columns using `pg-copy-streams`, bypassing the slow row-by-row INSERT path
- **Schema bootstrap** — declarative partitioned table DDL (`lca_records` partitioned by `filing_year`) + GIN indexes on the JSONB column

## Key Design Decisions

| Decision | Rationale |
|---|---|
| `pg-copy-streams` over `INSERT` | 10–30× faster for bulk loads; critical for 12M-record backfill |
| JSONB column (`data`) | Schema-flexible ingestion; raw DOL fields are heterogeneous across years |
| Declarative range partitioning by `filing_year` | Enables partition pruning for year-scoped queries; easy `DETACH`/`ATTACH` |
| GIN index on `data` | Fast `@>` containment queries without knowing field names upfront |

## API

```js
import { pool, bulkCopyJsonb, ensureSchema, closePool } from '@lca/db-lib';

// Initialise schema (idempotent)
await ensureSchema();

// Bulk-insert 5 000 rows in one COPY call
await bulkCopyJsonb({
  table: 'lca_records',
  rows: batchOfObjects,
});

// Graceful shutdown
await closePool();
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | Full PostgreSQL connection string |
