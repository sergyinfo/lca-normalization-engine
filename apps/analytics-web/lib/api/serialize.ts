/**
 * Row → public API shape mapping. The runtime app reads SQLite rows that
 * carry implementation noise (rank, internal joins); the API surface
 * exposes a cleaned-up object plus derived URLs so a consumer can deep-link
 * straight back to the human-facing page.
 */

import {
  type EmployerRow, type EmployerTopSocRow, type EmployerYearlyRow,
  type OccupationRow, type OccupationLevelRow, type OccupationTopStateRow,
  type OccupationTopEmployerRow, type OccupationYearlyRow,
  type StateRow, type StateTopEmployerRow, type StateTopOccupationRow,
  type SectorRow, type SiteKpis,
} from '../queries';
import { SITE_URL } from '../site';

const url = (p: string) => `${SITE_URL}${p}`;

export function employerSummaryShape(e: EmployerRow) {
  return {
    slug: e.slug,
    canonical_id: e.canonical_id,
    canonical_name: e.canonical_name,
    employer_state: e.employer_state,
    fein: e.fein,
    filings: e.filings,
    certified_pct:      e.certified_pct,
    withdrawn_pct:      e.withdrawn_pct,
    cert_withdrawn_pct: e.cert_withdrawn_pct,
    denied_pct:         e.denied_pct,
    rank: e.rank,
    url: url(`/employer/${e.slug}`),
  };
}

export function employerDetailShape(
  e: EmployerRow, topSocs: EmployerTopSocRow[], yearly: EmployerYearlyRow[],
) {
  return {
    ...employerSummaryShape(e),
    first_year: e.first_year,
    last_year:  e.last_year,
    top_occupations: topSocs.map((s) => ({
      soc_code: s.soc_code,
      soc_slug: s.soc_slug,
      soc_title: s.soc_title,
      filings: s.filings,
      rank: s.rank,
      url: s.soc_slug ? url(`/occupation/${s.soc_slug}`) : null,
    })),
    yearly_volume: yearly,
  };
}

export function occupationSummaryShape(o: OccupationRow) {
  return {
    soc_code: o.soc_code,
    slug:     o.slug,
    soc_title: o.soc_title,
    filings:  o.filings,
    n_wages:  o.n_wages,
    p25_wage: o.p25_wage,
    p50_wage: o.p50_wage,
    p75_wage: o.p75_wage,
    rank:     o.rank,
    url: url(`/occupation/${o.slug}`),
  };
}

export function occupationDetailShape(
  o: OccupationRow,
  levels: OccupationLevelRow[],
  topStates: OccupationTopStateRow[],
  topEmployers: OccupationTopEmployerRow[],
  yearly: OccupationYearlyRow[],
) {
  return {
    ...occupationSummaryShape(o),
    wage_levels: levels,
    top_states: topStates.map((s) => ({
      state: s.state,
      state_slug: s.state_slug,
      filings: s.filings,
      p50_wage: s.p50_wage,
      rank: s.rank,
      url: s.state_slug ? url(`/state/${s.state_slug}`) : null,
    })),
    top_employers: topEmployers.map((e) => ({
      employer_slug: e.employer_slug,
      canonical_name: e.canonical_name,
      filings: e.filings,
      rank: e.rank,
      url: url(`/employer/${e.employer_slug}`),
    })),
    yearly_median_wage: yearly,
  };
}

export function stateSummaryShape(s: StateRow) {
  return {
    code: s.code,
    slug: s.slug,
    name: s.name,
    filings: s.filings,
    rank: s.rank,
    url: url(`/state/${s.slug}`),
  };
}

export function stateDetailShape(
  s: StateRow, topEmps: StateTopEmployerRow[], topSocs: StateTopOccupationRow[],
) {
  return {
    ...stateSummaryShape(s),
    top_employers: topEmps.map((e) => ({
      employer_slug: e.employer_slug,
      canonical_name: e.canonical_name,
      filings: e.filings,
      share_pct: e.share_pct,
      rank: e.rank,
      url: url(`/employer/${e.employer_slug}`),
    })),
    top_occupations: topSocs.map((o) => ({
      soc_code: o.soc_code,
      soc_slug: o.soc_slug,
      soc_title: o.soc_title,
      filings: o.filings,
      rank: o.rank,
      url: o.soc_slug ? url(`/occupation/${o.soc_slug}`) : null,
    })),
  };
}

export function sectorSummaryShape(s: SectorRow) {
  return {
    naics2: s.naics2,
    slug: s.slug,
    label: s.label,
    filings: s.filings,
    employers: s.employers,
    rank: s.rank,
    url: url(`/sector/${s.slug}`),
  };
}

export function kpisShape(k: SiteKpis) {
  return {
    total_records: k.total_records,
    canonical_employers: k.canonical_employers,
    distinct_socs: k.distinct_socs,
    first_year: k.first_year,
    last_year:  k.last_year,
    median_wage: k.median_wage,
  };
}
