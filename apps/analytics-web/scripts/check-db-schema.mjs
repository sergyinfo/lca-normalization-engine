#!/usr/bin/env node
/**
 * CI guard: verify the baked lca.db has every table + column the frontend code
 * expects (per lib/schema.ts).
 *
 * The Lambda image bakes a PREBUILT lca.db pulled from S3. If that db was
 * produced by an older `build-sqlite` than the current code, the Next SSG
 * prerender dies deep inside a page with a cryptic `no such column: X` and the
 * whole `docker build` fails ~30s in with no obvious cause. This guard runs
 * right after the pull and fails fast with an actionable message instead.
 *
 * Pure Node builtins (no pnpm install needed). Parses SCHEMA_SQL as text rather
 * than importing the TS module, so it needs no transpile step.
 *
 * Usage: node apps/analytics-web/scripts/check-db-schema.mjs [path/to/lca.db]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '../lib/schema.ts');
const dbPath = resolve(process.cwd(), process.argv[2] ?? 'apps/analytics-web/data/lca.db');

// ---- 1. expected: parse CREATE TABLE blocks out of SCHEMA_SQL -------------
const schemaSrc = readFileSync(schemaPath, 'utf8');
const sqlMatch = schemaSrc.match(/SCHEMA_SQL\s*=\s*`([\s\S]*?)`;/);
if (!sqlMatch) {
  console.error('✗ could not find the SCHEMA_SQL template in', schemaPath);
  process.exit(2);
}
// Strip `-- …` line comments first: they contain commas ("e.g.", JSON shapes)
// that would otherwise split into phantom columns.
const sql = sqlMatch[1].replace(/--[^\n]*/g, '');

const CONSTRAINT = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i;
/** table name -> Set(column names) */
const expected = {};

const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)\s*\(/gi;
let m;
while ((m = createRe.exec(sql))) {
  const table = m[1];
  // Capture the balanced-paren table body starting at the '(' that closed the match.
  let depth = 0;
  let body = '';
  for (let i = createRe.lastIndex - 1; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') { depth++; if (depth === 1) continue; }
    else if (ch === ')') { depth--; if (depth === 0) break; }
    body += ch;
  }
  // Split on top-level commas (so CHECK (id = 1) / PRIMARY KEY (a, b) stay intact),
  // then take the first identifier of each definition that isn't a table constraint.
  const cols = new Set();
  let seg = '';
  let d = 0;
  const take = (s) => {
    const t = s.trim();
    if (!t || CONSTRAINT.test(t)) return;
    const name = t.match(/^[`"]?([A-Za-z_]\w*)[`"]?/);
    if (name) cols.add(name[1]);
  };
  for (const ch of body) {
    if (ch === '(') d++;
    else if (ch === ')') d--;
    if (ch === ',' && d === 0) { take(seg); seg = ''; } else seg += ch;
  }
  take(seg);
  expected[table] = cols;
}

// ---- 2. actual: read the db ----------------------------------------------
let db;
try {
  db = new DatabaseSync(dbPath);
} catch (e) {
  console.error('✗ cannot open', dbPath, '—', e.message);
  process.exit(2);
}

const problems = [];
for (const [table, cols] of Object.entries(expected)) {
  let info = [];
  try { info = db.prepare(`PRAGMA table_info(${table})`).all(); } catch { /* missing table */ }
  if (info.length === 0) { problems.push(`missing TABLE   ${table}`); continue; }
  const have = new Set(info.map((r) => r.name));
  for (const c of cols) if (!have.has(c)) problems.push(`missing COLUMN  ${table}.${c}`);
}
db.close();

// ---- 3. verdict -----------------------------------------------------------
if (problems.length) {
  console.error('\n✗ lca.db is OUT OF SYNC with lib/schema.ts:\n');
  for (const p of problems) console.error('   - ' + p);
  console.error('\nThe baked db (pulled from S3) was produced by an OLDER build-sqlite than the');
  console.error('current code, so the SSG prerender would fail. Regenerate it before deploying:');
  console.error('   • Fire a box rebuild (NLP_REPLICAS=0) — rebuilds lca.db from Postgres and');
  console.error('     republishes s3://<LcaDbBucket>/candidates/last/lca.db — then re-run this deploy.');
  console.error('   • Or locally: pnpm --filter analytics-web build:sqlite, then publish via');
  console.error('     infra/aws/scripts/migrate-from-local.sh --push-local-db.');
  process.exit(1);
}
console.log(`✓ lca.db schema matches lib/schema.ts (${Object.keys(expected).length} tables checked)`);
