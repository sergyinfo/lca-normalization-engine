/**
 * Separate SQLite file for API key storage.
 *
 * Why a separate db: lca.db is baked into the Docker image and rebuilt
 * quarterly. Keys must be mutable at runtime (create, revoke, rotate) —
 * mixing them into the same file would force a redeploy for every key
 * operation. Keys live on a volume mount; lca.db is part of the image.
 *
 * Path is configurable via LCA_KEYS_DB_PATH. Default sits next to lca.db
 * for local dev convenience.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const DB_PATH = process.env.LCA_KEYS_DB_PATH
  ?? path.join(process.cwd(), 'data', 'keys.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash     TEXT    NOT NULL UNIQUE,    -- sha256(raw_key)
  key_prefix   TEXT    NOT NULL,           -- first 12 chars of raw key (for "Acme Corp · lcak_abc123..." display)
  name         TEXT    NOT NULL,           -- human label, e.g. "Acme Corp prod"
  tier         TEXT    NOT NULL CHECK (tier IN ('free','pro','enterprise')),
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(key_hash) WHERE revoked_at IS NULL;
`;

declare global {
  // eslint-disable-next-line no-var
  var __keysDb: DatabaseSync | undefined;
}

function open(): DatabaseSync {
  // Make sure the directory exists — the keys.db is created on first write
  // if it doesn't exist yet, which is the right default for "fresh deploy".
  const dir = path.dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function getKeysDb(): DatabaseSync {
  if (!globalThis.__keysDb) globalThis.__keysDb = open();
  return globalThis.__keysDb;
}

/* -------------------------------------------------------------------------- */
/* Row types                                                                  */
/* -------------------------------------------------------------------------- */

export type ApiKeyTier = 'free' | 'pro' | 'enterprise';

export interface ApiKeyRow {
  id: number;
  key_hash: string;
  key_prefix: string;
  name: string;
  tier: ApiKeyTier;
  created_at: number;
  revoked_at: number | null;
}

/* -------------------------------------------------------------------------- */
/* Query helpers                                                              */
/* -------------------------------------------------------------------------- */

export function findActiveByHash(hash: string): ApiKeyRow | null {
  const stmt = getKeysDb().prepare(
    `SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
  ) as StatementSync;
  return (stmt.get(hash) as unknown as ApiKeyRow | undefined) ?? null;
}

export function listKeys(): ApiKeyRow[] {
  const stmt = getKeysDb().prepare(`SELECT * FROM api_keys ORDER BY id ASC`) as StatementSync;
  return stmt.all() as unknown as ApiKeyRow[];
}

export function insertKey(args: {
  hash: string; prefix: string; name: string; tier: ApiKeyTier;
}): number {
  const stmt = getKeysDb().prepare(
    `INSERT INTO api_keys (key_hash, key_prefix, name, tier, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ) as StatementSync;
  const result = stmt.run(args.hash, args.prefix, args.name, args.tier,
    Math.floor(Date.now() / 1000));
  return Number(result.lastInsertRowid);
}

export function revokeKey(id: number): boolean {
  const stmt = getKeysDb().prepare(
    `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
  ) as StatementSync;
  const result = stmt.run(Math.floor(Date.now() / 1000), id);
  return result.changes > 0;
}
