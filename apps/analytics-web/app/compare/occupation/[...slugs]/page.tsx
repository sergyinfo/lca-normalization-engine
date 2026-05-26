import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, GitCompare, ArrowRight } from 'lucide-react';

import {
  getOccupationBySlug, getOccupationTopStates, getOccupationTopEmployers,
  getOccupationYearly, listTopOccupations,
} from '@/lib/queries';
import { CompareSwapper } from '@/components/CompareSwapper';
import type { PeerOption } from '@/components/ComparePicker';
import { fmt, fmtUsd } from '@/lib/format';
import { entityMetadata } from '@/lib/seo';
import { SITE_NAME } from '@/lib/site';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LineChartClient } from '@/components/charts/LineChartClient';
import { PageMinimap } from '@/components/PageMinimap';

export const dynamicParams = true;

export function generateStaticParams() {
  const top = listTopOccupations(10);
  const out: Array<{ slugs: string[] }> = [];
  for (const a of top) for (const b of top) {
    if (a.slug !== b.slug) out.push({ slugs: [a.slug, b.slug] });
  }
  return out;
}

export async function generateMetadata(
  { params }: { params: Promise<{ slugs: string[] }> },
): Promise<Metadata> {
  const { slugs } = await params;
  const [aSlug, bSlug] = slugs;
  if (!aSlug || !bSlug) return { title: 'Compare occupations' };
  const a = getOccupationBySlug(aSlug);
  const b = getOccupationBySlug(bSlug);
  if (!a || !b) return { title: 'Not found' };
  const aT = a.soc_title ?? a.soc_code;
  const bT = b.soc_title ?? b.soc_code;
  // Canonical points at the sorted pair so /A/B and /B/A fold together.
  const [c0, c1] = [aSlug, bSlug].sort() as [string, string];
  return entityMetadata({
    title: `${aT} vs ${bT} — H-1B Salary Comparison`,
    description: `Median H-1B prevailing wage and demand: ${aT} (${fmtUsd(a.p50_wage)}) vs ${bT} (${fmtUsd(b.p50_wage)}). P25/P75, top states, top employers, yearly wage trend.`,
    path: `/compare/occupation/${c0}/${c1}`,
  });
}

