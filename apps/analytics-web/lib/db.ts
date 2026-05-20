/**
 * Read-only SQLite client. Uses the built-in `node:sqlite` module so we
 * avoid native compilation entirely — no postinstall scripts, no ABI
 * matrix, no prebuild downloads.
 *
 * The build script writes the file; the runtime app reads it. Open in
 * read-only mode in production.
 *
 * Archive support: this module exposes `withArchiveDb(label, fn)` that
 * runs the callback with a scoped DatabaseSync pinned to the archive
 * snapshot at `data/archives/<label>.lca.db`. Existing query helpers
 * (queryAll / queryOne) consult AsyncLocalStorage and pick up the scoped
 * DB transparently, so archive pages can reuse all the same query
 * functions as live pages without parameter passing.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';

const DATA_DIR     = process.env.LCA_SQLITE_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH      = process.env.LCA_SQLITE_PATH ?? path.join(DATA_DIR, 'lca.db');
const ARCHIVES_DIR = path.join(DATA_DIR, 'archives');

declare global {
  // eslint-disable-next-line no-var
  var __lcaDb: DatabaseSync | undefined;
  // eslint-disable-next-line no-var
  var __lcaArchiveDbs: Map<string, DatabaseSync> | undefined;
}

const dbContext = new AsyncLocalStorage<DatabaseSync>();

function openLive(): DatabaseSync {
  if (!existsSync(DB_PATH)) {
    throw new Error(
      `lca.db not found at ${DB_PATH}. Run \`pnpm build:sqlite\` first.`,
    );
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA temp_store = MEMORY');
  return db;
}

function openArchive(label: string): DatabaseSync {
  const archivePath = path.join(ARCHIVES_DIR, `${label}.lca.db`);
  if (!existsSync(archivePath)) {
    throw new Error(`Archive not found: ${label} (expected ${archivePath})`);
  }
  const db = new DatabaseSync(archivePath, { readOnly: true });
  db.exec('PRAGMA temp_store = MEMORY');
  return db;
}

/** Live DB. Cached on globalThis so HMR / module re-evaluation reuse the handle. */
export function getDb(): DatabaseSync {
  // Prefer the scoped DB if a request is inside withArchiveDb().
  const scoped = dbContext.getStore();
  if (scoped) return scoped;
  if (!globalThis.__lcaDb) globalThis.__lcaDb = openLive();
  return globalThis.__lcaDb;
}

/** Archive DB by label ("YYYY-qN"). Throws if the archive doesn't exist. */
export function getArchiveDb(label: string): DatabaseSync {
  if (!globalThis.__lcaArchiveDbs) globalThis.__lcaArchiveDbs = new Map();
  const cache = globalThis.__lcaArchiveDbs;
  let db = cache.get(label);
  if (!db) {
    db = openArchive(label);
    cache.set(label, db);
  }
  return db;
}

/**
 * Run a callback (sync or async) with all `getDb()` calls inside it pinned
 * to the named archive. Propagates through awaits via AsyncLocalStorage.
 */
export function withArchiveDb<T>(label: string, fn: () => T | Promise<T>): T | Promise<T> {
  const db = getArchiveDb(label);
  return dbContext.run(db, fn);
}

/**
 * Typed wrapper helpers — node:sqlite's StatementSync isn't generic over row
 * shape (unlike better-sqlite3), so we hand-cast results. Centralising here
 * keeps the `as unknown as T` cast confined to one file.
 */
export function queryAll<T>(sql: string, ...params: unknown[]): T[] {
  const stmt = getDb().prepare(sql) as StatementSync;
  return stmt.all(...(params as never[])) as unknown as T[];
}

export function queryOne<T>(sql: string, ...params: unknown[]): T | null {
  const stmt = getDb().prepare(sql) as StatementSync;
  const row = stmt.get(...(params as never[]));
  return (row as unknown as T) ?? null;
}
