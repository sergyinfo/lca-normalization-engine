import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, Briefcase } from 'lucide-react';

import {
  getOccupationBySlug, getOccupationLevels, getOccupationTopStates,
  getOccupationTopEmployers, getOccupationYearly, getEntitySummary,
  listAllOccupationSlugs,
} from '@/lib/queries';
import { fmt, fmtUsd } from '@/lib/format';
import { entityMetadata, occupationJsonLd } from '@/lib/seo';
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
import { LevelLadderClient } from '@/components/charts/LevelLadderClient';
import { LineChartClient } from '@/components/charts/LineChartClient';
import { HorizontalBarSvg } from '@/components/charts/HorizontalBarSvg';

export const dynamicParams = false;

export function generateStaticParams() {
  return listAllOccupationSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const o = getOccupationBySlug(slug);
  if (!o) return { title: 'Not found' };
  const title = o.soc_title
    ? `${o.soc_title} — H-1B Salary Guide (${o.soc_code})`
    : `SOC ${o.soc_code} H-1B Salary Guide`;
  return entityMetadata({
    title,
    description: `H-1B prevailing-wage data for ${o.soc_title ?? o.soc_code}: ${o.filings.toLocaleString()} filings, median wage ${fmtUsd(o.p50_wage)}, plus top hiring states and employers.`,
    path: `/occupation/${slug}`,
  });
}

export default async function OccupationPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const o = getOccupationBySlug(slug);
  if (!o) notFound();

  const [levels, topStates, topEmps, yearly, summary, article] = await Promise.all([
    Promise.resolve(getOccupationLevels(o.soc_code)),
    Promise.resolve(getOccupationTopStates(o.soc_code)),
    Promise.resolve(getOccupationTopEmployers(o.soc_code)),
    Promise.resolve(getOccupationYearly(o.soc_code)),
    Promise.resolve(getEntitySummary('occupation', slug)),
    loadArticle('occupation', slug),
  ]);

  const ladder = levels.map((l) => ({
    level: `Level ${l.wage_level}`,
    p25: l.p25_wage, p50: l.p50_wage, p75: l.p75_wage,
  }));
  const trend = yearly.map((y) => ({ label: `FY${y.year}`, value: y.median_wage }));
  const stateBars = topStates.map((s) => ({ label: s.state, value: s.filings }));
  const empBars   = topEmps.map((e) => ({
    label: e.canonical_name.length > 28
      ? e.canonical_name.slice(0, 26) + '…'
      : e.canonical_name,
    value: e.filings,
  }));

  const chips = [
    { label: `SOC ${o.soc_code}`, variant: 'secondary' as const },
    { label: `Rank #${o.rank}`,   variant: 'outline'   as const },
  ];

  return (
    <>
      <nav aria-label="Breadcrumb" className="pb-2">
        <Link
          href="/occupation"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          All occupations
        </Link>
      </nav>

      <EntityHero
        eyebrow="H-1B salary guide"
        chips={chips}
        title={o.soc_title ?? o.soc_code}
        subtitle={
          <>
            H-1B prevailing-wage data for{' '}
            <strong className="text-foreground/90">{o.soc_title ?? `SOC ${o.soc_code}`}</strong>{' '}
            (SOC {o.soc_code}). Based on{' '}
            <span className="tabular-nums font-medium">{fmt(o.filings)}</span>{' '}
            Labor Condition Applications filed with the US Department of Labor.
          </>
        }
        kpis={[
          { label: 'Median wage', value: fmtUsd(o.p50_wage), sub: 'P50 across filings', accent: true },
          { label: 'P25 wage',    value: fmtUsd(o.p25_wage), sub: 'lower quartile' },
          { label: 'P75 wage',    value: fmtUsd(o.p75_wage), sub: 'upper quartile' },
          { label: 'Filings',     value: fmt(o.filings),     sub: `Rank #${o.rank}` },
        ]}
      />

      <Summary summary={summary} />

      <AdSlot name="occupation-top" />

      <div className="grid lg:grid-cols-2 gap-6 pt-2">
        {/* ----- Career ladder ------------------------------------------- */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Wage by DOL prevailing-wage level</CardTitle>
            <CardDescription>
              P25 / P50 / P75 of offered annual wage at each PW_WAGE_LEVEL.
              Level I = entry, Level IV = expert — the I-to-IV gap is the
              career runway.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {levels.length > 0 ? (
              <>
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
                  <LevelLadderClient data={ladder} height={260} />
                </div>
              </>
            ) : <p className="px-6 pb-6 text-sm text-muted-foreground">No level breakdown available.</p>}
          </CardContent>
        </Card>

        {/* ----- Top hiring states --------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Top hiring states</CardTitle>
            <CardDescription>
              Worksite states with the most filings for this SOC, with the
              local median wage.
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
                      <TableHead className="text-right">Median</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topStates.map((s) => (
                      <TableRow key={s.state}>
                        <TableCell className="text-muted-foreground tabular-nums">{s.rank}</TableCell>
                        <TableCell>
                          {s.state_slug ? (
                            <Link href={`/state/${s.state_slug}`} className="font-medium hover:text-primary">
                              {s.state}
                            </Link>
                          ) : <span className="font-medium">{s.state}</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(s.filings)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtUsd(s.p50_wage)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="border-t px-4 py-3">
                  <HorizontalBarSvg
                    data={stateBars}
                    labelWidth={80}
                    gradient={['hsl(217 91% 55%)', 'hsl(190 95% 50%)']}
                  />
                </div>
              </>
            ) : <p className="px-6 pb-6 text-sm text-muted-foreground">No state breakdown available.</p>}
          </CardContent>
        </Card>

        {/* ----- Top sponsoring employers ------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Top sponsoring employers</CardTitle>
            <CardDescription>Who actually files most for this role.</CardDescription>
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
                    gradient={['hsl(262 83% 62%)', 'hsl(330 81% 60%)']}
                  />
                </div>
              </>
            ) : <p className="px-6 pb-6 text-sm text-muted-foreground">No employer breakdown available.</p>}
          </CardContent>
        </Card>

        {/* ----- Yearly median wage ------------------------------------- */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Median wage by fiscal year</CardTitle>
            <CardDescription>
              How the typical offered wage for this SOC has drifted across
              fiscal years.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {trend.length > 0 ? (
              <LineChartClient
                data={trend.map((p) => ({ label: p.label, value: p.value ?? 0 }))}
                color="hsl(217 91% 55%)"
                valueFormat="usd-short"
                height={260}
              />
            ) : <p className="text-sm text-muted-foreground">No yearly breakdown available.</p>}
          </CardContent>
        </Card>
      </div>

      <AdSlot name="occupation-mid" />

      <Article article={article} />

      <Card className="mt-8 bg-secondary/30 border-primary/20">
        <CardContent className="p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="size-9 rounded-md bg-background flex items-center justify-center text-primary">
              <Briefcase className="size-4" />
            </div>
            <div>
              <div className="font-semibold">More occupation context</div>
              <div className="text-sm text-muted-foreground">
                Compare across all SOCs and find what pays best.
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/top-h1b-occupations">Top occupations</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/highest-paying-h1b-jobs">Highest-paying</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(occupationJsonLd(o, `${SITE_URL}/occupation/${slug}`)),
        }}
      />
    </>
  );
}