export default async function CompareOccupationsPage(
  { params }: { params: Promise<{ slugs: string[] }> },
) {
  const { slugs } = await params;
  if (slugs.length !== 2) notFound();
  const [aSlug, bSlug] = slugs as [string, string];
  const a = getOccupationBySlug(aSlug);
  const b = getOccupationBySlug(bSlug);
  if (!a || !b) notFound();

  const aStates = getOccupationTopStates(a.soc_code).slice(0, 5);
  const bStates = getOccupationTopStates(b.soc_code).slice(0, 5);
  const aEmps   = getOccupationTopEmployers(a.soc_code).slice(0, 5);
  const bEmps   = getOccupationTopEmployers(b.soc_code).slice(0, 5);
  const aYearly = getOccupationYearly(a.soc_code);
  const bYearly = getOccupationYearly(b.soc_code);

  const entities = [a, b];
  const aTitle = a.soc_title ?? a.soc_code;
  const bTitle = b.soc_title ?? b.soc_code;

  return (
    <>
      <nav aria-label="Breadcrumb" className="pb-2">
        <Link href={`/occupation/${aSlug}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="size-3.5" /> Back to {aTitle}
        </Link>
      </nav>

      <section className="space-y-4 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <GitCompare className="size-3" /> Salary comparison
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight max-w-4xl">
          {aTitle} <span className="text-muted-foreground">vs</span> {bTitle}
        </h1>
        <p className="text-muted-foreground max-w-3xl">
          Side-by-side H-1B prevailing-wage comparison using the same DOL LCA
          data that drives every page on {SITE_NAME}. Quartiles, hiring
          geography, top sponsors and yearly wage drift.
        </p>
      </section>

      <PageMinimap />

      <div
        className="grid md:grid-cols-2 gap-4 pb-6"
        data-section-id="entities"
        data-section-label="Entities"
      >
        {entities.map((e, i) => (
          <Card key={e.slug} className={i === 0 ? 'border-primary/30' : 'border-violet-300/40'}>
            <CardContent className="p-5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                {i === 0 ? 'Occupation A' : 'Occupation B'}
              </div>
              <Link href={`/occupation/${e.slug}`} className="text-lg font-bold tracking-tight hover:text-primary">
                {e.soc_title ?? e.soc_code}
              </Link>
              <div className="flex flex-wrap gap-2 mt-3 text-xs">
                <Badge variant="outline">SOC {e.soc_code}</Badge>
                <Badge variant="secondary">Rank #{e.rank}</Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card
        className="mb-6"
        data-section-id="metrics"
        data-section-label="Key metrics"
      >
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Key metrics</CardTitle>
          <CardDescription>Wage figures are offered annual wage; volume is total LCA count.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <table className="w-full text-sm">
            <thead className="border-t border-b bg-muted/30">
              <tr>
                <th className="text-left p-3 font-medium text-muted-foreground w-1/3">Metric</th>
                <th className="text-right p-3 font-medium">{aTitle}</th>
                <th className="text-right p-3 font-medium">{bTitle}</th>
              </tr>
            </thead>
            <tbody className="[&_tr]:border-b last:[&_tr]:border-b-0">
              <Row label="Median wage" a={fmtUsd(a.p50_wage)} b={fmtUsd(b.p50_wage)}
                   winner={pickHigh(a.p50_wage, b.p50_wage)} />
              <Row label="P25 wage" a={fmtUsd(a.p25_wage)} b={fmtUsd(b.p25_wage)}
                   winner={pickHigh(a.p25_wage, b.p25_wage)} />
              <Row label="P75 wage" a={fmtUsd(a.p75_wage)} b={fmtUsd(b.p75_wage)}
                   winner={pickHigh(a.p75_wage, b.p75_wage)} />
              <Row label="Wage spread (P75 − P25)"
                   a={fmtUsd((a.p75_wage ?? 0) - (a.p25_wage ?? 0))}
                   b={fmtUsd((b.p75_wage ?? 0) - (b.p25_wage ?? 0))}
                   winner={null} />
              <Row label="Total filings" a={fmt(a.filings)} b={fmt(b.filings)}
                   winner={a.filings > b.filings ? 'a' : a.filings < b.filings ? 'b' : null} />
              <Row label="Wage samples" a={fmt(a.n_wages)} b={fmt(b.n_wages)} winner={null} />
              <Row label="Rank" a={`#${a.rank}`} b={`#${b.rank}`}
                   winner={a.rank < b.rank ? 'a' : a.rank > b.rank ? 'b' : null} />
            </tbody>
          </table>
        </CardContent>
      </Card>

      {(aYearly.length > 0 || bYearly.length > 0) ? (
        <Card
          className="mb-6"
          data-section-id="yearly"
          data-section-label="Yearly wage"
        >
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Median wage by year</CardTitle>
            <CardDescription>Year-over-year drift of the typical offered wage.</CardDescription>
          </CardHeader>
          <CardContent>
            <YearlyWageOverlay
              a={{ name: aTitle, points: aYearly }}
              b={{ name: bTitle, points: bYearly }}
            />
          </CardContent>
        </Card>
      ) : null}

      <div
        className="grid md:grid-cols-2 gap-4 mb-6"
        data-section-id="top-states"
        data-section-label="Top states"
      >
        {[{ ent: a, title: aTitle, states: aStates }, { ent: b, title: bTitle, states: bStates }].map(({ ent, title, states }) => (
          <Card key={ent.slug}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base truncate">Top 5 hiring states — {title}</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              {states.length > 0 ? (
                <ul className="divide-y">
                  {states.map((s, i) => (
                    <li key={s.state} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                      <span className="text-muted-foreground tabular-nums w-5">{i + 1}</span>
                      <span className="flex-1">
                        {s.state_slug ? (
                          <Link href={`/state/${s.state_slug}`} className="hover:text-primary font-medium">{s.state}</Link>
                        ) : <span className="font-medium">{s.state}</span>}
                      </span>
                      <span className="tabular-nums text-muted-foreground">{fmt(s.filings)}</span>
                      <span className="tabular-nums font-medium w-16 text-right">{fmtUsd(s.p50_wage)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground px-5 pb-5">No state breakdown.</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div
        className="grid md:grid-cols-2 gap-4 mb-6"
        data-section-id="top-sponsors"
        data-section-label="Top sponsors"
      >
        {[{ ent: a, title: aTitle, emps: aEmps }, { ent: b, title: bTitle, emps: bEmps }].map(({ ent, title, emps }) => (
          <Card key={ent.slug}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base truncate">Top 5 sponsors — {title}</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              {emps.length > 0 ? (
                <ul className="divide-y">
                  {emps.map((e, i) => (
                    <li key={e.employer_slug} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                      <span className="text-muted-foreground tabular-nums w-5">{i + 1}</span>
                      <span className="flex-1 truncate">
                        <Link href={`/employer/${e.employer_slug}`} className="hover:text-primary font-medium">{e.canonical_name}</Link>
                      </span>
                      <span className="tabular-nums font-medium">{fmt(e.filings)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground px-5 pb-5">No sponsor breakdown.</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div data-section-id="swap" data-section-label="Swap entities">
      <CompareSwapper
        kind="occupation"
        current={{
          left:  { slug: aSlug, label: aTitle },
          right: { slug: bSlug, label: bTitle },
        }}
        peers={listTopOccupations(30)
          .filter((p) => p.slug !== aSlug && p.slug !== bSlug)
          .map<PeerOption>((p) => ({
            slug: p.slug,
            label: p.soc_title ?? p.soc_code,
            hint: p.soc_code,
          }))}
      />
      </div>

      <Card className="mt-4 bg-muted/20">
        <CardContent className="p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground">Or browse the full occupation index.</div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm"><Link href={`/occupation/${aSlug}`}>{aTitle}</Link></Button>
            <Button asChild variant="outline" size="sm"><Link href={`/occupation/${bSlug}`}>{bTitle}</Link></Button>
            <Button asChild size="sm"><Link href="/occupation">Browse all <ArrowRight className="size-3" /></Link></Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function Row({ label, a, b, winner }: { label: string; a: string; b: string; winner: 'a' | 'b' | null }) {
  return (
    <tr>
      <td className="p-3 text-muted-foreground">{label}</td>
      <td className={`p-3 text-right tabular-nums ${winner === 'a' ? 'font-bold text-primary' : ''}`}>
        {a}{winner === 'a' ? <span className="ml-1.5 text-[10px] text-primary">▲</span> : null}
      </td>
      <td className={`p-3 text-right tabular-nums ${winner === 'b' ? 'font-bold text-primary' : ''}`}>
        {b}{winner === 'b' ? <span className="ml-1.5 text-[10px] text-primary">▲</span> : null}
      </td>
    </tr>
  );
}

function pickHigh(av: number | null, bv: number | null): 'a' | 'b' | null {
  if (av == null || bv == null) return null;
  if (av > bv) return 'a';
  if (bv > av) return 'b';
  return null;
}

function YearlyWageOverlay({
  a, b,
}: {
  a: { name: string; points: Array<{ year: number; median_wage: number | null }> };
  b: { name: string; points: Array<{ year: number; median_wage: number | null }> };
}) {
  const years = Array.from(new Set([...a.points.map((p) => p.year), ...b.points.map((p) => p.year)])).sort();
  const aIdx = new Map(a.points.map((p) => [p.year, p.median_wage ?? 0]));
  const bIdx = new Map(b.points.map((p) => [p.year, p.median_wage ?? 0]));
  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div>
        <div className="flex items-center gap-2 text-sm mb-2">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: 'hsl(217 91% 55%)' }} />
          <span className="truncate font-medium">{a.name}</span>
        </div>
        <LineChartClient
          data={years.map((y) => ({ label: `FY${y}`, value: aIdx.get(y) ?? 0 }))}
          color="hsl(217 91% 55%)"
          valueFormat="usd-short"
          height={200}
        />
      </div>
      <div>
        <div className="flex items-center gap-2 text-sm mb-2">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: 'hsl(262 83% 62%)' }} />
          <span className="truncate font-medium">{b.name}</span>
        </div>
        <LineChartClient
          data={years.map((y) => ({ label: `FY${y}`, value: bIdx.get(y) ?? 0 }))}
          color="hsl(262 83% 62%)"
          valueFormat="usd-short"
          height={200}
        />
      </div>
    </div>
  );
}
