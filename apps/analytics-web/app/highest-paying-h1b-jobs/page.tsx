import type { Metadata } from 'next';
import { entityMetadata } from '@/lib/seo';
import { listHighestPayingOccupations, getSiteKpis } from '@/lib/queries';
import { fmtUsd, fmt } from '@/lib/format';
import { RankingPage } from '@/components/RankingPage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { HorizontalBarSvg } from '@/components/charts/HorizontalBarSvg';
import { HistogramSvg } from '@/components/charts/HistogramSvg';

export function generateMetadata(): Metadata {
  const kpis = getSiteKpis();
  return entityMetadata({
    title: `Highest-Paying H-1B Jobs FY${kpis.last_year}`,
    description: `H-1B-sponsored occupations ranked by median annual prevailing wage. Updated quarterly from US DOL Labor Condition Applications.`,
    path: '/highest-paying-h1b-jobs',
  });
}

export default function HighestPayingH1bJobs() {
  const kpis = getSiteKpis();
  const occs = listHighestPayingOccupations(100);
  const top10 = occs.slice(0, 10).map((o) => ({
    label: o.soc_title ?? o.soc_code,
    value: o.p50_wage ?? 0,
    hint: o.soc_code,
  }));
  const wageValues = occs.map((o) => o.p50_wage ?? 0).filter((v) => v > 0);
  return (
    <RankingPage
      eyebrow="Salary leaderboard"
      title="Highest-Paying H-1B Jobs"
      fiscalYear={kpis.last_year}
      adSlotName="ranking-top-paying"
      back={{ href: '/rankings', label: 'All rankings' }}
      intro={
        <>SOC occupations ranked by <strong>median annual prevailing wage</strong>{' '}
        across all H-1B Labor Condition Applications. Different from the
        &ldquo;top occupations by volume&rdquo; list — high-volume roles
        (Software Developer) often sit mid-pack on wages; specialised
        medical and finance roles dominate the top.</>
      }
      preTableVisual={
        <div className="grid lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Top 10 by median wage</CardTitle>
              <CardDescription>
                The wage ceiling of the H-1B program — specialised medical,
                legal and management roles.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <HorizontalBarSvg
                data={top10}
                labelWidth={220}
                valueFormat="usd-short"
                gradient={['hsl(160 84% 39%)', 'hsl(38 92% 50%)']}
              />
            </CardContent>
          </Card>
          <Card className="flex flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Wage distribution</CardTitle>
              <CardDescription>
                Spread of median wages across the top {occs.length} occupations.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col">
              <HistogramSvg
                values={wageValues}
                gradient={['hsl(160 84% 39%)', 'hsl(38 92% 50%)']}
                valueFormat="usd-short"
              />
            </CardContent>
          </Card>
        </div>
      }
      rows={occs.map((o, i) => ({
        rank: i + 1,
        href: `/occupation/${o.slug}`,
        primary: o.soc_title ?? o.soc_code,
        cells: [
          { label: 'SOC',         value: o.soc_code },
          { label: 'Median wage', value: fmtUsd(o.p50_wage), numeric: true },
          { label: 'P25 wage',    value: fmtUsd(o.p25_wage), numeric: true },
          { label: 'P75 wage',    value: fmtUsd(o.p75_wage), numeric: true },
          { label: 'Filings',     value: fmt(o.filings),     numeric: true },
        ],
      }))}
      methodology={
        <>Wage values are the offered annual wage, normalised from
        hour/week/month/year pay units. Outliers (&lt; $20k, &gt; $1M) clipped.
        SOCs without enough wage data to compute a stable median are excluded.</>
      }
    />
  );
}
