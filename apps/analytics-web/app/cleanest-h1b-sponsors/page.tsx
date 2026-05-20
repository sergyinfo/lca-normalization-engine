import type { Metadata } from 'next';
import { entityMetadata } from '@/lib/seo';
import { listCleanestEmployers, getSiteKpis } from '@/lib/queries';
import { fmt, fmtPct } from '@/lib/format';
import { RankingPage } from '@/components/RankingPage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { HorizontalBarSvg } from '@/components/charts/HorizontalBarSvg';

export function generateMetadata(): Metadata {
  const kpis = getSiteKpis();
  return entityMetadata({
    title: `Cleanest H-1B Sponsors FY${kpis.last_year}`,
    description: `Large H-1B sponsors with the highest certification rate. A "good-sponsor" leaderboard built from real DOL outcome data, not marketing copy.`,
    path: '/cleanest-h1b-sponsors',
  });
}

export default function CleanestH1bSponsors() {
  const kpis = getSiteKpis();
  const employers = listCleanestEmployers(100, 500);
  const top10 = employers.slice(0, 10).map((e) => ({
    label: e.canonical_name,
    value: e.certified_pct ?? 0,
    hint: `${fmt(e.filings)} filings`,
  }));
  return (
    <RankingPage
      eyebrow="Sponsor leaderboard"
      title="Cleanest H-1B Sponsors"
      fiscalYear={kpis.last_year}
      adSlotName="ranking-cleanest"
      back={{ href: '/rankings', label: 'All rankings' }}
      intro={
        <>Sponsors with at least 500 filings, ranked by{' '}
        <strong>unconditional certification rate</strong>. A high cert %
        suggests the sponsor consistently submits well-formed applications
        for genuine roles — a useful signal for prospective hires
        researching potential employers.</>
      }
      preTableVisual={
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Top 10 cleanest sponsors</CardTitle>
            <CardDescription>
              Certification rate of large H-1B sponsors (≥500 filings).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <HorizontalBarSvg
              data={top10}
              labelWidth={220}
              valueFormat="pct"
              gradient={['hsl(160 84% 39%)', 'hsl(190 95% 50%)']}
            />
          </CardContent>
        </Card>
      }
      rows={employers.map((e, i) => ({
        rank: i + 1,
        href: `/employer/${e.slug}`,
        primary: e.canonical_name,
        cells: [
          { label: 'State',       value: e.employer_state ?? '—',     sortKey: 'state',     sortType: 'string', sortValue: e.employer_state ?? '' },
          { label: 'Filings',     value: fmt(e.filings),               numeric: true, sortKey: 'filings',   sortType: 'number', sortValue: e.filings },
          { label: 'Certified %', value: fmtPct(e.certified_pct, 2),   numeric: true, sortKey: 'cert',      sortType: 'number', sortValue: e.certified_pct },
          { label: 'Withdrawn %', value: fmtPct(e.withdrawn_pct, 2),   numeric: true, sortKey: 'withdrawn', sortType: 'number', sortValue: e.withdrawn_pct },
          { label: 'Denied %',    value: fmtPct(e.denied_pct, 2),      numeric: true, sortKey: 'denied',    sortType: 'number', sortValue: e.denied_pct },
        ],
      }))}
      methodology={
        <>Certification % is filings with DOL status <code>Certified</code>{' '}
        divided by total filings for the sponsor. The 500-filing floor is a
        sample-size guard against employers with a single perfect filing
        topping the list. Cert-withdrawn and withdrawn dispositions are not
        counted as certifications, even though they were initially approved.</>
      }
    />
  );
}
