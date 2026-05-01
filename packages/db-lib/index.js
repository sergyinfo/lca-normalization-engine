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

  // Create one partition per year for 10-year historical range (2014-2024)
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - 10;
  for (let y = startYear; y <= currentYear; y++) {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS lca_records_${y}
        PARTITION OF lca_records
        FOR VALUES FROM (${y}) TO (${y + 1});
    `);
  }

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

  await conn.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS employer_embeddings (
      employer_id   UUID PRIMARY KEY REFERENCES canonical_employers(id) ON DELETE CASCADE,
      embedding     vector(768),
      model_version TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
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
}
