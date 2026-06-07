/**
 * Display-ready data bundles for the homepage dashboard. The server page shapes
 * one bundle per scope ('all' + each fiscal year); the client islands just pick
 * the active scope and render — no data logic on the client.
 */
import type { YearValue } from '@/components/YearSelector';

export interface Scoped<T> {
  all: T;
  byYear: Record<number, T>;
}

/** Pick the bundle for the selected scope, falling back to the all-years one. */
export function pickScope<T>(s: Scoped<T>, selected: YearValue): T {
  return selected === 'all' ? s.all : (s.byYear[selected] ?? s.all);
}

export interface HomeKpiBundle {
  disclosures: number;
  sponsors: number | null;
  socs: number | null;
  median_wage: number | null;
}

export interface ChartPoint { label: string; value: number }
export interface DonutSlice { label: string; value: number; color?: string }
export interface BarRow { label: string; value: number; hint?: string }

export interface HomeChartBundle {
  wage: ChartPoint[];      // highest-paying occupations
  donut: DonutSlice[];     // industry mix
  donutTotal: number;
  states: BarRow[];        // top hiring states
}

export interface HomeTableEmployer { slug: string; canonical_name: string; filings: number }
export interface HomeTableOccupation { slug: string; soc_code: string; soc_title: string | null; filings: number }

export interface HomeTableBundle {
  employers: HomeTableEmployer[];
  occupations: HomeTableOccupation[];
}
