'use client';

/**
 * Year-scoped employer hero. Wraps EntityHero and re-computes the KPI strip
 * (filings + certified/withdrawn/denied %) for the selected fiscal year, with
 * an "All years" toggle that falls back to the precomputed all-time figures.
 * Per-year % is derived in JS so rounding matches the all-time `employer` row.
 */

import type { ReactNode } from 'react';
import { EntityHero, type KpiTile } from '@/components/EntityHero';
import { YearSelector, useYearParam } from '@/components/YearSelector';
import { fmt, fmtPct } from '@/lib/format';
import type { EmployerYearlyRow } from '@/lib/queries';

export interface HeroChrome {
  eyebrow?: string;
  chips?: Array<{ label: string; variant?: 'default' | 'secondary' | 'outline' }>;
  title: string;
  subtitle?: ReactNode;
  updatedAt?: number;
}

interface Props extends HeroChrome {
  rank: number | null;
  allTime: {
    filings: number;
    certified_pct: number | null;
    withdrawn_pct: number | null;
    denied_pct: number | null;
  };
  yearly: EmployerYearlyRow[];
}

const pct = (n: number, d: number): number | null => (d > 0 ? (100 * n) / d : null);

export function EmployerHeroClient({
  eyebrow, chips, title, subtitle, updatedAt, rank, allTime, yearly,
}: Props) {
  const years = yearly.map((y) => y.year);
  const latest = years.length ? Math.max(...years) : 0;
  const [selected, setSelected] = useYearParam(latest);

  const row = typeof selected === 'number' ? yearly.find((y) => y.year === selected) : undefined;
  const isAll = selected === 'all' || !row;
  const suffix = isAll ? 'all years' : `FY${selected}`;

  const filings   = isAll ? allTime.filings      : row!.filings;
  const certified = isAll ? allTime.certified_pct : pct(row!.certified, row!.filings);
  const withdrawn = isAll ? allTime.withdrawn_pct : pct(row!.withdrawn, row!.filings);
  const denied    = isAll ? allTime.denied_pct    : pct(row!.denied, row!.filings);

  const kpis: KpiTile[] = [
    { label: 'Total filings', value: fmt(filings), sub: rank != null ? `Rank #${rank} · ${suffix}` : `Outside top-N · ${suffix}`, accent: true },
    { label: 'Certified',     value: fmtPct(certified), sub: `unconditional · ${suffix}` },
    { label: 'Withdrawn',     value: fmtPct(withdrawn), sub: `withdrawn rate · ${suffix}` },
    { label: 'Denied',        value: fmtPct(denied),    sub: `rejection rate · ${suffix}` },
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
