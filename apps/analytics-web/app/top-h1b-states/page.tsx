import type { Metadata } from 'next';
import { entityMetadata } from '@/lib/seo';
import { listTopStates, getSiteKpis, getEntitySummary } from '@/lib/queries';
import { fmt } from '@/lib/format';
import { RankingPage, filingsCellWithBar } from '@/components/RankingPage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { HorizontalBarSvg } from '@/components/charts/HorizontalBarSvg';

export function generateMetadata(): Metadata {
  const kpis = getSiteKpis();
  return entityMetadata({
    title: `Top H-1B States FY${kpis.last_year}`,
    description: `US states ranked by H-1B Labor Condition Application worksite volume. The geography of who actually employs H-1B workers.`,
    path: '/top-h1b-states',
  });
}

export default function TopH1bStates() {
  const kpis = getSiteKpis();
  const states = listTopStates(60);
  const maxFilings = states.reduce((m, s) => Math.max(m, s.filings), 0);
  const totalFilings = states.reduce((s, st) => s + st.filings, 0);
  const top15 = states.slice(0, 15).map((s) => ({
    label: s.name,
    value: s.filings,
    hint: s.code,
  }));
  return (
    <RankingPage
      summary={getEntitySummary('ranking', 'top-h1b-states')}
      eyebrow="State leaderboard"
      title="Top H-1B States"
      fiscalYear={kpis.last_year}
      adSlotName="ranking-top-states"
      back={{ href: '/rankings', label: 'All rankings' }}
      intro={
        <>US states ranked by worksite-state filing volume. The ranking
        reflects where H-1B workers <em>actually work</em>, not where the
        sponsoring employer is incorporated. Top 3 states alone absorb{' '}
        {fmt(Math.round(((states[0]!.filings + states[1]!.filings + states[2]!.filings) / totalFilings) * 100))}%
        of the program.</>
      }
      preTableVisual={
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Top 15 states</CardTitle>
            <CardDescription>
              Geographic concentration of US H-1B filings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <HorizontalBarSvg
              data={top15}
              labelWidth={140}
              rowHeight={24}
              gradient={['hsl(217 91% 55%)', 'hsl(190 95% 50%)']}
            />
          </CardContent>
        </Card>
      }
      rows={states.map((s) => ({
        rank: s.rank,
        href: `/state/${s.slug}`,
        primary: `${s.name} (${s.code})`,
        cells: [filingsCellWithBar(s.filings, maxFilings)],
      }))}
      methodology={
        <>Counted on the <code>WORKSITE_STATE</code> field of each LCA, not
        the employer&rsquo;s headquarters. Filings without a 2-letter state
        code (out-of-format entries) are excluded.</>
      }
    />
  );
}
