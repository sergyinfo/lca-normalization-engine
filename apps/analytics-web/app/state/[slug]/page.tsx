import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import {
  getStateBySlug, getStateTopEmployers, getStateTopOccupations, getStateYearly,
  getEntitySummary, getEntityMeta, listAllStateSlugs, getSiteKpis, listTopStates,
  getSiteYearly,
} from '@/lib/queries';
import { fmt, fmtPct } from '@/lib/format';
import { entityMetadata, placeJsonLd } from '@/lib/seo';
import { loadArticle } from '@/lib/article';
import { SITE_URL } from '@/lib/site';

import type { KpiTile } from '@/components/EntityHero';
import { StateHeroClient } from '@/components/hero/StateHeroClient';
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
import { PageMinimap } from '@/components/PageMinimap';

export const dynamicParams = false;

export function generateStaticParams() {
  return listAllStateSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const s = getStateBySlug(slug);
  if (!s) return { title: 'Not found' };
  const m = getEntityMeta('state', slug);
  return entityMetadata({
    title: m?.meta_title ?? `H-1B sponsorship in ${s.name}`,
    description: m?.meta_description ?? `H-1B Labor Condition Applications filed for worksites in ${s.name}: ${s.filings.toLocaleString()} disclosures, top sponsoring employers, and top occupations.`,
    path: `/state/${slug}`,
  });
}

export default async function StatePage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const s = getStateBySlug(slug);
  if (!s) notFound();

  const [topEmps, topSocs, yearly, summary, article] = await Promise.all([
    Promise.resolve(getStateTopEmployers(s.code)),
    Promise.resolve(getStateTopOccupations(s.code)),
    Promise.resolve(getStateYearly(s.code)),
    Promise.resolve(getEntitySummary('state', slug)),
    loadArticle('state', slug),
  ]);
  const kpis = getSiteKpis();
  const sharePct = kpis.total_records > 0
    ? (s.filings / kpis.total_records) * 100
    : 0;
  const topEmployerShare = topEmps[0]?.share_pct ?? null;
  const topSoc = topSocs[0];

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
  const yearlyPts = yearly.map((y) => ({ label: `FY${y.year}`, value: y.filings }));

  const chips = [
    { label: s.code,            variant: 'secondary' as const },
    { label: `Rank #${s.rank}`, variant: 'outline'   as const },
  ];

  return (
    <>
      <nav aria-label="Breadcrumb" className="pb-2">
        <Link
          href="/state"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          All states
        </Link>
      </nav>

      <PageMinimap />

      <section data-section-id="hero" data-section-label="Overview">
      <StateHeroClient
        eyebrow="US state"
        chips={chips}
        updatedAt={kpis.generated_at}
        title={`H-1B sponsorship in ${s.name}`}
        subtitle={
          <>
            <span className="tabular-nums font-medium">{fmt(s.filings)}</span>{' '}
            H-1B Labor Condition Applications were filed for worksites in{' '}
            <strong className="text-foreground/90">{s.name}</strong> across the
            covered fiscal years. State concentration ratios and top
            sponsors below.
          </>
        }
        rank={s.rank}
        allTime={{ filings: s.filings, sharePct }}
        stateYearly={yearly.map((y) => ({ year: y.year, filings: y.filings }))}
        siteYearly={getSiteYearly().map((y) => ({ year: y.year, filings: y.filings }))}
        tailKpis={[
          ...(topEmployerShare != null ? [{
            label: 'Top sponsor share',
            value: `${topEmployerShare.toFixed(1)}%`,
            sub: (topEmps[0]!.canonical_name.length > 16
              ? topEmps[0]!.canonical_name.slice(0, 14) + '…'
              : topEmps[0]!.canonical_name) + ' · all years',
          }] : []),
          ...(topSoc ? [{
            label: 'Top occupation',
            value: topSoc.soc_code,
            sub: ((topSoc.soc_title ?? '').length > 18
              ? (topSoc.soc_title ?? '').slice(0, 16) + '…'
              : (topSoc.soc_title ?? '—')) + ' · all years',
          }] : []),
        ] satisfies KpiTile[]}
      />
      </section>

      <section data-section-id="summary" data-section-label="Summary">
        <Summary summary={summary} />
      </section>

      <AdSlot name="state-top" />

      <div className="grid lg:grid-cols-2 gap-6 pt-2">
        {/* ----- Top sponsoring employers ------------------------------ */}
        <Card data-section-id="top-employers" data-section-label="Top sponsors">
          <CardHeader>
            <CardTitle>Top sponsoring employers</CardTitle>
            <CardDescription>
              Highest-volume H-1B sponsors with worksites in {s.name}. Share %
              is each sponsor&rsquo;s portion of the state&rsquo;s total filings.
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
                      <TableHead className="text-right">Share</TableHead>
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
                        <TableCell className="text-right tabular-nums">{fmtPct(e.share_pct)}</TableCell>
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

        {/* ----- Top occupations sponsored ----------------------------- */}
        <Card data-section-id="top-occupations" data-section-label="Top occupations">
          <CardHeader>
            <CardTitle>Top occupations sponsored</CardTitle>
            <CardDescription>
              SOC codes filed most for worksites in {s.name}.
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

        {/* ----- Yearly trend ---------------------------------------- */}
        {yearlyPts.length > 0 ? (
          <Card
            className="lg:col-span-2"
            data-section-id="yearly"
            data-section-label="Yearly trend"
          >
            <CardHeader>
              <CardTitle>Filings by fiscal year</CardTitle>
              <CardDescription>
                {s.name} H-1B filing volume year over year — a hiring-demand
                signal for the state, not headcount.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LineChartClient data={yearlyPts} color="hsl(217 91% 55%)" height={240} />
            </CardContent>
          </Card>
        ) : null}
      </div>

      <AdSlot name="state-mid" />

      {article ? (
        <section data-section-id="article" data-section-label="Article">
          <Article article={article} />
        </section>
      ) : null}

      <div
        className="mt-8 space-y-4"
        data-section-id="compare"
        data-section-label="Compare & see also"
      >
        <ComparePicker
          kind="state"
          selfSlug={slug}
          selfLabel={s.name}
          peers={listTopStates(30)
            .filter((p) => p.slug !== slug)
            .map<PeerOption>((p) => ({
              slug: p.slug,
              label: p.name,
              hint: p.code,
            }))}
        />
        <SeeAlsoLinks kind="state" />
      </div>

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(placeJsonLd(s, `${SITE_URL}/state/${slug}`)),
        }}
      />

      <AdSlot name="state-bottom" />
    </>
  );
}
