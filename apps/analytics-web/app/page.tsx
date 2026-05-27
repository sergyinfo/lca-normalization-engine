import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ArrowRight, Building2, Briefcase, MapPin, Factory, Trophy, Sparkles,
} from 'lucide-react';

import {
  getSiteKpis, listTopEmployers, listTopOccupations,
  listHighestPayingOccupations, listTopSectors, listTopStates,
} from '@/lib/queries';
import { fmt, fmtUsd } from '@/lib/format';
import { websiteJsonLd, datasetJsonLd } from '@/lib/seo';
import { SITE_URL, SITE_NAME } from '@/lib/site';
import { FEATURES } from '@/lib/features';
import { AdSlot } from '@/components/AdSlot';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HomeWageChartClient } from '@/components/charts/HomeWageChartClient';
import { DonutChartClient } from '@/components/charts/DonutChartClient';
import { HorizontalBarSvg } from '@/components/charts/HorizontalBarSvg';

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

export default function HomePage() {
  const kpis = getSiteKpis();
  const topEmployers   = listTopEmployers(10);
  const topOccupations = listTopOccupations(10);
  const wageRank       = listHighestPayingOccupations(8);
  const topSectorsAll  = listTopSectors(30);
  const topStatesAll   = listTopStates(12);

  const wageChartData = wageRank.map((o) => ({
    label: (o.soc_title ?? o.soc_code).length > 32
      ? (o.soc_title ?? o.soc_code).slice(0, 30) + '…'
      : (o.soc_title ?? o.soc_code),
    value: o.p50_wage ?? 0,
  }));

  // Donut: top 8 sectors + bucketed "Other".
  const sectorTotal = topSectorsAll.reduce((s, x) => s + x.filings, 0);
  const sectorTop = topSectorsAll.slice(0, 8);
  const sectorRest = topSectorsAll.slice(8);
  const sectorDonut = [
    ...sectorTop.map((s) => ({ label: s.label, value: s.filings })),
    ...(sectorRest.length > 0 ? [{
      label: 'Other sectors',
      value: sectorRest.reduce((sum, x) => sum + x.filings, 0),
      color: 'hsl(220 14% 78%)',
    }] : []),
  ];

  // State bar — show full names + state code in the hint.
  const stateBar = topStatesAll.map((s) => ({
    label: s.name,
    value: s.filings,
    hint: s.code,
  }));

  return (
    <>
      {/* ----- Hero ------------------------------------------------------- */}
      <section className="space-y-5 pb-12 pt-4">
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
            <Link href="/rankings">
              Browse rankings <ArrowRight className="size-4" />
            </Link>
          </Button>
          {FEATURES.api ? (
            <Button asChild size="lg" variant="outline" className="rounded-full px-6">
              <Link href="/api/docs">Data API</Link>
            </Button>
          ) : null}
        </div>
      </section>

      {/* ----- KPI strip -------------------------------------------------- */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 pb-12">
        <KpiTile label="Disclosures"        value={fmt(kpis.total_records)}        sub={`FY${kpis.first_year}–FY${kpis.last_year}`} />
        <KpiTile label="Canonical sponsors" value={fmt(kpis.canonical_employers)}  sub="dedup'd across spellings" />
        <KpiTile label="Occupations"        value={fmt(kpis.distinct_socs)}        sub="SOC codes covered" />
        <KpiTile label="Median wage"        value={fmtUsd(kpis.median_wage)}       sub="across all filings" accent />
      </section>

      <AdSlot name="home-top" />

      {/* ----- Wage chart ------------------------------------------------- */}
      <section className="pt-12">
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Highest-paying H-1B occupations</CardTitle>
              <CardDescription>
                Median annual prevailing wage across the top 8 SOCs by wage.
              </CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm" className="hidden md:inline-flex">
              <Link href="/highest-paying-h1b-jobs">
                Full ranking <ArrowRight className="size-3" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            <HomeWageChartClient data={wageChartData} />
          </CardContent>
        </Card>
      </section>

      {/* ----- Two-up: sector mix donut + state leaderboard --------------- */}
      <section className="grid lg:grid-cols-12 gap-6 pt-10">
        <Card className="lg:col-span-5">
          <CardHeader>
            <CardTitle>Industry mix</CardTitle>
            <CardDescription>
              Share of H-1B filings by NAICS 2-digit sector — where the
              program concentrates in the US economy.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DonutChartClient
              data={sectorDonut}
              size={220}
              centerLabel="filings"
              centerValue={fmt(sectorTotal)}
            />
          </CardContent>
        </Card>
        <Card className="lg:col-span-7">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Top hiring states</CardTitle>
              <CardDescription>
                Filings by worksite state — California and Texas alone absorb a
                massive share of the program.
              </CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm" className="hidden md:inline-flex">
              <Link href="/top-h1b-states">
                Full ranking <ArrowRight className="size-3" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            <HorizontalBarSvg
              data={stateBar}
              labelWidth={150}
              rowHeight={26}
              gradient={['hsl(217 91% 55%)', 'hsl(190 95% 50%)']}
            />
          </CardContent>
        </Card>
      </section>

      {/* ----- Browse rail ------------------------------------------------ */}
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

      {/* ----- Top tables ------------------------------------------------- */}
      <section className="grid md:grid-cols-2 gap-6 pt-8">
        <Card>
          <CardHeader>
            <CardTitle>Top H-1B sponsors</CardTitle>
            <CardDescription>Canonical employers by total filings</CardDescription>
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
                {topEmployers.map((e, i) => (
                  <TableRow key={e.slug}>
                    <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                    <TableCell>
                      <Link href={`/employer/${e.slug}`} className="font-medium hover:text-primary">
                        {e.canonical_name}
                      </Link>
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
            <CardDescription>SOC codes by total filings</CardDescription>
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
                {topOccupations.map((o, i) => (
                  <TableRow key={o.soc_code}>
                    <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link href={`/occupation/${o.slug}`} className="hover:text-primary">{o.soc_code}</Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/occupation/${o.slug}`} className="font-medium hover:text-primary">
                        {o.soc_title}
                      </Link>
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

function KpiTile({
  label, value, sub, accent = false,
}: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <Card className={accent ? 'border-primary/30 bg-secondary/50' : undefined}>
      <CardContent className="p-4 space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className={`text-3xl font-bold tabular-nums leading-none ${accent ? 'text-primary' : ''}`}>
          {value}
        </div>
        <div className="text-xs text-muted-foreground pt-1">{sub}</div>
      </CardContent>
    </Card>
  );
}
