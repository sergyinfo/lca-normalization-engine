import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { archiveExists, validateLabel } from '@/lib/archive';
import { withArchiveDb } from '@/lib/db';
import {
  getEmployer, getEmployerTopSocs, getEmployerYearly,
} from '@/lib/queries';
import { fmt, fmtPct, fmtFy } from '@/lib/format';

import { ArchiveBanner } from '@/components/ArchiveBanner';
import { EntityHero } from '@/components/EntityHero';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StackedBarSvg } from '@/components/charts/StackedBarSvg';
import { LineChartClient } from '@/components/charts/LineChartClient';
import { HorizontalBarSvg } from '@/components/charts/HorizontalBarSvg';

export const dynamicParams = true;

export async function generateMetadata(
  { params }: { params: Promise<{ label: string; slug: string }> },
): Promise<Metadata> {
  const { label, slug } = await params;
  if (!validateLabel(label) || !archiveExists(label)) return { title: 'Not found' };
  return withArchiveDb(label, () => {
    const e = getEmployer(slug);
    if (!e) return { title: 'Not found' };
    return {
      title: `${e.canonical_name} — archived ${label}`,
      description: `Archived H-1B sponsorship data for ${e.canonical_name} as of ${label}.`,
      robots: { index: false, follow: true },
      alternates: { canonical: `/employer/${slug}` },
    };
  });
}

export default async function ArchivedEmployerPage(
  { params }: { params: Promise<{ label: string; slug: string }> },
) {
  const { label, slug } = await params;
  if (!validateLabel(label) || !archiveExists(label)) notFound();

  return withArchiveDb(label, () => renderEmployerSnapshot(label, slug));
}

function renderEmployerSnapshot(label: string, slug: string) {
  const e = getEmployer(slug);
  if (!e) notFound();

  const topSocs = getEmployerTopSocs(slug);
  const yearly  = getEmployerYearly(slug);

  const socBars   = topSocs.map((s) => ({ label: s.soc_title ?? s.soc_code, value: s.filings }));
  const yearlyPts = yearly.map((y) => ({ label: `FY${y.year}`, value: y.filings }));

  const outcomeSlices = [
    { label: 'Certified',      value: e.certified_pct ?? 0,      color: 'hsl(160 84% 39%)' },
    { label: 'Cert-withdrawn', value: e.cert_withdrawn_pct ?? 0, color: 'hsl(38 92% 50%)' },
    { label: 'Withdrawn',      value: e.withdrawn_pct ?? 0,      color: 'hsl(220 14% 70%)' },
    { label: 'Denied',         value: e.denied_pct ?? 0,         color: 'hsl(0 84% 60%)' },
  ].filter((s) => s.value > 0);

  return (
    <>
      <ArchiveBanner label={label} livePath={`/employer/${slug}`} />

      <nav aria-label="Breadcrumb" className="pb-2">
        <Link
          href={`/archive/${label}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> {label} archive
        </Link>
      </nav>

      <EntityHero
        eyebrow="Archived sponsor"
        chips={[
          ...(e.employer_state ? [{ label: e.employer_state }] : []),
          { label: `Rank #${e.rank} in ${label}`, variant: 'secondary' as const },
        ]}
        title={e.canonical_name}
        subtitle={
          <>
            Frozen snapshot of {e.canonical_name}&rsquo;s H-1B activity as of {label}.
            Filed <span className="tabular-nums font-medium">{fmt(e.filings)}</span> LCAs
            between {fmtFy(e.first_year)} and {fmtFy(e.last_year)}.
          </>
        }
        kpis={[
          { label: 'Filings',   value: fmt(e.filings),         sub: `Rank #${e.rank}`,    accent: true },
          { label: 'Certified', value: fmtPct(e.certified_pct), sub: 'unconditional' },
          { label: 'Withdrawn', value: fmtPct(e.withdrawn_pct), sub: 'incl. cert-withdrawn' },
          { label: 'Denied',    value: fmtPct(e.denied_pct),    sub: 'rejection rate' },
        ]}
      />

      {outcomeSlices.length > 0 ? (
        <Card className="mt-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Outcome breakdown</CardTitle>
            <CardDescription>Frozen at {label}.</CardDescription>
          </CardHeader>
          <CardContent>
            <StackedBarSvg slices={outcomeSlices} />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid lg:grid-cols-2 gap-6 pt-6">
        {topSocs.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Top occupations sponsored</CardTitle>
              <CardDescription>SOC mix at {label}.</CardDescription>
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
                  {topSocs.map((s) => (
                    <TableRow key={s.soc_code}>
                      <TableCell className="text-muted-foreground tabular-nums">{s.rank}</TableCell>
                      <TableCell className="font-mono text-xs">{s.soc_code}</TableCell>
                      <TableCell>{s.soc_title ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(s.filings)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="border-t px-4 py-3">
                <HorizontalBarSvg
                  data={socBars}
                  labelWidth={180}
                  gradient={['hsl(217 91% 55%)', 'hsl(190 95% 50%)']}
                />
              </div>
            </CardContent>
          </Card>
        ) : null}

        {yearly.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Filings by year</CardTitle>
              <CardDescription>Year-over-year demand at {label}.</CardDescription>
            </CardHeader>
            <CardContent>
              <LineChartClient data={yearlyPts} color="hsl(217 91% 55%)" height={240} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
