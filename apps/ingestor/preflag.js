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
 * Pre-FLAG header → canonical FLAG key. Confirmed against the real FY2010–FY2019
 * files via inspect-headers.mjs. Pre-FLAG spans three schema FAMILIES (the parse is
 * identical for all — single sheet, one row per case — only column NAMES differ):
 *
 *  • FY2010–2014 "iCERT LCA_CASE_*" — every field renamed with an LCA_CASE_ prefix
 *    (LCA_CASE_EMPLOYER_NAME, LCA_CASE_SOC_NAME, …); STATUS, PW_1/PW_UNIT_1 for the
 *    case status + prevailing wage. FY2010 differs slightly (WORK_LOCATION_CITY1
 *    instead of LCA_CASE_WORKLOC1_CITY; no wage-unit column). No FEIN, no wage level.
 *  • FY2015–2018 "Disclosure_Data" narrow — mostly native; deltas: SOC_NAME (→SOC_TITLE,
 *    '15–'18), NAIC_CODE (typo'd, '15–'16), bare WAGE_RATE_OF_PAY (→…_FROM, '15 only).
 *  • FY2019 "Disclosure_Data" WIDE — up to 10 worksites inline, each a block suffixed
 *    _1…_10. FLAG (FY2020+) flattened this to one primary worksite per row with
 *    unsuffixed names, so we map the PRIMARY (_1) block → canonical; _2…_10 stay
 *    verbatim in the JSONB, unread (the FLAG worksite-join is out of scope). FY2019
 *    already uses SOC_TITLE natively.
 *
 * One combined map serves all of them: each alias fires ONLY when its source key is
 * present AND the canonical target is absent (`normalizePreFlagRecord`), so families
 * never collide — the _1 aliases no-op on narrow files, LCA_CASE_* no-ops on Disclosure
 * files, etc. (And the whole map only runs for filing_year < 2020 — `isPreFlag` — so
 * FLAG data is never touched.)
 *
 * Genuinely absent, not aliasable: EMPLOYER_FEIN (ALL pre-FLAG years → Layer-1 FEIN
 * dedup skipped, ER falls back to trigram/semantic); PW_WAGE_LEVEL (FY2010–2014, FY2016);
 * WAGE_UNIT_OF_PAY (FY2010).
 *
 * CONFIRM against a real header row before trusting a NEW year (families vary):
 *   node apps/ingestor/inspect-headers.mjs <file.xlsx>
 */
export const ICERT_ALIASES = {
  // --- FY2019 WIDE: primary-worksite (_1) block → canonical FLAG keys ---
  WORKSITE_CITY_1: 'WORKSITE_CITY',
  WORKSITE_STATE_1: 'WORKSITE_STATE',
  WAGE_RATE_OF_PAY_FROM_1: 'WAGE_RATE_OF_PAY_FROM',
  WAGE_UNIT_OF_PAY_1: 'WAGE_UNIT_OF_PAY',
  PREVAILING_WAGE_1: 'PREVAILING_WAGE',
  PW_UNIT_OF_PAY_1: 'PW_UNIT_OF_PAY',
  PW_WAGE_LEVEL_1: 'PW_WAGE_LEVEL',

  // --- FY2015–2018 Disclosure_Data deltas (else native) ---
  SOC_NAME: 'SOC_TITLE',                      // FY2015–2018 (FY2019 native)
  NAIC_CODE: 'NAICS_CODE',                     // FY2015–2016 typo'd header (FY2017+ native)
  WAGE_RATE_OF_PAY: 'WAGE_RATE_OF_PAY_FROM',   // FY2015 (FY2016+ already _FROM)

  // --- FY2010–2014 iCERT LCA_CASE_* family (full rename) ---
  STATUS: 'CASE_STATUS',
  LCA_CASE_EMPLOYER_NAME: 'EMPLOYER_NAME',
  LCA_CASE_EMPLOYER_CITY: 'EMPLOYER_CITY',
  LCA_CASE_EMPLOYER_STATE: 'EMPLOYER_STATE',
  LCA_CASE_JOB_TITLE: 'JOB_TITLE',
  LCA_CASE_SOC_CODE: 'SOC_CODE',
  LCA_CASE_SOC_NAME: 'SOC_TITLE',
  LCA_CASE_NAICS_CODE: 'NAICS_CODE',
  LCA_CASE_WAGE_RATE_FROM: 'WAGE_RATE_OF_PAY_FROM',
  LCA_CASE_WAGE_RATE_UNIT: 'WAGE_UNIT_OF_PAY',   // FY2011–2014 (FY2010 has no unit col)
  LCA_CASE_WORKLOC1_CITY: 'WORKSITE_CITY',       // FY2011–2014
  LCA_CASE_WORKLOC1_STATE: 'WORKSITE_STATE',
  WORK_LOCATION_CITY1: 'WORKSITE_CITY',          // FY2010 variant
  WORK_LOCATION_STATE1: 'WORKSITE_STATE',
  PW_1: 'PREVAILING_WAGE',                       // iCERT prevailing wage
  PW_UNIT_1: 'PW_UNIT_OF_PAY',
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
