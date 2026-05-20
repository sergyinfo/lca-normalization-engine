import Link from 'next/link';
import type { Metadata } from 'next';
import { MapPin } from 'lucide-react';

import { listTopStates, getStateYearlyAll } from '@/lib/queries';
import { fmt } from '@/lib/format';
import { entityMetadata } from '@/lib/seo';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Sparkline } from '@/components/charts/Sparkline';
import { MiniBar } from '@/components/charts/MiniBar';
import { SortableTable } from '@/components/SortableTable';

export const metadata: Metadata = entityMetadata({
  title: 'H-1B Filings by State',
  description:
    'H-1B sponsorship volume by US state. Drill in for top sponsors, top occupations, and employer-concentration indicators in each state.',
  path: '/state',
});

export default function StateIndex() {
  const rows = listTopStates(60);
  const spark = getStateYearlyAll();
  const maxFilings = rows.reduce((m, s) => Math.max(m, s.filings), 0);
  return (
    <>
      <section className="space-y-3 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <MapPin className="size-3" /> State index
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          H-1B filings by US state
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          Worksite-state distribution of H-1B Labor Condition Applications.
          Click any column header to sort.
        </p>
      </section>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{fmt(rows.length)} states</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <SortableTable initialSort={{ key: 'rank', dir: 'asc' }}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12" data-sort-key="rank" data-sort-type="number">#</TableHead>
                  <TableHead className="w-16" data-sort-key="code" data-sort-type="string">Code</TableHead>
                  <TableHead             data-sort-key="name" data-sort-type="string">State</TableHead>
                  <TableHead className="text-right" data-sort-key="filings" data-sort-type="number">Filings</TableHead>
                  <TableHead className="w-28">Trend FY{spark.years[0]}–{spark.years[spark.years.length - 1]}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => {
                  const series = spark.byKey.get(s.code);
                  return (
                    <TableRow key={s.code}>
                      <TableCell className="text-muted-foreground tabular-nums" data-sort-value={s.rank}>{s.rank}</TableCell>
                      <TableCell className="font-mono text-xs" data-sort-value={s.code}>
                        <Link href={`/state/${s.slug}`} className="hover:text-primary">{s.code}</Link>
                      </TableCell>
                      <TableCell data-sort-value={s.name}>
                        <Link href={`/state/${s.slug}`} className="font-medium hover:text-primary">
                          {s.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right" data-sort-value={s.filings}>
                        <div className="flex items-center justify-end gap-2">
                          <MiniBar value={s.filings} max={maxFilings} />
                          <span className="tabular-nums">{fmt(s.filings)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {series ? <Sparkline values={series} /> : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
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
