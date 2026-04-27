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
 * Streams an array of plain JS objects into a PostgreSQL table using COPY FROM STDIN.
 * Each object is serialised as a single JSONB column row.
 *
 * The target table must have the shape:
 *   CREATE TABLE <table> (data JSONB NOT NULL, ...);
 *
 * @param {object}   opts
 * @param {string}   opts.table         - Target table name (e.g. 'lca_records')
 * @param {string}   [opts.column]      - JSONB column name (default: 'data')
 * @param {object[]} opts.rows          - Array of plain objects to insert
 * @param {pg.PoolClient} [opts.client] - Existing client (uses pool if omitted)
 * @returns {Promise<number>}           - Number of rows inserted
 */
export async function bulkCopyJsonb({ table, column = 'data', rows, client }) {
  const shouldRelease = !client;
  const conn = client ?? (await pool.connect());

  try {
    const sql = `COPY ${table} (${column}) FROM STDIN`;
    const copyStream = conn.query(copyFrom(sql));

    // Build a newline-delimited JSON stream (one JSON object per line)
    const readable = Readable.from(
      rows.map((row) => JSON.stringify(row) + '\n'),
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
}
