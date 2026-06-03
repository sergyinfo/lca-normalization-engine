/**
 * Deterministic comparison summaries — the no-LLM fallback for compare pages
 * whose pair wasn't pre-generated (only featured top-10 × top-10 pairs get a
 * Claude summary at build time; any other pair is rendered on demand here).
 *
 * Returns an EntitySummaryRow so <Summary> renders it exactly like the LLM
 * ones (model: 'auto' marks the provenance). Figures come straight from the
 * already-loaded entity records — no network, no cost.
 */
import { fmt, fmtPct, fmtUsd } from '@/lib/format';
import type { EntitySummaryRow } from '@/lib/queries';

function row(md: string): EntitySummaryRow {
  return { summary_md: md, keywords: null, generated_at: 0, model: 'auto' };
}

/** "**X** leads on <label> (hi vs lo)" — or a level statement when equal. */
function lead(
  aName: string, aVal: number, bName: string, bVal: number,
  label: string, f: (n: number) => string,
): string {
  if (aVal === bVal) return `${aName} and ${bName} are level on ${label} (${f(aVal)} each)`;
  const lead = aVal > bVal
    ? { hi: aName, lo: bName, hv: aVal, lv: bVal }
    : { hi: bName, lo: aName, hv: bVal, lv: aVal };
  return `**${lead.hi}** leads on ${label} (${f(lead.hv)} vs ${f(lead.lv)})`;
}

interface EmpLite { canonical_name: string; filings: number; certified_pct: number | null; denied_pct: number | null; employer_state: string | null; }
export function employerCompareFallback(a: EmpLite, b: EmpLite): EntitySummaryRow {
  const parts = [`${lead(a.canonical_name, a.filings, b.canonical_name, b.filings, 'H-1B filing volume', (n) => `${fmt(n)} filings`)} across the years covered here.`];
  if (a.certified_pct != null && b.certified_pct != null) {
    parts.push(`On certification rate, ${a.canonical_name} runs ${fmtPct(a.certified_pct)} and ${b.canonical_name} ${fmtPct(b.certified_pct)}.`);
  }
  const states = [a.employer_state, b.employer_state].filter(Boolean);
  if (states.length === 2) parts.push(`Primary worksite states: ${a.employer_state} and ${b.employer_state} respectively.`);
  return row(parts.join(' '));
}

interface OccLite { soc_title: string | null; soc_code: string; filings: number; p50_wage: number | null; }
export function occupationCompareFallback(a: OccLite, b: OccLite): EntitySummaryRow {
  const an = a.soc_title ?? a.soc_code, bn = b.soc_title ?? b.soc_code;
  const parts = [`${lead(an, a.filings, bn, b.filings, 'H-1B filing volume', (n) => `${fmt(n)} filings`)}.`];
  if (a.p50_wage != null && b.p50_wage != null) {
    parts.push(`${lead(an, a.p50_wage, bn, b.p50_wage, 'median prevailing wage', fmtUsd)}.`);
  }
  return row(parts.join(' '));
}

interface StateLite { name: string; filings: number; }
export function stateCompareFallback(a: StateLite, b: StateLite): EntitySummaryRow {
  return row(`${lead(a.name, a.filings, b.name, b.filings, 'H-1B worksite filings', (n) => `${fmt(n)} filings`)}. Both reflect where employers place H-1B workers, not where the petitions are processed.`);
}

interface SectorLite { label: string; filings: number; employers: number; }
export function sectorCompareFallback(a: SectorLite, b: SectorLite): EntitySummaryRow {
  const parts = [`${lead(a.label, a.filings, b.label, b.filings, 'H-1B filing volume', (n) => `${fmt(n)} filings`)}.`];
  parts.push(`${lead(a.label, a.employers, b.label, b.employers, 'number of distinct sponsoring employers', fmt)}.`);
  return row(parts.join(' '));
}
