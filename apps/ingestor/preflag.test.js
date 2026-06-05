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

test('maps the primary-worksite _1 block onto the canonical FLAG keys', () => {
  // a slice of a real FY2019 wide row (primary worksite block)
  const row = {
    PREVAILING_WAGE_1: '95000', WAGE_RATE_OF_PAY_FROM_1: '110000',
    WORKSITE_CITY_1: 'Austin', WORKSITE_STATE_1: 'TX', PW_WAGE_LEVEL_1: 'Level II',
  };
  const applied = normalizePreFlagRecord(row);
  assert.equal(row.PREVAILING_WAGE, '95000');
  assert.equal(row.WAGE_RATE_OF_PAY_FROM, '110000');
  assert.equal(row.WORKSITE_CITY, 'Austin');
  assert.equal(row.WORKSITE_STATE, 'TX');
  assert.equal(row.PW_WAGE_LEVEL, 'Level II');
  assert.equal(row.PREVAILING_WAGE_1, '95000'); // non-destructive: original kept
  assert.ok(applied.includes('PREVAILING_WAGE_1->PREVAILING_WAGE'));
  assert.equal(row._schema_era, 'iCERT');
});

test('never overwrites an existing canonical key', () => {
  const row = { PREVAILING_WAGE_1: 'old', PREVAILING_WAGE: 'already' };
  const applied = normalizePreFlagRecord(row);
  assert.equal(row.PREVAILING_WAGE, 'already');
  assert.ok(!applied.includes('PREVAILING_WAGE_1->PREVAILING_WAGE'));
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
