/**
 * Typed read-only queries against lca.db. Every function here is a single
 * prepared statement → JSON shape the page components consume.
 *
 * Wraps node:sqlite (no native binding). Row shapes are declared up top
 * and the queryAll/queryOne helpers in ./db apply the type cast.
 */

import { queryAll, queryOne } from './db';
import type { EntityKind } from './schema';

/* -------------------------------------------------------------------------- */
/* Row types                                                                  */
/* -------------------------------------------------------------------------- */

export interface SiteKpis {
  total_records: number;
  canonical_employers: number;
  distinct_socs: number;
  first_year: number;
  last_year: number;
  median_wage: number;
  /** Unix epoch seconds — when the lca.db snapshot was generated. Drives
   *  sitemap lastModified and the "Updated" badge on entity pages. */
  generated_at: number;
}

export interface EmployerRow {
  slug: string;
  canonical_id: string;
  canonical_name: string;
  employer_state: string | null;
  fein: string | null;
  filings: number;
  certified_pct: number | null;
  withdrawn_pct: number | null;
  cert_withdrawn_pct: number | null;
  denied_pct: number | null;
  first_year: number | null;
  last_year: number | null;
  /** Global rank by filing volume. NULL for tail employers — those only
   *  surfaced via cross-references from /state /occupation /sector pages,
   *  not in the public /employer index. */
  rank: number | null;
}

export interface EmployerTopSocRow {
  soc_code: string;
  soc_slug: string | null;          // null when the SOC isn't in the curated top-N
  soc_title: string | null;
  filings: number;
  rank: number;
}

export interface EmployerYearlyRow {
  year: number;
  filings: number;
}

export interface OccupationRow {
  soc_code: string;
  slug: string;
  soc_title: string | null;
  filings: number;
  n_wages: number | null;
  p25_wage: number | null;
  p50_wage: number | null;
  p75_wage: number | null;
  rank: number;
}

export interface OccupationLevelRow {
  wage_level: string;
  n_wages: number | null;
  p25_wage: number | null;
  p50_wage: number | null;
  p75_wage: number | null;
}

export interface OccupationTopStateRow {
  state: string;
  state_slug: string | null;        // null if the state isn't in the curated top-N
  filings: number;
  p50_wage: number | null;
  rank: number;
}

export interface OccupationTopEmployerRow {
  employer_slug: string;
  canonical_name: string;
  filings: number;
  rank: number;
}

export interface OccupationYearlyRow {
  year: number;
  filings: number | null;
  median_wage: number | null;
}

export interface StateRow {
  code: string;
  slug: string;
  name: string;
  filings: number;
  rank: number;
}

export interface StateTopEmployerRow {
  employer_slug: string;
  canonical_name: string;
  filings: number;
  share_pct: number | null;
  rank: number;
}

export interface StateTopOccupationRow {
  soc_code: string;
  soc_slug: string | null;
  soc_title: string | null;
  filings: number;
  rank: number;
}

export interface SectorRow {
  naics2: string;
  slug: string;
  label: string;
  filings: number;
  employers: number;
  rank: number;
}

export interface SectorTopEmployerRow {
  employer_slug: string;
  canonical_name: string;
  filings: number;
  rank: number;
}

export interface SectorTopOccupationRow {
  soc_code: string;
  soc_slug: string | null;
  soc_title: string | null;
  filings: number;
  rank: number;
}

export interface SectorTopStateRow {
  state: string;
  state_slug: string | null;
  filings: number;
  rank: number;
}

export interface SectorYearlyRow {
  year: number;
  filings: number;
}

export interface StateYearlyRow {
  year: number;
  filings: number;
}

export interface EntitySummaryRow {
  summary_md: string;
  generated_at: number;
  model: string | null;
}

/* -------------------------------------------------------------------------- */
/* Site KPIs                                                                  */
/* -------------------------------------------------------------------------- */

export function getSiteKpis(): SiteKpis {
  const row = queryOne<SiteKpis>(
    `SELECT total_records, canonical_employers, distinct_socs,
            first_year, last_year, median_wage, generated_at
       FROM site_kpis WHERE id = 1`,
  );
  if (!row) throw new Error('site_kpis missing from lca.db');
  return row;
}

