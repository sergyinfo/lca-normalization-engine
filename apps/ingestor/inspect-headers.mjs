#!/usr/bin/env node
/**
 * inspect-headers — print an XLSX's header row and diff it against the canonical
 * FLAG schema + the pre-FLAG alias map. Use this to CONFIRM (or extend) the alias
 * map before ingesting a new pre-2020 year. Read-only; reads just the first row.
 *
 *   node apps/ingestor/inspect-headers.mjs /path/to/H-1B_Disclosure_Data_FY2019.xlsx
 *
 * Output tells you, for that file:
 *   ✓ recognized — header already a canonical FLAG key (ingests correctly as-is)
 *   ↦ aliased    — header the alias map renames to a canonical key
 *   ? unknown    — header not read downstream (kept verbatim in JSONB, harmless)
 *   ⚠ missing    — canonical key NOT covered → analytics will be NULL for this year
 *
 * If a "? unknown" header is clearly one of the missing canonical fields under a
 * different name, add it to ICERT_ALIASES in preflag.js and re-run.
 */

import { getXlsxStream } from 'xlstream';
import { CANONICAL_KEYS, ICERT_ALIASES } from './preflag.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node inspect-headers.mjs <file.xlsx>');
  process.exit(2);
}

// Read the LITERAL header row (withHeader:false → first row's cell array). Do NOT
// derive headers from a data row's object keys: xlstream drops keys for empty
// trailing cells, so a column blank in row 1 would be under-reported (it was —
// FY2019's first row hid ~226 columns, incl. all the PREVAILING_WAGE_N blocks).
const stream = await getXlsxStream({ filePath: file, sheet: 0, withHeader: false, ignoreEmpty: false });
let headers = null;
for await (const row of stream) {
  const arr = row.formatted?.arr ?? row.raw?.arr ?? [];
  headers = arr.map((h) => String(h).trim()).filter(Boolean);
  break; // row 0 is the header row
}
if (!headers || headers.length === 0) {
  console.error('no rows / no header row found');
  process.exit(1);
}

const canon = new Set(CANONICAL_KEYS);
const aliasFrom = new Set(Object.keys(ICERT_ALIASES));

const recognized = [];
const aliased = [];
const unknown = [];
for (const h of headers) {
  if (canon.has(h)) recognized.push(h);
  else if (aliasFrom.has(h)) aliased.push(`${h} -> ${ICERT_ALIASES[h]}`);
  else unknown.push(h);
}

// A canonical key is "covered" if it appears directly OR is the target of an
// alias whose source header is present in this file.
const covered = new Set(headers.filter((h) => canon.has(h)));
for (const [oldKey, newKey] of Object.entries(ICERT_ALIASES)) {
  if (headers.includes(oldKey)) covered.add(newKey);
}
const missing = CANONICAL_KEYS.filter((k) => !covered.has(k));

const list = (arr) => (arr.length ? '\n  ' + arr.join('\n  ') : ' none');

console.log(`\nFile: ${file}`);
console.log(`Headers (${headers.length}):${list(headers)}`);
console.log(`\n✓ recognized canonical FLAG keys (${recognized.length}):${list(recognized)}`);
console.log(`\n↦ aliased pre-FLAG → FLAG (${aliased.length}):${list(aliased)}`);
console.log(`\n? unknown — kept in JSONB, not read downstream (${unknown.length}):${list(unknown)}`);
console.log(`\n⚠ canonical keys NOT covered — analytics NULL for this year (${missing.length}):${missing.length ? list(missing) : ' none — full coverage 🎉'}`);
console.log('');
