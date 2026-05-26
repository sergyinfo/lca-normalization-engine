import type { Metadata } from 'next';
import { entityMetadata } from '@/lib/seo';
import { listTopEmployers, getSiteKpis } from '@/lib/queries';
import { fmt, fmtPct } from '@/lib/format';
import { RankingPage, filingsCellWithBar } from '@/components/RankingPage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { HorizontalBarSvg } from '@/components/charts/HorizontalBarSvg';
import { HistogramSvg } from '@/components/charts/HistogramSvg';

export function generateMetadata(): Metadata {
  const kpis = getSiteKpis();
  return entityMetadata({
    title: `Top 100 H-1B Sponsors FY${kpis.last_year}`,
    description: `The 100 US employers that filed the most H-1B Labor Condition Applications. Updated each quarter from the latest DOL disclosures (FY${kpis.first_year}–FY${kpis.last_year}).`,
    path: '/top-h1b-sponsors',
  });
}

export default function TopH1bSponsors() {
  const kpis = getSiteKpis();
  const employers = listTopEmployers(100);
  const maxFilings = employers.reduce((m, e) => Math.max(m, e.filings), 0);
  const top10 = employers.slice(0, 10).map((e) => ({
    label: e.canonical_name,
    value: e.filings,
    hint: e.employer_state ?? undefined,
  }));
  const allFilings = employers.map((e) => e.filings);
  return (
    <RankingPage
      eyebrow="Sponsor leaderboard"
      title="Top 100 H-1B Sponsors"
      fiscalYear={kpis.last_year}
      adSlotName="ranking-top-sponsors"
      back={{ href: '/rankings', label: 'All rankings' }}
      intro={
        <>The 100 US employers that have filed the most H-1B Labor Condition
        Applications since FY{kpis.first_year}. Counts are aggregated across
        the canonical employer record — duplicate spellings of the same legal
        entity already merged.</>
      }
      preTableVisual={
        <div className="grid lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Top 10 at a glance</CardTitle>
              <CardDescription>
                The biggest sponsors absorb a disproportionate share of the program.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <HorizontalBarSvg
                data={top10}
                labelWidth={200}
                gradient={['hsl(217 91% 55%)', 'hsl(190 95% 50%)']}
              />
            </CardContent>
          </Card>
          <Card className="flex flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Distribution</CardTitle>
              <CardDescription>
                How filing volume spreads across the top 100.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col">
              <div className="flex-1 flex flex-col">
                <HistogramSvg values={allFilings} />
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                #1 sponsor files {fmt(Math.round(maxFilings / employers[employers.length - 1]!.filings))}× more
                than #{employers.length}.
              </p>
            </CardContent>
          </Card>
        </div>
      }
      rows={employers.map((e) => ({
        rank: e.rank!,  // listTopEmployers filters rank IS NOT NULL
        href: `/employer/${e.slug}`,
        primary: e.canonical_name,
        cells: [
          { label: 'State', value: e.employer_state ?? '—', sortKey: 'state', sortType: 'string', sortValue: e.employer_state ?? '' },
          filingsCellWithBar(e.filings, maxFilings),
          { label: 'Certified %', value: fmtPct(e.certified_pct, 1), numeric: true, sortKey: 'cert',   sortType: 'number', sortValue: e.certified_pct },
          { label: 'Denied %',    value: fmtPct(e.denied_pct, 2),    numeric: true, sortKey: 'denied', sortType: 'number', sortValue: e.denied_pct },
        ],
      }))}
      methodology={
        <>Ranking is by raw filing volume. One LCA = one Labor Condition
        Application, which covers a worksite/role combination — so the count
        approximates <em>demand</em>, not the count of distinct H-1B
        employees on staff. Denial % is the fraction of disclosures that DOL
        returned with status <code>Denied</code>. Certified % includes only
        the unconditional <code>Certified</code> disposition (excludes
        cert-withdrawn).</>
      }
    />
  );
}
