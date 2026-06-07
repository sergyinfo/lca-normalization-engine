'use client';

/**
 * Year-scoped occupation hero. Re-computes median + P25/P75 wages and filings
 * for the selected fiscal year; "All years" falls back to the all-time
 * percentiles on the `occupation` row.
 */

import type { ReactNode } from 'react';
import { EntityHero, type KpiTile } from '@/components/EntityHero';
import { YearSelector, useYearParam } from '@/components/YearSelector';
import { fmt, fmtUsd } from '@/lib/format';
import type { OccupationYearlyRow } from '@/lib/queries';
import type { HeroChrome } from '@/components/hero/EmployerHeroClient';

interface Props extends HeroChrome {
  rank: number;
  allTime: {
    filings: number;
    p25_wage: number | null;
    p50_wage: number | null;
    p75_wage: number | null;
  };
  yearly: OccupationYearlyRow[];
}

export function OccupationHeroClient({
  eyebrow, chips, title, subtitle, updatedAt, rank, allTime, yearly,
}: Props) {
  const years = yearly.map((y) => y.year);
  const latest = years.length ? Math.max(...years) : 0;
  const [selected, setSelected] = useYearParam(latest);

  const row = typeof selected === 'number' ? yearly.find((y) => y.year === selected) : undefined;
  const isAll = selected === 'all' || !row;
  const suffix = isAll ? 'all years' : `FY${selected}`;

  const filings = isAll ? allTime.filings  : (row!.filings ?? 0);
  const p25     = isAll ? allTime.p25_wage : row!.p25_wage;
  const p50     = isAll ? allTime.p50_wage : row!.median_wage;
  const p75     = isAll ? allTime.p75_wage : row!.p75_wage;

  const kpis: KpiTile[] = [
    { label: 'Median wage', value: fmtUsd(p50), sub: `P50 · ${suffix}`, accent: true },
    { label: 'P25 wage',    value: fmtUsd(p25), sub: `lower quartile · ${suffix}` },
    { label: 'P75 wage',    value: fmtUsd(p75), sub: `upper quartile · ${suffix}` },
    { label: 'Filings',     value: fmt(filings), sub: `Rank #${rank} · ${suffix}` },
  ];

  return (
    <div className="space-y-4">
      <EntityHero eyebrow={eyebrow} chips={chips} updatedAt={updatedAt} title={title} subtitle={subtitle} kpis={kpis} />
      {years.length > 1 ? (
        <YearSelector years={years} selected={selected} onSelect={setSelected} />
      ) : null}
    </div>
  );
}
