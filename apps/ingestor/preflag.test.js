import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPreFlag, normalizePreFlagRecord, ICERT_ALIASES, CANONICAL_KEYS } from './preflag.js';

test('isPreFlag boundary at FY2020 (the FLAG cutover)', () => {
  assert.equal(isPreFlag(2019), true);
  assert.equal(isPreFlag(2018), true);
  assert.equal(isPreFlag(2020), false);
  assert.equal(isPreFlag(2025), false);
  assert.equal(isPreFlag(undefined), false);
  assert.equal(isPreFlag(NaN), false);
});

test('aliases SOC_NAME -> SOC_TITLE and preserves the original', () => {
  const row = { SOC_NAME: 'Software Developers' };
  const applied = normalizePreFlagRecord(row);
  assert.equal(row.SOC_TITLE, 'Software Developers');
  assert.equal(row.SOC_NAME, 'Software Developers'); // non-destructive
  assert.deepEqual(applied, ['SOC_NAME->SOC_TITLE']);
  assert.equal(row._schema_era, 'iCERT');
});

test('never overwrites an existing canonical key', () => {
  const row = { SOC_NAME: 'old', SOC_TITLE: 'already' };
  const applied = normalizePreFlagRecord(row);
  assert.equal(row.SOC_TITLE, 'already');
  assert.deepEqual(applied, []);
});

test('no-op aliasing when the source header is absent', () => {
  const row = { EMPLOYER_NAME: 'ACME' };
  const applied = normalizePreFlagRecord(row);
  assert.deepEqual(applied, []);
  assert.equal(row._schema_era, 'iCERT'); // era still tagged
});

test('canonical set covers the FLAG fields analytics/NLP read', () => {
  for (const k of ['EMPLOYER_NAME', 'EMPLOYER_FEIN', 'SOC_TITLE', 'JOB_TITLE',
    'PREVAILING_WAGE', 'WAGE_RATE_OF_PAY_FROM', 'WORKSITE_STATE', 'NAICS_CODE']) {
    assert.ok(CANONICAL_KEYS.includes(k), `CANONICAL_KEYS missing ${k}`);
  }
  // alias targets must themselves be canonical
  for (const target of Object.values(ICERT_ALIASES)) {
    assert.ok(CANONICAL_KEYS.includes(target), `alias target ${target} not canonical`);
  }
});
