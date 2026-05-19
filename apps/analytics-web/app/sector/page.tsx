import Link from 'next/link';
import type { Metadata } from 'next';
import { Factory } from 'lucide-react';

import { listTopSectors, getSectorYearlyAll } from '@/lib/queries';
import { fmt } from '@/lib/format';
import { entityMetadata } from '@/lib/seo';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Sparkline } from '@/components/charts/Sparkline';
import { MiniBar } from '@/components/charts/MiniBar';

export const metadata: Metadata = entityMetadata({
  title: 'H-1B Filings by Industry Sector',
  description:
    'H-1B sponsorship grouped by NAICS 2-digit sector. Compare hiring volume and distinct sponsoring employers across the US economy.',
  path: '/sector',
});

export default function SectorIndex() {
  const rows = listTopSectors(60);
  const spark = getSectorYearlyAll();
  const maxFilings = rows.reduce((m, s) => Math.max(m, s.filings), 0);
  return (
    <>
      <section className="space-y-3 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <Factory className="size-3" /> Industry sectors
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          H-1B filings by industry sector
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          NAICS 2-digit sector breakdown of H-1B Labor Condition Applications.
          Sector 54 (Professional, Scientific &amp; Technical Services)
          dominates; smaller sectors fill out the long tail of the program.
        </p>
      </section>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{fmt(rows.length)} sectors</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead className="w-20">NAICS</TableHead>
                <TableHead>Sector</TableHead>
                <TableHead className="text-right">Filings</TableHead>
                <TableHead className="w-28">Trend FY{spark.years[0]}–{spark.years[spark.years.length - 1]}</TableHead>
                <TableHead className="text-right">Employers</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => {
                const series = spark.byKey.get(s.naics2);
                return (
                  <TableRow key={s.naics2}>
                    <TableCell className="text-muted-foreground tabular-nums">{s.rank}</TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link href={`/sector/${s.slug}`} className="hover:text-primary">{s.naics2}</Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/sector/${s.slug}`} className="font-medium hover:text-primary">
                        {s.label}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <MiniBar value={s.filings} max={maxFilings} />
                        <span className="tabular-nums">{fmt(s.filings)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {series ? <Sparkline values={series} /> : <span className="text-muted-foreground text-xs">—</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(s.employers)}</TableCell>
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
