import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ArrowRight, Building2, Briefcase, MapPin, Factory, Trophy, Sparkles,
} from 'lucide-react';

import {
  getSiteKpis, getSiteYearly, listTopEmployers, listTopOccupations,
  listHighestPayingOccupations, listTopSectors, listTopStates, getEntitySummary,
  getHomeTopEmployersByYear, getHomeTopOccupationsByYear, getHomeTopPayingByYear,
  getHomeSectorsByYear, getHomeTopStatesByYear,
} from '@/lib/queries';
import { fmt } from '@/lib/format';
import { websiteJsonLd, datasetJsonLd } from '@/lib/seo';
import { SITE_URL, SITE_NAME } from '@/lib/site';
import { FEATURES } from '@/lib/features';
import { AdSlot } from '@/components/AdSlot';
import { Summary } from '@/components/Summary';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HomeYearProvider } from '@/components/home/HomeYearContext';
import { YearNav } from '@/components/home/YearNav';
import { HomeKpiStrip } from '@/components/home/HomeKpiStrip';
import { HomeCharts } from '@/components/home/HomeCharts';
import { HomeTopTables } from '@/components/home/HomeTopTables';
import type {
  Scoped, HomeKpiBundle, HomeChartBundle, HomeTableBundle, DonutSlice,
} from '@/components/home/bundles';

export const metadata: Metadata = {
  title: 'H-1B Sponsors, Salaries & LCA Data',
  description:
    'Free deep-dives into the US H-1B program: per-employer profiles, occupation salary guides, state breakdowns, denial-rate trends.',
  alternates: { canonical: '/' },
};

const browseLinks = [
  { href: '/employer',   label: 'Sponsors',    icon: Building2, desc: 'Per-employer H-1B profiles' },
  { href: '/occupation', label: 'Occupations', icon: Briefcase, desc: 'Salary guides by SOC' },
  { href: '/state',      label: 'States',      icon: MapPin,    desc: 'Filings by worksite state' },
  { href: '/sector',     label: 'Sectors',     icon: Factory,   desc: 'NAICS industry breakdown' },
  { href: '/rankings',   label: 'Rankings',    icon: Trophy,    desc: '"Best of" leaderboards' },
];

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Top-8 sectors + a bucketed "Other" slice for the donut. */
function buildDonut(rows: Array<{ label: string; filings: number }>): { donut: DonutSlice[]; donutTotal: number } {
  const donutTotal = rows.reduce((s, x) => s + x.filings, 0);
  const top = rows.slice(0, 8).map((s) => ({ label: s.label, value: s.filings }));
  const rest = rows.slice(8);
  const donut: DonutSlice[] = rest.length > 0
    ? [...top, { label: 'Other sectors', value: rest.reduce((s, x) => s + x.filings, 0), color: 'hsl(220 14% 78%)' }]
    : top;
  return { donut, donutTotal };
}

