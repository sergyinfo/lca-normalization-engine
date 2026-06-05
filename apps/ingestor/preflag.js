/**
 * Pre-FLAG (iCERT-era, FY2008–2019) → FLAG (FY2020+) field normalization.
 *
 * DOL switched to the FLAG case-management system in FY2020. Pre-FLAG disclosure
 * files use partly-different column headers, so rows ingested from them would
 * read NULL on the canonical keys the NLP + analytics layers expect. This renames
 * the divergent headers to the canonical FLAG keys — non-destructively (the
 * original key is kept too) — so one ingest path serves both eras.
 *
 * The alias map is intentionally small + isolated. CONFIRM it against a real
 * file's header row before trusting a new year:
 *   node apps/ingestor/inspect-headers.mjs <file.xlsx>
 * Unknown headers are harmless — they're preserved verbatim in the JSONB, just
 * not read downstream.
 */

/** Canonical FLAG keys the downstream NLP + analytics actually read. */
export const CANONICAL_KEYS = [
  'CASE_STATUS', 'EMPLOYER_NAME', 'EMPLOYER_FEIN', 'EMPLOYER_CITY', 'EMPLOYER_STATE',
  'JOB_TITLE', 'SOC_CODE', 'SOC_TITLE', 'NAICS_CODE',
  'PREVAILING_WAGE', 'PW_UNIT_OF_PAY', 'PW_WAGE_LEVEL',
  'WAGE_RATE_OF_PAY_FROM', 'WAGE_UNIT_OF_PAY',
  'WORKSITE_CITY', 'WORKSITE_STATE',
];

/**
 * Pre-FLAG header → canonical FLAG key (confirmed against the real FY2019 file,
 * 260 columns, via inspect-headers.mjs).
 *
 * The pre-FLAG disclosure file is a WIDE multi-worksite layout: each case carries
 * up to 10 worksites inline, each a block suffixed _1…_10 (WORKSITE_*_N,
 * WAGE_RATE_OF_PAY_*_N, PREVAILING_WAGE_N, PW_*_N). FLAG (FY2020+) normalized this
 * to ONE primary worksite per Disclosure row with unsuffixed names (the extra
 * worksites moved to the separate Worksites file we don't join — out of scope).
 * So we map the PRIMARY worksite block (_1) onto the canonical FLAG keys; the
 * _2…_10 blocks stay verbatim in the JSONB, unread (same as the FLAG worksite-join
 * being out of scope). Identical-name fields (CASE_STATUS, JOB_TITLE, SOC_CODE,
 * SOC_TITLE, EMPLOYER_NAME/CITY/STATE, NAICS_CODE) need no alias.
 *
 * Genuinely absent in FY2019 (not aliasable): EMPLOYER_FEIN — so Layer-1 FEIN
 * dedup is skipped for that year and ER falls back to trigram/semantic.
 *
 * CONFIRM against a real header row before trusting a NEW year:
 *   node apps/ingestor/inspect-headers.mjs <file.xlsx>
 */
export const ICERT_ALIASES = {
  WORKSITE_CITY_1: 'WORKSITE_CITY',
  WORKSITE_STATE_1: 'WORKSITE_STATE',
  WAGE_RATE_OF_PAY_FROM_1: 'WAGE_RATE_OF_PAY_FROM',
  WAGE_UNIT_OF_PAY_1: 'WAGE_UNIT_OF_PAY',
  PREVAILING_WAGE_1: 'PREVAILING_WAGE',
  PW_UNIT_OF_PAY_1: 'PW_UNIT_OF_PAY',
  PW_WAGE_LEVEL_1: 'PW_WAGE_LEVEL',
};

/** True for pre-FLAG fiscal years (< 2020). */
export function isPreFlag(filingYear) {
  return Number.isInteger(filingYear) && filingYear < 2020;
}

/**
 * Rename pre-FLAG headers to canonical FLAG keys in-place (non-destructive: the
 * original key is preserved). Tags the record with its schema era for traceability.
 *
 * @param {Record<string, unknown>} record  one parsed XLSX row
 * @param {Record<string, string>} [aliases] header→canonical map (default iCERT)
 * @returns {string[]} the aliases actually applied (e.g. ['PREVAILING_WAGE_1->PREVAILING_WAGE'])
 */
export function normalizePreFlagRecord(record, aliases = ICERT_ALIASES) {
  const applied = [];
  for (const [oldKey, newKey] of Object.entries(aliases)) {
    if (record[oldKey] !== undefined && record[newKey] === undefined) {
      record[newKey] = record[oldKey];
      applied.push(`${oldKey}->${newKey}`);
    }
  }
  record._schema_era = 'iCERT';
  return applied;
}
