import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { archiveExists, validateLabel } from '@/lib/archive';
import { withArchiveDb } from '@/lib/db';
import {
  getSectorBySlug, getSectorTopEmployers, getSectorTopOccupations,
  getSectorTopStates, getSectorYearly,
} from '@/lib/queries';
import { fmt } from '@/lib/format';

import { ArchiveBanner } from '@/components/ArchiveBanner';
import { EntityHero } from '@/components/EntityHero';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LineChartClient } from '@/components/charts/LineChartClient';

export const dynamicParams = true;

export async function generateMetadata(
  { params }: { params: Promise<{ label: string; slug: string }> },
): Promise<Metadata> {
  const { label, slug } = await params;
  if (!validateLabel(label) || !archiveExists(label)) return { title: 'Not found' };
  return withArchiveDb(label, () => {
    const s = getSectorBySlug(slug);
    if (!s) return { title: 'Not found' };
    return {
      title: `${s.label} (NAICS ${s.naics2}) — archived ${label}`,
      description: `Archived H-1B sponsorship in the ${s.label} sector as of ${label}.`,
      robots: { index: false, follow: true },
      alternates: { canonical: `/sector/${slug}` },
    };
  });
}

export default async function ArchivedSectorPage(
  { params }: { params: Promise<{ label: string; slug: string }> },
) {
  const { label, slug } = await params;
  if (!validateLabel(label) || !archiveExists(label)) notFound();
  return withArchiveDb(label, () => renderSectorSnapshot(label, slug));
}

function renderSectorSnapshot(label: string, slug: string) {
  const s = getSectorBySlug(slug);
  if (!s) notFound();

  const topEmps   = getSectorTopEmployers(s.naics2);
  const topSocs   = getSectorTopOccupations(s.naics2);
  const topStates = getSectorTopStates(s.naics2);
  const yearly    = getSectorYearly(s.naics2);
  const yearlyPts = yearly.map((y) => ({ label: `FY${y.year}`, value: y.filings }));

  return (
    <>
      <ArchiveBanner label={label} livePath={`/sector/${slug}`} />

      <nav aria-label="Breadcrumb" className="pb-2">
        <Link href={`/archive/${label}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> {label} archive
        </Link>
      </nav>

      <EntityHero
        eyebrow="Archived sector"
        chips={[
          { label: `NAICS ${s.naics2}`,           variant: 'secondary' as const },
          { label: `Rank #${s.rank} in ${label}`, variant: 'outline' as const },
        ]}
        title={s.label}
        subtitle={<>Frozen sector activity as of {label}.</>}
        kpis={[
          { label: 'Filings',   value: fmt(s.filings),   sub: `Rank #${s.rank}`, accent: true },
          { label: 'Employers', value: fmt(s.employers), sub: 'distinct sponsors' },
        ]}
      />

      <div className="grid lg:grid-cols-2 gap-6 pt-2">
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

        {topSocs.length > 0 ? (
          <Card>
            <CardHeader><CardTitle>Top occupations</CardTitle></CardHeader>
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
                  {topSocs.map((o) => (
                    <TableRow key={o.soc_code}>
                      <TableCell className="text-muted-foreground tabular-nums">{o.rank}</TableCell>
                      <TableCell className="font-mono text-xs">{o.soc_code}</TableCell>
                      <TableCell>{o.soc_title ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(o.filings)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topStates.map((st) => (
                    <TableRow key={st.state}>
                      <TableCell className="text-muted-foreground tabular-nums">{st.rank}</TableCell>
                      <TableCell className="font-medium">{st.state}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(st.filings)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}

        {yearly.length > 0 ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Filings by fiscal year</CardTitle>
              <CardDescription>Frozen at {label}.</CardDescription>
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
