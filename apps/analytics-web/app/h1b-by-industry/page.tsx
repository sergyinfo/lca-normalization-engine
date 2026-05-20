import type { Metadata } from 'next';
import { entityMetadata } from '@/lib/seo';
import { listTopSectors, getSiteKpis } from '@/lib/queries';
import { fmt } from '@/lib/format';
import { RankingPage, filingsCellWithBar } from '@/components/RankingPage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { HorizontalBarSvg } from '@/components/charts/HorizontalBarSvg';

export function generateMetadata(): Metadata {
  const kpis = getSiteKpis();
  return entityMetadata({
    title: `H-1B by Industry (NAICS Sector) FY${kpis.last_year}`,
    description: `H-1B sponsorship volume by NAICS 2-digit industry sector. Where in the US economy the program concentrates.`,
    path: '/h1b-by-industry',
  });
}

export default function H1bByIndustry() {
  const kpis = getSiteKpis();
  const sectors = listTopSectors(40);
  const maxFilings = sectors.reduce((m, s) => Math.max(m, s.filings), 0);
  const top10 = sectors.slice(0, 10).map((s) => ({
    label: s.label,
    value: s.filings,
    hint: s.naics2,
  }));
  return (
    <RankingPage
      eyebrow="Industry leaderboard"
      title="H-1B by Industry (NAICS Sector)"
      fiscalYear={kpis.last_year}
      adSlotName="ranking-by-industry"
      back={{ href: '/rankings', label: 'All rankings' }}
      intro={
        <>NAICS 2-digit sectors ranked by H-1B Labor Condition Application
        volume. Sector 54 (Professional, Scientific &amp; Technical Services)
        dominates the program; the rest of the long tail covers everything
        from healthcare to academia.</>
      }
      preTableVisual={
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Top 10 industries</CardTitle>
            <CardDescription>
              Sector concentration of US H-1B sponsorship.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <HorizontalBarSvg
              data={top10}
              labelWidth={250}
              gradient={['hsl(38 92% 50%)', 'hsl(20 91% 55%)']}
            />
          </CardContent>
        </Card>
      }
      rows={sectors.map((s) => ({
        rank: s.rank,
        href: `/sector/${s.slug}`,
        primary: s.label,
        cells: [
          { label: 'NAICS',    value: s.naics2,        sortKey: 'naics',     sortType: 'string', sortValue: s.naics2 },
          filingsCellWithBar(s.filings, maxFilings),
          { label: 'Sponsors', value: fmt(s.employers), numeric: true, sortKey: 'employers', sortType: 'number', sortValue: s.employers },
        ],
      }))}
      methodology={
        <>The NAICS code on each LCA is the employer&rsquo;s self-reported
        industry. We aggregate to the 2-digit sector level for readability;
        per-employer pages preserve the full 6-digit code.</>
      }
    />
  );
}
