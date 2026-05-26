import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import {
  getEmployer, getEmployerTopSocs, getEmployerYearly,
  getEntitySummary, listAllEmployerSlugs, listTopEmployers, getSiteKpis,
} from '@/lib/queries';
import { fmt, fmtPct, fmtFy } from '@/lib/format';
import { entityMetadata, organizationJsonLd } from '@/lib/seo';
import { loadArticle } from '@/lib/article';
import { SITE_URL } from '@/lib/site';

import { EntityHero } from '@/components/EntityHero';
import { Summary } from '@/components/Summary';
import { Article } from '@/components/Article';
import { AdSlot } from '@/components/AdSlot';
import { ComparePicker, type PeerOption } from '@/components/ComparePicker';
import { SeeAlsoLinks } from '@/components/SeeAlsoLinks';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { HorizontalBarSvg } from '@/components/charts/HorizontalBarSvg';
import { LineChartClient } from '@/components/charts/LineChartClient';
import { StackedBarSvg } from '@/components/charts/StackedBarSvg';
import { PageMinimap } from '@/components/PageMinimap';

export const dynamicParams = false;

export function generateStaticParams() {
  return listAllEmployerSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const e = getEmployer(slug);
  if (!e) return { title: 'Not found' };
  return entityMetadata({
    title: `${e.canonical_name} — H-1B sponsor profile`,
    description: `H-1B sponsorship data for ${e.canonical_name}: ${e.filings.toLocaleString()} Labor Condition Applications filed, ${fmtPct(e.certified_pct)} certified, top occupations and yearly trend.`,
    path: `/employer/${slug}`,
  });
}