/* -------------------------------------------------------------------------- */
/* Employer                                                                   */
/* -------------------------------------------------------------------------- */

export function listTopEmployers(limit = 50): EmployerRow[] {
  // rank IS NULL = tail employer (cross-referenced from /state/<x> etc. but
  // not in the global top-N). Tails get static pages but stay out of the
  // public /employer index, biggest-movers chart, and KPI denominators.
  return queryAll<EmployerRow>(
    `SELECT * FROM employer WHERE rank IS NOT NULL ORDER BY rank ASC LIMIT ?`,
    limit,
  );
}

export function listAllEmployerSlugs(): string[] {
  // Include tail employers (rank IS NULL) — they need static pages so the
  // cross-ref links from state/occupation/sector pages resolve.
  return queryAll<{ slug: string }>(
    `SELECT slug FROM employer ORDER BY rank IS NULL ASC, rank ASC`,
  ).map((r) => r.slug);
}

export function listCleanestEmployers(limit = 100, minFilings = 500): EmployerRow[] {
  // Curated leaderboard — tail employers excluded by rank IS NOT NULL.
  return queryAll<EmployerRow>(
    `SELECT * FROM employer
       WHERE rank IS NOT NULL AND filings >= ? AND certified_pct IS NOT NULL
       ORDER BY certified_pct DESC, filings DESC
       LIMIT ?`,
    minFilings, limit,
  );
}

export function listHighestPayingOccupations(limit = 100): OccupationRow[] {
  return queryAll<OccupationRow>(
    `SELECT * FROM occupation
       WHERE p50_wage IS NOT NULL
       ORDER BY p50_wage DESC, filings DESC
       LIMIT ?`,
    limit,
  );
}

export function getEmployer(slug: string): EmployerRow | null {
  return queryOne<EmployerRow>(`SELECT * FROM employer WHERE slug = ?`, slug);
}

export function getEmployerTopSocs(slug: string): EmployerTopSocRow[] {
  // LEFT JOIN — link only renders if the SOC is in the curated occupation set.
  return queryAll<EmployerTopSocRow>(
    `SELECT t.soc_code, o.slug AS soc_slug, t.soc_title, t.filings, t.rank
       FROM employer_top_soc t
       LEFT JOIN occupation o ON o.soc_code = t.soc_code
      WHERE t.employer_slug = ? ORDER BY t.rank ASC`, slug);
}

export function getEmployerYearly(slug: string): EmployerYearlyRow[] {
  return queryAll<EmployerYearlyRow>(
    `SELECT year, filings FROM employer_yearly WHERE employer_slug = ? ORDER BY year ASC`,
    slug);
}

/* -------------------------------------------------------------------------- */
/* Occupation                                                                 */
/* -------------------------------------------------------------------------- */

export function listTopOccupations(limit = 30): OccupationRow[] {
  return queryAll<OccupationRow>(`SELECT * FROM occupation ORDER BY rank ASC LIMIT ?`, limit);
}

export function listAllOccupationSlugs(): string[] {
  return queryAll<{ slug: string }>(`SELECT slug FROM occupation ORDER BY rank ASC`)
    .map((r) => r.slug);
}

export function getOccupation(socCode: string): OccupationRow | null {
  return queryOne<OccupationRow>(`SELECT * FROM occupation WHERE soc_code = ?`, socCode);
}

export function getOccupationBySlug(slug: string): OccupationRow | null {
  return queryOne<OccupationRow>(`SELECT * FROM occupation WHERE slug = ?`, slug);
}

export function getOccupationLevels(socCode: string): OccupationLevelRow[] {
  return queryAll<OccupationLevelRow>(
    `SELECT wage_level, n_wages, p25_wage, p50_wage, p75_wage
       FROM occupation_level WHERE soc_code = ? ORDER BY wage_level ASC`, socCode);
}

