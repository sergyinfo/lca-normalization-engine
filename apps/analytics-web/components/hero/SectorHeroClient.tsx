'use client';

/**
 * Year-scoped sector hero. Re-computes total filings for the selected fiscal
 * year; "Employers" and "Filings / employer" stay all-time (passed in as
 * `tailKpis`, already labeled) — per-year distinct-employer counts would need a
 * dedicated matview and are out of scope.
 */

import { EntityHero, type KpiTile } from '@/components/EntityHero';
import { YearSelector, useYearParam } from '@/components/YearSelector';
import { fmt } from '@/lib/format';
import type { HeroChrome } from '@/components/hero/EmployerHeroClient';

interface YearPoint { year: number; filings: number }

interface Props extends HeroChrome {
  rank: number;
  allTime: { filings: number };
  yearly: YearPoint[];
  /** All-time tiles appended after the year-scoped one (employers, filings/employer). */
  tailKpis: KpiTile[];
}

export function SectorHeroClient({
  eyebrow, chips, title, subtitle, updatedAt, rank, allTime, yearly, tailKpis,
}: Props) {
  const years = yearly.map((y) => y.year);
  const latest = years.length ? Math.max(...years) : 0;
  const [selected, setSelected] = useYearParam(latest);

  const row = typeof selected === 'number' ? yearly.find((y) => y.year === selected) : undefined;
  const isAll = selected === 'all' || !row;
  const suffix = isAll ? 'all years' : `FY${selected}`;

  const filings = isAll ? allTime.filings : row!.filings;

  const kpis: KpiTile[] = [
    { label: 'Filings', value: fmt(filings), sub: `Rank #${rank} · ${suffix}`, accent: true },
    ...tailKpis,
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
