import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, Factory } from 'lucide-react';

import {
  getSectorBySlug, getEntitySummary, listAllSectorSlugs,
  getSectorTopEmployers, getSectorTopOccupations,
  getSectorTopStates, getSectorYearly,
} from '@/lib/queries';
import { fmt } from '@/lib/format';
import { entityMetadata } from '@/lib/seo';
import { loadArticle } from '@/lib/article';
import { SITE_URL } from '@/lib/site';

import { EntityHero } from '@/components/EntityHero';
import { Summary } from '@/components/Summary';
import { Article } from '@/components/Article';
import { AdSlot } from '@/components/AdSlot';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { HorizontalBarSvg } from '@/components/charts/HorizontalBarSvg';
import { LineChartClient } from '@/components/charts/LineChartClient';

export const dynamicParams = false;

export function generateStaticParams() {
  return listAllSectorSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const s = getSectorBySlug(slug);
  if (!s) return { title: 'Not found' };
  return entityMetadata({
    title: `${s.label} — H-1B Sponsorship (NAICS ${s.naics2})`,
    description: `H-1B Labor Condition Applications filed by employers in NAICS sector ${s.naics2} (${s.label}): ${s.filings.toLocaleString()} disclosures from ${s.employers.toLocaleString()} distinct sponsoring employers.`,
    path: `/sector/${slug}`,
  });
}

export default async function SectorPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const s = getSectorBySlug(slug);
  if (!s) notFound();

  const [topEmps, topSocs, topStates, yearly, summary, article] = await Promise.all([
    Promise.resolve(getSectorTopEmployers(s.naics2)),
    Promise.resolve(getSectorTopOccupations(s.naics2)),
    Promise.resolve(getSectorTopStates(s.naics2)),
    Promise.resolve(getSectorYearly(s.naics2)),
    Promise.resolve(getEntitySummary('sector', slug)),
    loadArticle('sector', slug),
  ]);

  const empBars = topEmps.map((e) => ({
    label: e.canonical_name.length > 28 ? e.canonical_name.slice(0, 26) + '…' : e.canonical_name,
    value: e.filings,
  }));
  const socBars = topSocs.map((o) => ({
    label: (o.soc_title ?? o.soc_code).length > 28
      ? (o.soc_title ?? o.soc_code).slice(0, 26) + '…'
      : (o.soc_title ?? o.soc_code),
    value: o.filings,
  }));
  const stateBars = topStates.map((st) => ({ label: st.state, value: st.filings }));
  const yearlyPts = yearly.map((y) => ({ label: `FY${y.year}`, value: y.filings }));

  const chips = [
    { label: `NAICS ${s.naics2}`, variant: 'secondary' as const },
    { label: `Rank #${s.rank}`,   variant: 'outline'   as const },
  ];

  const filingsPerEmployer = s.employers > 0
    ? Math.round(Number(s.filings) / Number(s.employers))
    : null;

  return (
    <>
      <nav aria-label="Breadcrumb" className="pb-2">
        <Link
          href="/sector"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          All sectors
        </Link>
      </nav>

      <EntityHero
        eyebrow="NAICS industry sector"
        chips={chips}
        title={s.label}
        subtitle={
          <>
            H-1B sponsorship activity by employers classified under NAICS
            2-digit sector{' '}
            <strong className="text-foreground/90">{s.naics2}</strong>.{' '}
            <span className="tabular-nums font-medium">{fmt(s.filings)}</span>{' '}
            filings from{' '}
            <span className="tabular-nums font-medium">{fmt(s.employers)}</span>{' '}
            distinct sponsoring employers.
          </>
        }
        kpis={[
          { label: 'Filings',     value: fmt(s.filings),     sub: `Rank #${s.rank}`, accent: true },
          { label: 'Employers',   value: fmt(s.employers),   sub: 'distinct sponsors' },
          ...(filingsPerEmployer != null ? [{
            label: 'Filings / employer',
            value: fmt(filingsPerEmployer),
            sub: 'concentration hint',
          }] : []),
        ]}
      />

      <Summary summary={summary} />

      <AdSlot name="sector-top" />

      {/* Yearly trend — single full-width chart at the top of the analytics block */}
      {yearlyPts.length > 0 ? (
        <Card className="mt-2">
          <CardHeader>
            <CardTitle>Filings by fiscal year</CardTitle>
            <CardDescription>
              H-1B filing volume in the {s.label} sector year over year.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LineChartClient data={yearlyPts} color="hsl(217 91% 55%)" height={260} />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid lg:grid-cols-2 gap-6 pt-6">
        {/* ----- Top sponsoring employers ------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Top sponsoring employers</CardTitle>
            <CardDescription>
              Largest H-1B sponsors in the {s.label} sector.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {topEmps.length > 0 ? (
              <>
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
                        <TableCell>
                          <Link href={`/employer/${e.employer_slug}`} className="font-medium hover:text-primary">
                            {e.canonical_name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(e.filings)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="border-t px-4 py-3">
                  <HorizontalBarSvg
                    data={empBars}
                    labelWidth={180}
                    gradient={['hsl(217 91% 55%)', 'hsl(190 95% 50%)']}
                  />
                </div>
              </>
            ) : <p className="px-6 pb-6 text-sm text-muted-foreground">No employer breakdown available.</p>}
          </CardContent>
        </Card>

        {/* ----- Top occupations ---------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Top occupations sponsored</CardTitle>
            <CardDescription>
              SOC codes filed most by employers in this sector.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {topSocs.length > 0 ? (
              <>
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
                        <TableCell>
                          {o.soc_slug ? (
                            <Link href={`/occupation/${o.soc_slug}`} className="font-medium hover:text-primary">
                              {o.soc_title ?? '—'}
                            </Link>
                          ) : <span className="font-medium">{o.soc_title ?? '—'}</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(o.filings)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="border-t px-4 py-3">
                  <HorizontalBarSvg
                    data={socBars}
                    labelWidth={180}
                    gradient={['hsl(262 83% 62%)', 'hsl(330 81% 60%)']}
                  />
                </div>
              </>
            ) : <p className="px-6 pb-6 text-sm text-muted-foreground">No occupation breakdown available.</p>}
          </CardContent>
        </Card>

        {/* ----- Top hiring states -------------------------------------- */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Top hiring states</CardTitle>
            <CardDescription>
              Worksite states with the most filings from the {s.label} sector.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {topStates.length > 0 ? (
              <>
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
                        <TableCell>
                          {st.state_slug ? (
                            <Link href={`/state/${st.state_slug}`} className="font-medium hover:text-primary">
                              {st.state}
                            </Link>
                          ) : <span className="font-medium">{st.state}</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(st.filings)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="border-t px-4 py-3">
                  <HorizontalBarSvg
                    data={stateBars}
                    labelWidth={80}
                    gradient={['hsl(38 92% 50%)', 'hsl(20 91% 55%)']}
                  />
                </div>
              </>
            ) : <p className="px-6 pb-6 text-sm text-muted-foreground">No state breakdown available.</p>}
          </CardContent>
        </Card>
      </div>

      <AdSlot name="sector-mid" />

      <Article article={article} />

      <Card className="mt-8 bg-secondary/30 border-primary/20">
        <CardContent className="p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="size-9 rounded-md bg-background flex items-center justify-center text-primary">
              <Factory className="size-4" />
            </div>
            <div>
              <div className="font-semibold">Compare across industries</div>
              <div className="text-sm text-muted-foreground">
                Where this sector sits in the broader US H-1B landscape.
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/sector">All sectors</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/h1b-by-industry">Industry ranking</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
