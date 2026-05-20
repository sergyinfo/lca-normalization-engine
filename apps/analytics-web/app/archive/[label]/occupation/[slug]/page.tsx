import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { archiveExists, validateLabel } from '@/lib/archive';
import { withArchiveDb } from '@/lib/db';
import {
  getOccupationBySlug, getOccupationLevels, getOccupationTopStates,
  getOccupationTopEmployers, getOccupationYearly,
} from '@/lib/queries';
import { fmt, fmtUsd } from '@/lib/format';

import { ArchiveBanner } from '@/components/ArchiveBanner';
import { EntityHero } from '@/components/EntityHero';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LevelLadderClient } from '@/components/charts/LevelLadderClient';
import { LineChartClient } from '@/components/charts/LineChartClient';

export const dynamicParams = true;

export async function generateMetadata(
  { params }: { params: Promise<{ label: string; slug: string }> },
): Promise<Metadata> {
  const { label, slug } = await params;
  if (!validateLabel(label) || !archiveExists(label)) return { title: 'Not found' };
  return withArchiveDb(label, () => {
    const o = getOccupationBySlug(slug);
    if (!o) return { title: 'Not found' };
    return {
      title: `${o.soc_title ?? o.soc_code} — archived ${label}`,
      description: `Archived H-1B wage data for ${o.soc_title ?? o.soc_code} as of ${label}.`,
      robots: { index: false, follow: true },
      alternates: { canonical: `/occupation/${slug}` },
    };
  });
}

export default async function ArchivedOccupationPage(
  { params }: { params: Promise<{ label: string; slug: string }> },
) {
  const { label, slug } = await params;
  if (!validateLabel(label) || !archiveExists(label)) notFound();
  return withArchiveDb(label, () => renderOccupationSnapshot(label, slug));
}

function renderOccupationSnapshot(label: string, slug: string) {
  const o = getOccupationBySlug(slug);
  if (!o) notFound();

  const levels    = getOccupationLevels(o.soc_code);
  const topStates = getOccupationTopStates(o.soc_code);
  const topEmps   = getOccupationTopEmployers(o.soc_code);
  const yearly    = getOccupationYearly(o.soc_code);

  const ladder = levels.map((l) => ({
    level: `Level ${l.wage_level}`,
    p25: l.p25_wage, p50: l.p50_wage, p75: l.p75_wage,
  }));
  const trend = yearly.map((y) => ({ label: `FY${y.year}`, value: y.median_wage ?? 0 }));

  return (
    <>
      <ArchiveBanner label={label} livePath={`/occupation/${slug}`} />

      <nav aria-label="Breadcrumb" className="pb-2">
        <Link href={`/archive/${label}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> {label} archive
        </Link>
      </nav>

      <EntityHero
        eyebrow="Archived salary guide"
        chips={[
          { label: `SOC ${o.soc_code}`,        variant: 'secondary' as const },
          { label: `Rank #${o.rank} in ${label}`, variant: 'outline' as const },
        ]}
        title={o.soc_title ?? o.soc_code}
        subtitle={<>Frozen wage data for {o.soc_title ?? `SOC ${o.soc_code}`} as of {label}.</>}
        kpis={[
          { label: 'Median wage', value: fmtUsd(o.p50_wage), sub: 'P50 across filings', accent: true },
          { label: 'P25 wage',    value: fmtUsd(o.p25_wage), sub: 'lower quartile' },
          { label: 'P75 wage',    value: fmtUsd(o.p75_wage), sub: 'upper quartile' },
          { label: 'Filings',     value: fmt(o.filings),     sub: `Rank #${o.rank}` },
        ]}
      />

      <div className="grid lg:grid-cols-2 gap-6 pt-2">
        {levels.length > 0 ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Wage by DOL prevailing-wage level</CardTitle>
              <CardDescription>P25 / P50 / P75 at each PW_WAGE_LEVEL ({label}).</CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Level</TableHead>
                    <TableHead className="text-right">N</TableHead>
                    <TableHead className="text-right">P25</TableHead>
                    <TableHead className="text-right">Median</TableHead>
                    <TableHead className="text-right">P75</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {levels.map((l) => (
                    <TableRow key={l.wage_level}>
                      <TableCell className="font-medium">Level {l.wage_level}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(l.n_wages)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtUsd(l.p25_wage)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtUsd(l.p50_wage)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtUsd(l.p75_wage)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="border-t px-4 py-3">
                <LevelLadderClient data={ladder} height={240} />
              </div>
            </CardContent>
          </Card>
        ) : null}

        {topStates.length > 0 ? (
          <Card>
            <CardHeader><CardTitle>Top hiring states</CardTitle></CardHeader>
            <CardContent className="px-0 pb-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="text-right">Filings</TableHead>
                    <TableHead className="text-right">Median</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topStates.map((s) => (
                    <TableRow key={s.state}>
                      <TableCell className="text-muted-foreground tabular-nums">{s.rank}</TableCell>
                      <TableCell className="font-medium">{s.state}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(s.filings)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtUsd(s.p50_wage)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}

        {topEmps.length > 0 ? (
          <Card>
            <CardHeader><CardTitle>Top sponsoring employers</CardTitle></CardHeader>
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
                  {topEmps.map((e) => (
                    <TableRow key={e.employer_slug}>
                      <TableCell className="text-muted-foreground tabular-nums">{e.rank}</TableCell>
                      <TableCell className="font-medium">{e.canonical_name}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(e.filings)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}

        {trend.length > 0 ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Median wage by fiscal year</CardTitle>
              <CardDescription>Frozen at {label}.</CardDescription>
            </CardHeader>
            <CardContent>
              <LineChartClient data={trend} color="hsl(217 91% 55%)" valueFormat="usd-short" height={240} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