export default function HomePage() {
  const kpis = getSiteKpis();
  const summary = getEntitySummary('site', 'home');
  const siteYearly = getSiteYearly();
  const years = siteYearly.map((y) => y.year);
  const lastYear = years.length ? Math.max(...years) : kpis.last_year;

  // ----- all-time (current) lists -----
  const wageRank       = listHighestPayingOccupations(8);
  const topSectorsAll  = listTopSectors(30);
  const topStatesAll   = listTopStates(12);
  const topEmployers   = listTopEmployers(10);
  const topOccupations = listTopOccupations(10);

  // ----- per-year flat arrays → grouped by year -----
  const group = <T extends { year: number }>(rows: T[]): Record<number, T[]> => {
    const m: Record<number, T[]> = {};
    for (const r of rows) (m[r.year] ??= []).push(r);
    return m;
  };
  const payByYear = group(getHomeTopPayingByYear());
  const secByYear = group(getHomeSectorsByYear());
  const stByYear  = group(getHomeTopStatesByYear(12));
  const empByYear = group(getHomeTopEmployersByYear(10));
  const occByYear = group(getHomeTopOccupationsByYear(10));

  // ----- KPI bundles -----
  const kpiByYear: Record<number, HomeKpiBundle> = {};
  for (const y of siteYearly) {
    kpiByYear[y.year] = { disclosures: y.filings, sponsors: y.sponsors, socs: y.socs, median_wage: y.median_wage };
  }
  const kpiBundles: Scoped<HomeKpiBundle> = {
    all: { disclosures: kpis.total_records, sponsors: kpis.canonical_employers, socs: kpis.distinct_socs, median_wage: kpis.median_wage },
    byYear: kpiByYear,
  };

  // ----- chart bundles -----
  const allDonut = buildDonut(topSectorsAll.map((s) => ({ label: s.label, filings: s.filings })));
  const chartByYear: Record<number, HomeChartBundle> = {};
  for (const yr of years) {
    const d = buildDonut((secByYear[yr] ?? []).map((s) => ({ label: s.label, filings: s.filings })));
    chartByYear[yr] = {
      wage: (payByYear[yr] ?? []).map((p) => ({ label: trunc(p.soc_title ?? p.soc_code, 32), value: p.p50_wage ?? 0 })),
      donut: d.donut,
      donutTotal: d.donutTotal,
      states: (stByYear[yr] ?? []).map((s) => ({ label: s.name, value: s.filings, hint: s.code })),
    };
  }
  const chartBundles: Scoped<HomeChartBundle> = {
    all: {
      wage: wageRank.map((o) => ({ label: trunc(o.soc_title ?? o.soc_code, 32), value: o.p50_wage ?? 0 })),
      donut: allDonut.donut,
      donutTotal: allDonut.donutTotal,
      states: topStatesAll.map((s) => ({ label: s.name, value: s.filings, hint: s.code })),
    },
    byYear: chartByYear,
  };

  // ----- table bundles -----
  const tableByYear: Record<number, HomeTableBundle> = {};
  for (const yr of years) {
    tableByYear[yr] = {
      employers: (empByYear[yr] ?? []).map((e) => ({ slug: e.slug, canonical_name: e.canonical_name, filings: e.filings })),
      occupations: (occByYear[yr] ?? []).map((o) => ({ slug: o.slug, soc_code: o.soc_code, soc_title: o.soc_title, filings: o.filings })),
    };
  }
  const tableBundles: Scoped<HomeTableBundle> = {
    all: {
      employers: topEmployers.map((e) => ({ slug: e.slug, canonical_name: e.canonical_name, filings: e.filings })),
      occupations: topOccupations.map((o) => ({ slug: o.slug, soc_code: o.soc_code, soc_title: o.soc_title, filings: o.filings })),
    },
    byYear: tableByYear,
  };

  return (
    <>
      {/* ----- Hero (all-time framing) ----------------------------------- */}
      <section className="space-y-5 pb-10 pt-4">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <Sparkles className="size-3" />
          FY{kpis.first_year}–FY{kpis.last_year} · {fmt(kpis.total_records)} disclosures
        </Badge>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight max-w-4xl leading-[1.05]">
          US H-1B &amp; LCA data,{' '}
          <span className="bg-gradient-to-r from-primary to-cyan-500 bg-clip-text text-transparent">
            made readable.
          </span>
        </h1>
        <p className="text-muted-foreground text-lg max-w-2xl">
          Every H-1B Labor Condition Application is publicly disclosed by the
          US Department of Labor. {SITE_NAME} cleans up the inconsistent
          employer spellings, free-text job titles, and mixed pay units into a
          queryable surface — so &ldquo;Cognizant&rdquo; means the same thing
          across {fmt(kpis.total_records)} records.
        </p>
        <div className="flex flex-wrap gap-3 pt-3">
          <Button asChild size="lg" className="rounded-full px-6">
            <Link href="/rankings">Browse rankings <ArrowRight className="size-4" /></Link>
          </Button>
          {FEATURES.api ? (
            <Button asChild size="lg" variant="outline" className="rounded-full px-6">
              <Link href="/api/docs">Data API</Link>
            </Button>
          ) : null}
        </div>
      </section>

      {/* ----- Year-aware dashboard (2025 default; pick a year / all years) - */}
      <HomeYearProvider years={years} defaultYear={lastYear}>
       <div className="md:flex md:gap-6">
        {/* Desktop: sticky left year rail that follows the scroll */}
        <div className="hidden shrink-0 md:block">
          <div className="sticky top-20">
            <YearNav orientation="vertical" />
          </div>
        </div>

        {/* Main dashboard column */}
        <div className="min-w-0 flex-1">
        {/* Mobile: sticky top year bar (under the header) */}
        <div className="sticky top-14 z-30 -mx-4 mb-3 border-b bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/75 md:hidden">
          <YearNav orientation="horizontal" />
        </div>

        <section className="pt-2 pb-12 md:pt-0">
          <HomeKpiStrip bundles={kpiBundles} firstYear={kpis.first_year} lastYear={kpis.last_year} />
        </section>

        <Summary summary={summary} />

        <AdSlot name="home-top" />

        <HomeCharts bundles={chartBundles} />

        {/* ----- Browse rail (static) ----- */}
        <section className="space-y-4 pt-12 pb-4">
          <div className="flex items-end justify-between gap-4">
            <h2 className="text-2xl font-semibold tracking-tight">Browse the dataset</h2>
            <p className="text-sm text-muted-foreground hidden md:block">
              Five lenses on the same FY{kpis.first_year}–FY{kpis.last_year} corpus.
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {browseLinks.map((b) => {
              const Icon = b.icon;
              return (
                <Link key={b.href} href={b.href} className="group">
                  <Card className="h-full transition-all hover:border-primary/30 hover:shadow-md hover:-translate-y-0.5">
                    <CardContent className="p-4 flex flex-col gap-2">
                      <div className="size-9 rounded-md bg-secondary flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                        <Icon className="size-4" />
                      </div>
                      <div className="font-medium text-sm">{b.label}</div>
                      <div className="text-xs text-muted-foreground">{b.desc}</div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>

        <AdSlot name="home-mid" />

        <HomeTopTables bundles={tableBundles} />
        </div>
       </div>
      </HomeYearProvider>

      <AdSlot name="home-bottom" />

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([
            websiteJsonLd(SITE_URL),
            datasetJsonLd(
              SITE_URL,
              `Normalised US Department of Labor H-1B Labor Condition Application disclosures, FY${kpis.first_year}–FY${kpis.last_year}. ${Number(kpis.total_records).toLocaleString()} records covering ${Number(kpis.canonical_employers).toLocaleString()} canonical employers and ${Number(kpis.distinct_socs).toLocaleString()} SOC occupations.`,
            ),
          ]),
        }}
      />
    </>
  );
}
