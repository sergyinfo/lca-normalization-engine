import Link from 'next/link';
import type { Metadata } from 'next';
import { Building2 } from 'lucide-react';

import { listTopEmployers, getEmployerYearlyAll } from '@/lib/queries';
import { fmt, fmtPct } from '@/lib/format';
import { entityMetadata } from '@/lib/seo';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Sparkline } from '@/components/charts/Sparkline';
import { MiniBar } from '@/components/charts/MiniBar';
import { SortableTable } from '@/components/SortableTable';

export const metadata: Metadata = entityMetadata({
  title: 'Top H-1B Sponsors — Employer Index',
  description:
    'Browse the largest H-1B sponsors in the United States by filing volume. Per-employer profiles cover certification rates, top occupations, and year-over-year hiring trends.',
  path: '/employer',
});

export default function EmployerIndex() {
  const employers = listTopEmployers(500);
  const spark = getEmployerYearlyAll();
  const maxFilings = employers.reduce((m, e) => Math.max(m, e.filings), 0);
  return (
    <>
      <section className="space-y-3 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <Building2 className="size-3" /> Sponsor index
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          H-1B sponsors by filing volume
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          Every employer that filed an H-1B Labor Condition Application in
          the covered fiscal years, ordered by total filings. Click any
          column header to sort.
        </p>
      </section>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">
            {fmt(employers.length)} sponsors
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <SortableTable initialSort={{ key: 'rank', dir: 'asc' }}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12" data-sort-key="rank" data-sort-type="number">#</TableHead>
                  <TableHead data-sort-key="name" data-sort-type="string">Employer</TableHead>
                  <TableHead className="w-16" data-sort-key="state" data-sort-type="string">State</TableHead>
                  <TableHead className="text-right" data-sort-key="filings" data-sort-type="number">Filings</TableHead>
                  <TableHead className="w-28">Trend FY{spark.years[0]}–{spark.years[spark.years.length - 1]}</TableHead>
                  <TableHead className="text-right" data-sort-key="cert" data-sort-type="number">Certified</TableHead>
                  <TableHead className="text-right" data-sort-key="denied" data-sort-type="number">Denied</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {employers.map((e) => {
                  const series = spark.byKey.get(e.slug);
                  return (
                    <TableRow key={e.slug}>
                      <TableCell className="text-muted-foreground tabular-nums" data-sort-value={e.rank}>{e.rank}</TableCell>
                      <TableCell data-sort-value={e.canonical_name}>
                        <Link href={`/employer/${e.slug}`} className="font-medium hover:text-primary">
                          {e.canonical_name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs font-mono" data-sort-value={e.employer_state ?? ''}>
                        {e.employer_state ?? '—'}
                      </TableCell>
                      <TableCell className="text-right" data-sort-value={e.filings}>
                        <div className="flex items-center justify-end gap-2">
                          <MiniBar value={e.filings} max={maxFilings} />
                          <span className="tabular-nums">{fmt(e.filings)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {series ? <Sparkline values={series} /> : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums" data-sort-value={e.certified_pct ?? ''}>{fmtPct(e.certified_pct, 1)}</TableCell>
                      <TableCell className="text-right tabular-nums" data-sort-value={e.denied_pct ?? ''}>{fmtPct(e.denied_pct, 1)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </SortableTable>
        </CardContent>
      </Card>
    </>
  );
}
