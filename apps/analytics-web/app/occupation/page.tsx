import Link from 'next/link';
import type { Metadata } from 'next';
import { Briefcase } from 'lucide-react';

import { listTopOccupations, getOccupationYearlyAll } from '@/lib/queries';
import { fmt, fmtUsd } from '@/lib/format';
import { entityMetadata } from '@/lib/seo';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Sparkline } from '@/components/charts/Sparkline';
import { MiniBar } from '@/components/charts/MiniBar';

export const metadata: Metadata = entityMetadata({
  title: 'H-1B Occupations — Salary Guide Index',
  description:
    'Browse H-1B occupations by SOC code. Each guide covers prevailing-wage percentiles, top hiring states and employers, and year-over-year wage growth.',
  path: '/occupation',
});

export default function OccupationIndex() {
  const rows = listTopOccupations(500);
  const spark = getOccupationYearlyAll();
  const maxFilings = rows.reduce((m, o) => Math.max(m, o.filings), 0);
  return (
    <>
      <section className="space-y-3 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <Briefcase className="size-3" /> Occupation salary guides
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          H-1B occupations by filing volume
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          SOC-coded occupations covered by the H-1B program, ranked by total
          filings. Click a code for prevailing-wage percentiles, hiring
          states, and top sponsors.
        </p>
      </section>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{fmt(rows.length)} occupations</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead className="w-24">SOC</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="text-right">Filings</TableHead>
                <TableHead className="w-28">Trend FY{spark.years[0]}–{spark.years[spark.years.length - 1]}</TableHead>
                <TableHead className="text-right">Median wage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => {
                const series = spark.byKey.get(o.soc_code);
                return (
                  <TableRow key={o.soc_code}>
                    <TableCell className="text-muted-foreground tabular-nums">{o.rank}</TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link href={`/occupation/${o.slug}`} className="hover:text-primary">{o.soc_code}</Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/occupation/${o.slug}`} className="font-medium hover:text-primary">
                        {o.soc_title ?? '—'}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <MiniBar value={o.filings} max={maxFilings} />
                        <span className="tabular-nums">{fmt(o.filings)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {series ? <Sparkline values={series} /> : <span className="text-muted-foreground text-xs">—</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtUsd(o.p50_wage)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
