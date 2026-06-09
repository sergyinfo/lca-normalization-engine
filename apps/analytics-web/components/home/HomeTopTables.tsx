'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { useHomeYear } from '@/components/home/HomeYearContext';
import { pickScope, type Scoped, type HomeTableBundle } from '@/components/home/bundles';
import { fmt } from '@/lib/format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function HomeTopTables({ bundles }: { bundles: Scoped<HomeTableBundle> }) {
  const { selected } = useHomeYear();
  const b = pickScope(bundles, selected);
  const scope = selected === 'all' ? 'total filings' : `filings in FY${selected}`;

  return (
    <section className="grid md:grid-cols-2 gap-6 pt-8">
      <Card>
        <CardHeader>
          <CardTitle>Top H-1B sponsors</CardTitle>
          <CardDescription>Canonical employers by {scope}</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Employer</TableHead>
                <TableHead className="text-right">Filings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {b.employers.map((e, i) => (
                <TableRow key={e.slug}>
                  <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                  <TableCell>
                    <Link href={`/employer/${e.slug}`} className="font-medium hover:text-primary">{e.canonical_name}</Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(e.filings)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="border-t p-3">
            <Link href="/top-h1b-sponsors" className="text-sm text-primary hover:underline inline-flex items-center gap-1">
              View top 100 <ArrowRight className="size-3" />
            </Link>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Top H-1B occupations</CardTitle>
          <CardDescription>SOC codes by {scope}</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>SOC</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="text-right">Filings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {b.occupations.map((o, i) => (
                <TableRow key={o.soc_code}>
                  <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/occupation/${o.slug}`} className="hover:text-primary">{o.soc_code}</Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/occupation/${o.slug}`} className="font-medium hover:text-primary">{o.soc_title}</Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(o.filings)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="border-t p-3">
            <Link href="/top-h1b-occupations" className="text-sm text-primary hover:underline inline-flex items-center gap-1">
              View top 100 <ArrowRight className="size-3" />
            </Link>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
