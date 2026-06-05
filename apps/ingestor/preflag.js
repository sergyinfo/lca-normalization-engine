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
 * iCERT-era (FY2015–2019) header → canonical FLAG key.
 *
 * FY2019 overlaps FLAG heavily (employer / wage / worksite / NAICS headers match
 * by name), so this map is tiny. Extend it ONLY after confirming a real header
 * row with inspect-headers.mjs. Known gaps for FY2019, not aliasable (the field
 * simply doesn't exist pre-FLAG): EMPLOYER_FEIN (so Layer-1 FEIN dedup is skipped
 * for that year — ER falls back to trigram/semantic).
 */
export const ICERT_ALIASES = {
  SOC_NAME: 'SOC_TITLE', // iCERT used SOC_NAME; FLAG renamed it SOC_TITLE
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
 * @returns {string[]} the aliases actually applied (e.g. ['SOC_NAME->SOC_TITLE'])
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
