import type { Metadata } from 'next';
import { entityMetadata } from '@/lib/seo';
import { listTopOccupations, getSiteKpis } from '@/lib/queries';
import { fmtUsd } from '@/lib/format';
import { RankingPage, filingsCellWithBar } from '@/components/RankingPage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { HorizontalBarSvg } from '@/components/charts/HorizontalBarSvg';
import { HistogramSvg } from '@/components/charts/HistogramSvg';

export function generateMetadata(): Metadata {
  const kpis = getSiteKpis();
  return entityMetadata({
    title: `Top H-1B Occupations FY${kpis.last_year}`,
    description: `Most-sponsored SOC occupations in the US H-1B program. Filing volume + median wage at a glance, FY${kpis.first_year}–FY${kpis.last_year}.`,
    path: '/top-h1b-occupations',
  });
}

export default function TopH1bOccupations() {
  const kpis = getSiteKpis();
  const occs = listTopOccupations(100);
  const maxFilings = occs.reduce((m, o) => Math.max(m, o.filings), 0);
  const top10 = occs.slice(0, 10).map((o) => ({
    label: o.soc_title ?? o.soc_code,
    value: o.filings,
    hint: o.soc_code,
  }));
  return (
    <RankingPage
      eyebrow="Occupation leaderboard"
      title="Top H-1B Occupations"
      fiscalYear={kpis.last_year}
      adSlotName="ranking-top-occupations"
      back={{ href: '/rankings', label: 'All rankings' }}
      intro={
        <>SOC occupations ranked by H-1B filing volume across
        FY{kpis.first_year}–FY{kpis.last_year}. The list is dominated by
        tech roles (15-xxxx series) and engineering occupations (17-xxxx).</>
      }
      preTableVisual={
        <div className="grid lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Top 10 at a glance</CardTitle>
              <CardDescription>
                Computer Occupations and Software Developers dwarf the rest of the list.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <HorizontalBarSvg
                data={top10}
                labelWidth={200}
                gradient={['hsl(262 83% 62%)', 'hsl(330 81% 60%)']}
              />
            </CardContent>
          </Card>
          <Card className="flex flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Distribution</CardTitle>
              <CardDescription>
                Long-tail spread across {occs.length} SOC codes.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col">
              <HistogramSvg
                values={occs.map((o) => o.filings)}
                gradient={['hsl(262 83% 62%)', 'hsl(330 81% 60%)']}
              />
            </CardContent>
          </Card>
        </div>
      }
      rows={occs.map((o) => ({
        rank: o.rank,
        href: `/occupation/${o.slug}`,
        primary: o.soc_title ?? o.soc_code,
        cells: [
          { label: 'SOC', value: o.soc_code },
          filingsCellWithBar(o.filings, maxFilings),
          { label: 'Median wage', value: fmtUsd(o.p50_wage), numeric: true },
        ],
      }))}
      methodology={
        <>Sourced from the SOC classifier&rsquo;s output on each LCA disclosure.
        Records that failed automated classification (about 4.7% of the
        corpus) are excluded from this ranking. Median wage is computed
        across all certified and pending filings for the SOC, with
        out-of-band values (&lt; $20k, &gt; $1M) clipped.</>
      }
    />
  );
}
