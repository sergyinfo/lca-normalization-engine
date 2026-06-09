'use client';

/**
 * Year-scoped state hero. Re-computes total filings + national share for the
 * selected fiscal year (share = state filings / US filings that year, from
 * site_yearly). The "Top sponsor share" / "Top occupation" tiles are all-time
 * (passed in as `tailKpis`, already labeled) — per-year top-N is out of scope.
 */

import { EntityHero, type KpiTile } from '@/components/EntityHero';
import { LatestAllToggle, useYearParam } from '@/components/YearSelector';
import { fmt } from '@/lib/format';
import type { HeroChrome } from '@/components/hero/EmployerHeroClient';

interface YearPoint { year: number; filings: number }

interface Props extends HeroChrome {
  rank: number;
  allTime: { filings: number; sharePct: number };
  stateYearly: YearPoint[];
  siteYearly: YearPoint[];
  /** All-time tiles appended after the year-scoped ones (top sponsor / top occ). */
  tailKpis: KpiTile[];
}

export function StateHeroClient({
  eyebrow, chips, title, subtitle, updatedAt, rank, allTime, stateYearly, siteYearly, tailKpis,
}: Props) {
  const years = stateYearly.map((y) => y.year);
  const latest = years.length ? Math.max(...years) : 0;
  const [selected, setSelected] = useYearParam(latest);

  const row = typeof selected === 'number' ? stateYearly.find((y) => y.year === selected) : undefined;
  const isAll = selected === 'all' || !row;
  const suffix = isAll ? 'all years' : `FY${selected}`;

  const filings = isAll ? allTime.filings : row!.filings;
  let sharePct = allTime.sharePct;
  if (!isAll) {
    const us = siteYearly.find((y) => y.year === selected)?.filings ?? 0;
    sharePct = us > 0 ? (row!.filings / us) * 100 : 0;
  }

  const kpis: KpiTile[] = [
    { label: 'Total filings',  value: fmt(filings), sub: `Rank #${rank} nationally · ${suffix}`, accent: true },
    { label: 'National share', value: `${sharePct.toFixed(1)}%`, sub: `of US H-1B filings · ${suffix}` },
    ...tailKpis,
  ];

  return (
    <div className="space-y-4">
      <EntityHero eyebrow={eyebrow} chips={chips} updatedAt={updatedAt} title={title} subtitle={subtitle} kpis={kpis} />
      {years.length > 1 ? (
        <LatestAllToggle latestYear={latest} selected={selected} onSelect={setSelected} />
      ) : null}
    </div>
  );
}
