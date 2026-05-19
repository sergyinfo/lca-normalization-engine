#!/usr/bin/env tsx
/**
 * API key management CLI.
 *
 * Usage:
 *   pnpm keys:create --name "Acme Corp prod" --tier pro
 *   pnpm keys:list
 *   pnpm keys:revoke <id>
 *
 * The raw key is shown ONCE at creation — only the sha256 hash is stored.
 * Anyone with the raw key can hit the API; anyone with just the hash cannot.
 *
 * Persists to keys.db (LCA_KEYS_DB_PATH; defaults to ./data/keys.db).
 */

import crypto from 'node:crypto';
import { findActiveByHash, insertKey, listKeys, revokeKey, type ApiKeyTier } from '../lib/keys-db.ts';

const VALID_TIERS: ApiKeyTier[] = ['free', 'pro', 'enterprise'];

function newRawKey(): string {
  // 32 url-safe random bytes → 43-char base64url string, prefixed `lcak_`.
  return 'lcak_' + crypto.randomBytes(32).toString('base64url');
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else { out[key] = true; }
    }
  }
  return out;
}

function fmtTs(epoch: number | null): string {
  return epoch ? new Date(epoch * 1000).toISOString() : '—';
}

function cmdCreate(args: Record<string, string | boolean>) {
  const name = String(args.name ?? '').trim();
  const tier = String(args.tier ?? 'free') as ApiKeyTier;
  if (!name) {
    console.error('Error: --name is required.');
    process.exit(1);
  }
  if (!VALID_TIERS.includes(tier)) {
    console.error(`Error: --tier must be one of ${VALID_TIERS.join(', ')}.`);
    process.exit(1);
  }

  // Loop in case of (astronomically unlikely) hash collision.
  let raw = '';
  for (let i = 0; i < 5; i++) {
    raw = newRawKey();
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    if (!findActiveByHash(hash)) {
      const prefix = raw.slice(0, 12);
      const id = insertKey({ hash, prefix, name, tier });
      console.log('');
      console.log(`Created API key #${id}`);
      console.log(`  name: ${name}`);
      console.log(`  tier: ${tier}`);
      console.log('');
      console.log(`  RAW KEY (save it now — won't be shown again):`);
      console.log('');
      console.log(`    ${raw}`);
      console.log('');
      return;
    }
  }
  console.error('Error: failed to generate a unique key after 5 attempts.');
  process.exit(1);
}

function cmdList() {
  const rows = listKeys();
  if (rows.length === 0) {
    console.log('No keys.');
    return;
  }
  console.log('id  tier        name                                     prefix         created                  revoked');
  console.log('--  ----------  ---------------------------------------  -------------  -----------------------  -----------------------');
  for (const r of rows) {
    const status = r.revoked_at ? 'REVOKED' : 'active';
    console.log(
      `${String(r.id).padEnd(3)} ${r.tier.padEnd(10)} ${r.name.slice(0, 39).padEnd(40)} ${r.key_prefix.padEnd(13)} ${fmtTs(r.created_at).padEnd(23)} ${fmtTs(r.revoked_at)}  [${status}]`,
    );
  }
}

function cmdRevoke(idStr: string | undefined) {
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) {
    console.error('Error: expected a numeric key id.');
    process.exit(1);
  }
  const ok = revokeKey(id);
  if (!ok) {
    console.error(`Error: no active key with id ${id}.`);
    process.exit(1);
  }
  console.log(`Revoked key #${id}.`);
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) {
    console.error('Usage:');
    console.error('  manage-keys create --name "<label>" --tier free|pro|enterprise');
    console.error('  manage-keys list');
    console.error('  manage-keys revoke <id>');
    process.exit(1);
  }
  switch (cmd) {
    case 'create': return cmdCreate(parseArgs(rest));
    case 'list':   return cmdList();
    case 'revoke': return cmdRevoke(rest[0]);
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

main();
