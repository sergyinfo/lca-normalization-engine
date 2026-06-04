/**
 * @lca/db-lib
 *
 * Shared PostgreSQL client library.
 * Provides connection pooling, bulk COPY streaming into JSONB partitioned tables,
 * and schema migration helpers.
 *
 * Usage:
 *   import { pool, bulkCopyJsonb, runMigrations } from '@lca/db-lib';
 */

import pg from 'pg';
import pgCopyStreams from 'pg-copy-streams';
import { Readable, pipeline } from 'node:stream';
import { promisify } from 'node:util';

const { Pool } = pg;
const { from: copyFrom } = pgCopyStreams;
const pipelineAsync = promisify(pipeline);

// ---------------------------------------------------------------------------
// Connection pool (singleton)
// ---------------------------------------------------------------------------

let _pool = null;

/**
 * Returns a singleton pg.Pool.
 * Reads DATABASE_URL from the environment by default.
 *
 * @param {string} [connectionString]
 * @returns {pg.Pool}
 */
export function getPool(connectionString) {
  if (!_pool) {
    _pool = new Pool({
      connectionString: connectionString ?? process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    _pool.on('error', (err) => {
      console.error('[db-lib] Unexpected pool error', err);
    });
  }
  return _pool;
}

/** @deprecated Use getPool() directly for lazy access. */
export const pool = new Proxy({}, {
  get(_, prop) {
    const p = getPool();
    const val = p[prop];
    return typeof val === 'function' ? val.bind(p) : val;
  },
});

/**
 * Gracefully shut down the connection pool.
 */
export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

// ---------------------------------------------------------------------------
// Bulk COPY streaming (JSONB)
// ---------------------------------------------------------------------------

/**
 * Streams rows into a PostgreSQL table using COPY FROM STDIN.
 *
 * Supports two calling conventions:
 *   1. Single JSONB column:  { table, column, rows: [obj, ...] }
 *   2. Multi-column:         { table, columns: ['a','b','data'], rows: [[v1,v2,obj], ...] }
 *
 * @param {object}   opts
 * @param {string}   opts.table           - Target table name
 * @param {string}   [opts.column]        - Single column name (legacy, default: 'data')
 * @param {string[]} [opts.columns]       - Multiple column names
 * @param {Array}    opts.rows            - Array of objects (single) or arrays (multi)
 * @param {pg.PoolClient} [opts.client]   - Existing client (uses pool if omitted)
 * @returns {Promise<number>}             - Number of rows inserted
 */
export async function bulkCopyJsonb({ table, column = 'data', columns, rows, client }) {
  const shouldRelease = !client;
  const conn = client ?? (await getPool().connect());

  try {
    const colList = columns ? columns.join(', ') : column;
    const sql = `COPY ${table} (${colList}) FROM STDIN`;
    const copyStream = conn.query(copyFrom(sql));

    const readable = Readable.from(
      rows.map((row) => {
        if (Array.isArray(row)) {
          // Multi-column: tab-separated, with COPY text-format escaping
          return row.map((v) => {
            if (v == null) return '\\N';
            const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
            // Escape backslash, tab, newline, carriage return for COPY text format
            return str.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
          }).join('\t') + '\n';
        }
        // Single JSONB column (legacy)
        return JSON.stringify(row) + '\n';
      }),
    );

    await pipelineAsync(readable, copyStream);
    return rows.length;
  } finally {
    if (shouldRelease) conn.release();
  }
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/**
 * Creates the core LCA partitioned table (by filing_year) if it doesn't exist.
 * This is the canonical DDL; run once during DB initialisation.
 *
 * @param {pg.PoolClient|pg.Pool} [conn] - defaults to pool
 */
export async function ensureSchema(conn = pool) {
  // Extensions first — every index/column below depends on at least one.
  // pg_trgm  → GIN trigram index on canonical_employers (Layer 2 resolver).
  // vector   → employer_embeddings.vector(384)            (Layer 3 resolver).
  // btree_gin / btree_gist are not used here but cheap if pre-installed.
  await conn.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
  await conn.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS lca_records (
      id            BIGSERIAL,
      filing_year   SMALLINT NOT NULL,
      source_file   TEXT,
      data          JSONB NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id, filing_year)
    ) PARTITION BY RANGE (filing_year);
  `);

  // Year partitions for [START .. currentYear+1]. START is configurable via
  // LCA_PARTITION_START_YEAR (default 2020 — the floor of data we actually
  // ingest; see the harvester's HARVEST_START_YEAR). Lowering the floor adds the
  // missing year partitions on the next db:init. CAVEAT: if the DEFAULT
  // partition below already holds rows for a year you're adding, Postgres won't
  // attach the new partition until those rows are drained/detached out of DEFAULT.
  const currentYear = new Date().getFullYear();
  const startYear = Number(process.env.LCA_PARTITION_START_YEAR ?? 2020);
  for (let y = startYear; y <= currentYear + 1; y++) {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS lca_records_${y}
        PARTITION OF lca_records
        FOR VALUES FROM (${y}) TO (${y + 1});
    `);
  }
  // Catch-all DEFAULT partition: an out-of-range filing_year (e.g. a stray
  // pre-floor or mislabelled file) lands here instead of making the entire COPY
  // batch hard-fail with "no partition found for row". The harvester's year
  // floor should keep this empty in normal operation; rows here are a signal to
  // investigate (wrong-year file, bad parse).
  await conn.query(`
    CREATE TABLE IF NOT EXISTS lca_records_overflow
      PARTITION OF lca_records DEFAULT;
  `);

  // JSONB GIN index for arbitrary field search
  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_lca_records_data_gin
      ON lca_records USING GIN (data);
  `);

  // Partial index for SOC code lookups (common query path)
  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_lca_records_soc_code
      ON lca_records ((data->>'soc_code'))
      WHERE data->>'soc_code' IS NOT NULL;
  `);

  // Expression index for NLP write-back lookups by correlation UUID
  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_lca_records_nlp_id
      ON lca_records ((data->>'_nlp_id'))
      WHERE data->>'_nlp_id' IS NOT NULL;
  `);

  // Composite expression index for bulk canonical-employer backfill joins.
  // Hit by: `mergeUnresolved` / `createCanonicalAndMerge` in operator-ui and
  // the `backfill-canonical-full` CLI. Without this, every unresolved-row
  // merge does a sequential scan of lca_records to find matching rows.
  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_lca_records_employer_name_state
      ON lca_records (lower(data->>'EMPLOYER_NAME'), (data->>'EMPLOYER_STATE'));
  `);

  // Partial index over rows still missing canonical_employer_id. Used by the
  // backfill CLIs to find orphans without scanning the full 3.8M+ row table.
  // Index size is bounded by the size of the quarantine + unresolved-mass pile
  // (~5% of lca_records), so it stays cheap.
  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_lca_records_canonical_missing
      ON lca_records (id, filing_year)
      WHERE NOT (data ? 'canonical_employer_id');
  `);

  // Partial expression index on EMPLOYER_FEIN. Layer 1 lookups go against
  // canonical_employers.fein (already indexed), but reverse lookups from
  // lca_records → canonical (when bulk-bootstrapping consensus or analytics)
  // benefit from a btree on the JSONB-extracted value.
  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_lca_records_employer_fein
      ON lca_records ((data->>'EMPLOYER_FEIN'))
      WHERE data->>'EMPLOYER_FEIN' IS NOT NULL;
  `);

  // Partial index for the operator-ui Reviews queue. The Reviews list and
  // the dashboard count both filter by data->>'requires_review' = 'true'.
  // Without this index a 3.83M-row seq scan is required even when the
  // queue is empty — 30s+ per page paint. The partial index covers only
  // flagged rows (usually << 1% of the corpus), so it stays tiny.
  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_lca_records_requires_review
      ON lca_records (filing_year DESC, id ASC)
      WHERE data->>'requires_review' = 'true';
  `);

  // ---------------------------------------------------------------------------
  // NLP enrichment tables
  // ---------------------------------------------------------------------------

  await conn.query(`
    CREATE TABLE IF NOT EXISTS canonical_employers (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      canonical_name TEXT NOT NULL,
      fein          TEXT,
      employer_city TEXT,
      employer_state CHAR(2),
      record_count  INT NOT NULL DEFAULT 1,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await conn.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_employers_fein
      ON canonical_employers (fein)
      WHERE fein IS NOT NULL;
  `);

  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_canonical_employers_name_trgm
      ON canonical_employers USING GIN (canonical_name gin_trgm_ops);
  `);

  // Embedding dim must match the Stage 2 sentence-transformer.
  // (`vector` extension is created at the top of this function.)
  // all-MiniLM-L6-v2 → 384.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS employer_embeddings (
      employer_id   UUID PRIMARY KEY REFERENCES canonical_employers(id) ON DELETE CASCADE,
      embedding     vector(384),
      model_version TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_employer_embeddings_hnsw
      ON employer_embeddings
      USING hnsw (embedding vector_cosine_ops);
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS soc_aliases (
      id            BIGSERIAL PRIMARY KEY,
      job_title     TEXT NOT NULL,
      soc_code      CHAR(7) NOT NULL,
      soc_title     TEXT NOT NULL,
      source        TEXT NOT NULL DEFAULT 'dmtf',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await conn.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_soc_aliases_title_lower
      ON soc_aliases (lower(job_title));
  `);

  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_soc_aliases_soc_code
      ON soc_aliases (soc_code);
  `);

  // Stage 0 — per-employer SOC consensus, refreshed periodically from lca_records.
  // When an employer has filed the same JOB_TITLE many times with the same SOC,
  // we trust their own self-consistent labelling over generic NLP.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS employer_soc_consensus (
      fein            TEXT      NOT NULL,
      job_title_norm  TEXT      NOT NULL,
      soc_code        CHAR(7)   NOT NULL,
      soc_title       TEXT      NOT NULL,
      hits            INTEGER   NOT NULL,
      agreement       REAL      NOT NULL,
      refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (fein, job_title_norm)
    );
  `);

  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_employer_soc_consensus_lookup
      ON employer_soc_consensus (fein, job_title_norm);
  `);

  // Quarantine schema for invalid / low-confidence records
  await conn.query(`CREATE SCHEMA IF NOT EXISTS staging;`);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS staging.quarantine_records (
      id              BIGSERIAL PRIMARY KEY,
      source_file     TEXT,
      filing_year     SMALLINT,
      raw_data        JSONB NOT NULL,
      errors          JSONB NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reprocessed_at  TIMESTAMPTZ
    );
  `);

  // Partial index supporting both the dashboard count and the Quarantine
  // list (ORDER BY created_at DESC, id DESC). With only the PK present
  // both queries seq-scan a 180K+ row table; the partial index drops them
  // to single-digit ms.
  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_quarantine_records_open
      ON staging.quarantine_records (created_at DESC, id DESC)
      WHERE reprocessed_at IS NULL;
  `);

  // Operator queue for records whose employer couldn't be resolved by any
  // entity-resolution layer. Aggregated by (name, state) with a hits counter
  // so this stays a small review list rather than a per-record log.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS staging.unresolved_employers (
      id                 BIGSERIAL PRIMARY KEY,
      employer_name      TEXT      NOT NULL,
      employer_state     CHAR(2),
      employer_fein      TEXT,
      employer_city      TEXT,
      hits               INTEGER   NOT NULL DEFAULT 1,
      first_nlp_id       TEXT,
      first_filing_year  SMALLINT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at        TIMESTAMPTZ,
      resolved_to_id     UUID REFERENCES canonical_employers(id) ON DELETE SET NULL
    );
  `);

  await conn.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unresolved_employers_name_state
      ON staging.unresolved_employers (lower(employer_name), COALESCE(employer_state, ''));
  `);

  // Partial index for the Unresolved queue list (sorted by hits DESC) and
  // the dashboard count. Without it, every page paint seq-scans the table.
  await conn.query(`
    CREATE INDEX IF NOT EXISTS idx_unresolved_employers_open
      ON staging.unresolved_employers (hits DESC, updated_at DESC)
      WHERE resolved_at IS NULL;
  `);
}
