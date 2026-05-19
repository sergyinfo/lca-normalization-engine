/**
 * Read-only SQLite client. Uses the built-in `node:sqlite` module so we
 * avoid native compilation entirely — no postinstall scripts, no ABI
 * matrix, no prebuild downloads. Stable as of Node 23.5; experimental on
 * 22.5–23.4 (set `--experimental-sqlite` if you must run that range).
 *
 * The build script writes the file; the runtime app reads it. Open in
 * read-only mode in production.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'node:path';
import { existsSync } from 'node:fs';

const DB_PATH = process.env.LCA_SQLITE_PATH
  ?? path.join(process.cwd(), 'data', 'lca.db');

declare global {
  // eslint-disable-next-line no-var
  var __lcaDb: DatabaseSync | undefined;
}

function open(): DatabaseSync {
  if (!existsSync(DB_PATH)) {
    throw new Error(
      `lca.db not found at ${DB_PATH}. Run \`pnpm build:sqlite\` first.`,
    );
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA temp_store = MEMORY');
  return db;
}

export function getDb(): DatabaseSync {
  if (!globalThis.__lcaDb) {
    globalThis.__lcaDb = open();
  }
  return globalThis.__lcaDb;
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