export default async function EmployerPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const e = getEmployer(slug);
  if (!e) notFound();

  const [topSocs, yearly, summary, article] = await Promise.all([
    Promise.resolve(getEmployerTopSocs(slug)),
    Promise.resolve(getEmployerYearly(slug)),
    Promise.resolve(getEntitySummary('employer', slug)),
    loadArticle('employer', slug),
  ]);

  const socBars   = topSocs.map((s) => ({
    label: s.soc_title ?? s.soc_code,
    value: s.filings,
  }));
  const yearlyPts = yearly.map((y) => ({ label: `FY${y.year}`, value: y.filings }));

  // Outcomes stacked bar — only if we have any of the four percentages.
  const outcomeSlices = [
    { label: 'Certified',      value: e.certified_pct ?? 0,     color: 'hsl(160 84% 39%)' },
    { label: 'Cert-withdrawn', value: e.cert_withdrawn_pct ?? 0, color: 'hsl(38  92% 50%)' },
    { label: 'Withdrawn',      value: e.withdrawn_pct ?? 0,     color: 'hsl(220 14% 70%)' },
    { label: 'Denied',         value: e.denied_pct ?? 0,        color: 'hsl(0   84% 60%)' },
  ].filter((s) => s.value > 0);
  const hasOutcomes = outcomeSlices.length > 0;

  const chips = [
    ...(e.employer_state ? [{ label: e.employer_state }] : []),
    ...(e.rank != null
      ? [{ label: `Rank #${e.rank}`, variant: 'secondary' as const }]
      : []),
    ...(e.fein ? [{ label: `FEIN ${e.fein}`, variant: 'outline' as const }] : []),
  ];

  return (
    <>
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="pb-2">
        <Link
          href="/employer"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          All sponsors
        </Link>
      </nav>

      <PageMinimap />

      <section data-section-id="hero" data-section-label="Overview">
      <EntityHero
        eyebrow="H-1B sponsor"
        chips={chips}
        updatedAt={getSiteKpis().generated_at}
        title={e.canonical_name}
        subtitle={
          <>
            US H-1B Labor Condition Application activity for{' '}
            <strong className="text-foreground/90">{e.canonical_name}</strong>.{' '}
            Filed <span className="tabular-nums font-medium">{fmt(e.filings)}</span> disclosures between{' '}
            {fmtFy(e.first_year)} and {fmtFy(e.last_year)}
            {e.employer_state ? (
              <> from worksites with a {e.employer_state} headquarters indicator.</>
            ) : '.'}
          </>
        }
        kpis={[
          { label: 'Total filings', value: fmt(e.filings),         sub: e.rank != null ? `Rank #${e.rank}` : 'Outside top-N',       accent: true },
          { label: 'Certified',     value: fmtPct(e.certified_pct), sub: 'unconditional approval' },
          { label: 'Withdrawn',     value: fmtPct(e.withdrawn_pct), sub: 'incl. cert-withdrawn' },
          { label: 'Denied',        value: fmtPct(e.denied_pct),    sub: 'rejection rate' },
        ]}
      />
      </section>

      <section data-section-id="summary" data-section-label="Summary">
        <Summary summary={summary} />
      </section>

      {/* Outcomes stacked bar — compact, one-line view at the top. */}
      {hasOutcomes ? (
        <Card
          className="mt-2"
          data-section-id="outcomes"
          data-section-label="Outcomes"
        >
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Outcome breakdown</CardTitle>
            <CardDescription>
              Share of {e.canonical_name}&rsquo;s LCAs by DOL case status.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StackedBarSvg slices={outcomeSlices} />
          </CardContent>
        </Card>
      ) : null}

      <AdSlot name="employer-top" />

      <div
        className="grid lg:grid-cols-2 gap-6 pt-2"
        data-section-id="breakdown"
        data-section-label="Top SOCs & yearly"
      >
        {/* ----- Top occupations sponsored -------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Top occupations sponsored</CardTitle>
            <CardDescription>
              SOC codes filed most by {e.canonical_name}. Click any row to open
              the national salary guide.
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
                    {topSocs.map((s) => (
                      <TableRow key={s.soc_code}>
                        <TableCell className="text-muted-foreground tabular-nums">{s.rank}</TableCell>
                        <TableCell className="font-mono text-xs">{s.soc_code}</TableCell>
                        <TableCell>
                          {s.soc_slug ? (
                            <Link href={`/occupation/${s.soc_slug}`} className="font-medium hover:text-primary">
                              {s.soc_title ?? '—'}
                            </Link>
                          ) : (
                            <span>{s.soc_title ?? '—'}</span>
                          )}
                        </TableCell>
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
              </>
            ) : (
              <p className="px-6 pb-6 text-sm text-muted-foreground">No occupation breakdown available.</p>
            )}
          </CardContent>
        </Card>

        {/* ----- Filings by year ----------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Filings by fiscal year</CardTitle>
            <CardDescription>
              Year-over-year H-1B filing volume — a hiring-demand signal,
              not headcount.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {yearly.length > 0 ? (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Year</TableHead>
                      <TableHead className="text-right">Filings</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {yearly.map((y) => (
                      <TableRow key={y.year}>
                        <TableCell>FY{y.year}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(y.filings)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="border-t px-4 py-3">
                  <LineChartClient data={yearlyPts} color="hsl(217 91% 55%)" height={220} />
                </div>
              </>
            ) : (
              <p className="px-6 pb-6 text-sm text-muted-foreground">No yearly breakdown available.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <AdSlot name="employer-mid" />

      {article ? (
        <section data-section-id="article" data-section-label="Article">
          <Article article={article} />
        </section>
      ) : null}

      {/* Real compare CTA — pick a peer, see side-by-side. */}
      <div
        className="mt-8 space-y-4"
        data-section-id="compare"
        data-section-label="Compare & see also"
      >
        <ComparePicker
          kind="employer"
          selfSlug={slug}
          selfLabel={e.canonical_name}
          peers={listTopEmployers(50)
            .filter((p) => p.slug !== slug)
            .map<PeerOption>((p) => ({
              slug: p.slug,
              label: p.canonical_name,
              hint: p.employer_state ?? undefined,
            }))}
        />
        <SeeAlsoLinks kind="employer" />
      </div>

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(organizationJsonLd(e, `${SITE_URL}/employer/${slug}`)),
        }}
      />
    </>
  );
}