export function getOccupationTopStates(socCode: string): OccupationTopStateRow[] {
  return queryAll<OccupationTopStateRow>(
    `SELECT t.state, s.slug AS state_slug, t.filings, t.p50_wage, t.rank
       FROM occupation_top_state t
       LEFT JOIN state s ON s.code = t.state
      WHERE t.soc_code = ? ORDER BY t.rank ASC`, socCode);
}

export function getOccupationTopEmployers(socCode: string): OccupationTopEmployerRow[] {
  return queryAll<OccupationTopEmployerRow>(
    `SELECT employer_slug, canonical_name, filings, rank
       FROM occupation_top_employer WHERE soc_code = ? ORDER BY rank ASC`, socCode);
}

export function getOccupationYearly(socCode: string): OccupationYearlyRow[] {
  return queryAll<OccupationYearlyRow>(
    `SELECT year, filings, median_wage FROM occupation_yearly
      WHERE soc_code = ? ORDER BY year ASC`, socCode);
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export function listTopStates(limit = 30): StateRow[] {
  return queryAll<StateRow>(`SELECT * FROM state ORDER BY rank ASC LIMIT ?`, limit);
}

export function listAllStateSlugs(): string[] {
  return queryAll<{ slug: string }>(`SELECT slug FROM state ORDER BY rank ASC`)
    .map((r) => r.slug);
}

export function getState(code: string): StateRow | null {
  return queryOne<StateRow>(`SELECT * FROM state WHERE code = ?`, code);
}

export function getStateBySlug(slug: string): StateRow | null {
  return queryOne<StateRow>(`SELECT * FROM state WHERE slug = ?`, slug);
}

export function getStateTopEmployers(code: string): StateTopEmployerRow[] {
  return queryAll<StateTopEmployerRow>(
    `SELECT employer_slug, canonical_name, filings, share_pct, rank
       FROM state_top_employer WHERE state_code = ? ORDER BY rank ASC`, code);
}

export function getStateTopOccupations(code: string): StateTopOccupationRow[] {
  return queryAll<StateTopOccupationRow>(
    `SELECT t.soc_code, o.slug AS soc_slug, t.soc_title, t.filings, t.rank
       FROM state_top_occupation t
       LEFT JOIN occupation o ON o.soc_code = t.soc_code
      WHERE t.state_code = ? ORDER BY t.rank ASC`, code);
}

/* -------------------------------------------------------------------------- */
/* Sector                                                                     */
/* -------------------------------------------------------------------------- */

export function listTopSectors(limit = 30): SectorRow[] {
  return queryAll<SectorRow>(`SELECT * FROM sector ORDER BY rank ASC LIMIT ?`, limit);
}

export function listAllSectorSlugs(): string[] {
  return queryAll<{ slug: string }>(`SELECT slug FROM sector ORDER BY rank ASC`)
    .map((r) => r.slug);
}

export function getSector(naics2: string): SectorRow | null {
  return queryOne<SectorRow>(`SELECT * FROM sector WHERE naics2 = ?`, naics2);
}

export function getSectorBySlug(slug: string): SectorRow | null {
  return queryOne<SectorRow>(`SELECT * FROM sector WHERE slug = ?`, slug);
}

export function getSectorTopEmployers(naics2: string): SectorTopEmployerRow[] {
  return queryAll<SectorTopEmployerRow>(
    `SELECT employer_slug, canonical_name, filings, rank
       FROM sector_top_employer WHERE naics2 = ? ORDER BY rank ASC`, naics2);
}

export function getSectorTopOccupations(naics2: string): SectorTopOccupationRow[] {
  return queryAll<SectorTopOccupationRow>(
    `SELECT t.soc_code, o.slug AS soc_slug, t.soc_title, t.filings, t.rank
       FROM sector_top_occupation t
       LEFT JOIN occupation o ON o.soc_code = t.soc_code
      WHERE t.naics2 = ? ORDER BY t.rank ASC`, naics2);
}

export function getSectorTopStates(naics2: string): SectorTopStateRow[] {
  return queryAll<SectorTopStateRow>(
    `SELECT t.state, s.slug AS state_slug, t.filings, t.rank
       FROM sector_top_state t
       LEFT JOIN state s ON s.code = t.state
      WHERE t.naics2 = ? ORDER BY t.rank ASC`, naics2);
}

export function getSectorYearly(naics2: string): SectorYearlyRow[] {
  return queryAll<SectorYearlyRow>(
    `SELECT year, filings FROM sector_yearly WHERE naics2 = ? ORDER BY year ASC`,
    naics2);
}

/* -------------------------------------------------------------------------- */
/* State yearly (entity trend + list sparklines)                              */
/* -------------------------------------------------------------------------- */

export function getStateYearly(code: string): StateYearlyRow[] {
  return queryAll<StateYearlyRow>(
    `SELECT year, filings FROM state_yearly WHERE state_code = ? ORDER BY year ASC`,
    code);
}

/* -------------------------------------------------------------------------- */
/* Batch yearly fetch (drives inline sparklines on list pages)                */
/*                                                                            */
/* Each returns a Map<key → number[]>, where the array is aligned to the      */
/* covered fiscal-year range from site_kpis (nulls fill in gaps). Cheap:      */
/* one query per kind, then we pivot in JS.                                   */
/* -------------------------------------------------------------------------- */

export interface SparkSeries {
  /** Covered year range, inclusive, sorted ascending. Matches arr length. */
  years: number[];
  /** Per-entity series: arr[i] = filings in years[i], or null for missing. */
  byKey: Map<string, Array<number | null>>;
}

function yearRange(): number[] {
  const k = getSiteKpis();
  const out: number[] = [];
  for (let y = k.first_year; y <= k.last_year; y++) out.push(y);
  return out;
}

function pivotYearly(
  rows: Array<{ key: string; year: number; filings: number }>,
  years: number[],
): Map<string, Array<number | null>> {
  const index = new Map(years.map((y, i) => [y, i]));
  const out = new Map<string, Array<number | null>>();
  for (const r of rows) {
    let arr = out.get(r.key);
    if (!arr) { arr = years.map(() => null); out.set(r.key, arr); }
    const i = index.get(r.year);
    if (i != null) arr[i] = r.filings;
  }
  return out;
}

export function getEmployerYearlyAll(): SparkSeries {
  const years = yearRange();
  const rows = queryAll<{ key: string; year: number; filings: number }>(
    `SELECT employer_slug AS key, year, filings FROM employer_yearly ORDER BY employer_slug, year`,
  );
  return { years, byKey: pivotYearly(rows, years) };
}

export function getOccupationYearlyAll(): SparkSeries {
  const years = yearRange();
  const rows = queryAll<{ key: string; year: number; filings: number }>(
    `SELECT soc_code AS key, year,
            COALESCE(filings, 0) AS filings
       FROM occupation_yearly WHERE filings IS NOT NULL
       ORDER BY soc_code, year`,
  );
  return { years, byKey: pivotYearly(rows, years) };
}

export function getStateYearlyAll(): SparkSeries {
  const years = yearRange();
  const rows = queryAll<{ key: string; year: number; filings: number }>(
    `SELECT state_code AS key, year, filings FROM state_yearly ORDER BY state_code, year`,
  );
  return { years, byKey: pivotYearly(rows, years) };
}

export function getSectorYearlyAll(): SparkSeries {
  const years = yearRange();
  const rows = queryAll<{ key: string; year: number; filings: number }>(
    `SELECT naics2 AS key, year, filings FROM sector_yearly ORDER BY naics2, year`,
  );
  return { years, byKey: pivotYearly(rows, years) };
}

/* -------------------------------------------------------------------------- */
/* Summaries (LLM-generated, optional per page)                               */
/* -------------------------------------------------------------------------- */

export function getEntitySummary(kind: EntityKind | 'site', slug: string): EntitySummaryRow | null {
  return queryOne<EntitySummaryRow>(
    `SELECT summary_md, generated_at, model FROM entity_summary WHERE kind = ? AND slug = ?`,
    kind, slug);
}
