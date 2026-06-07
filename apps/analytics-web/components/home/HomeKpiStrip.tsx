'use client';

import { useHomeYear } from '@/components/home/HomeYearContext';
import { pickScope, type Scoped, type HomeKpiBundle } from '@/components/home/bundles';
import { fmt, fmtUsd } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';

export function HomeKpiStrip({
  bundles, firstYear, lastYear,
}: { bundles: Scoped<HomeKpiBundle>; firstYear: number; lastYear: number }) {
  const { selected } = useHomeYear();
  const b = pickScope(bundles, selected);
  const period = selected === 'all' ? `FY${firstYear}–FY${lastYear}` : `FY${selected}`;
  const scopeWord = selected === 'all' ? 'all filings' : `FY${selected}`;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <KpiTile label="Disclosures"        value={fmt(b.disclosures)} sub={period} />
      <KpiTile label={selected === 'all' ? 'Canonical sponsors' : 'Sponsors'}
               value={fmt(b.sponsors)} sub={selected === 'all' ? "dedup'd across spellings" : `active ${period}`} />
      <KpiTile label="Occupations"        value={fmt(b.socs)} sub={`SOC codes · ${period}`} />
      <KpiTile label="Median wage"        value={fmtUsd(b.median_wage)} sub={`across ${scopeWord}`} accent />
    </div>
  );
}

function KpiTile({
  label, value, sub, accent = false,
}: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <Card className={accent ? 'border-primary/30 bg-secondary/50' : undefined}>
      <CardContent className="p-4 space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className={`text-3xl font-bold tabular-nums leading-none ${accent ? 'text-primary' : ''}`}>{value}</div>
        <div className="text-xs text-muted-foreground pt-1">{sub}</div>
      </CardContent>
    </Card>
  );
}
