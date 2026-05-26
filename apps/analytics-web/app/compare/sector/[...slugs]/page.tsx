import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, GitCompare, ArrowRight } from 'lucide-react';

import {
  getSectorBySlug, getSectorTopEmployers, getSectorTopOccupations,
  getSectorTopStates, getSectorYearly, listTopSectors, getSiteKpis,
} from '@/lib/queries';
import { CompareSwapper } from '@/components/CompareSwapper';
import type { PeerOption } from '@/components/ComparePicker';
import { fmt } from '@/lib/format';
import { entityMetadata } from '@/lib/seo';
import { SITE_NAME } from '@/lib/site';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LineChartClient } from '@/components/charts/LineChartClient';
import { PageMinimap } from '@/components/PageMinimap';

export const dynamicParams = true;

export function generateStaticParams() {
  const top = listTopSectors(10);
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
  if (!aSlug || !bSlug) return { title: 'Compare sectors' };
  const a = getSectorBySlug(aSlug);
  const b = getSectorBySlug(bSlug);
  if (!a || !b) return { title: 'Not found' };
  // Canonical points at the sorted pair so /A/B and /B/A fold together.
  const [c0, c1] = [aSlug, bSlug].sort() as [string, string];
  return entityMetadata({
    title: `${a.label} vs ${b.label} — H-1B Industry Comparison`,
    description: `Side-by-side H-1B sponsorship comparison: NAICS ${a.naics2} (${fmt(a.filings)} filings) vs NAICS ${b.naics2} (${fmt(b.filings)} filings). Top sponsors, top occupations.`,
    path: `/compare/sector/${c0}/${c1}`,
  });
}

export default async function CompareSectorsPage(
  { params }: { params: Promise<{ slugs: string[] }> },
) {
  const { slugs } = await params;
  if (slugs.length !== 2) notFound();
  const [aSlug, bSlug] = slugs as [string, string];
  const a = getSectorBySlug(aSlug);
  const b = getSectorBySlug(bSlug);
  if (!a || !b) notFound();

  const aEmps   = getSectorTopEmployers(a.naics2).slice(0, 5);
  const bEmps   = getSectorTopEmployers(b.naics2).slice(0, 5);
  const aSocs   = getSectorTopOccupations(a.naics2).slice(0, 5);
  const bSocs   = getSectorTopOccupations(b.naics2).slice(0, 5);
  const aStates = getSectorTopStates(a.naics2).slice(0, 5);
  const bStates = getSectorTopStates(b.naics2).slice(0, 5);
  const aYearly = getSectorYearly(a.naics2);
  const bYearly = getSectorYearly(b.naics2);
  const kpis    = getSiteKpis();
  const aShare  = kpis.total_records > 0 ? (a.filings / kpis.total_records) * 100 : 0;
  const bShare  = kpis.total_records > 0 ? (b.filings / kpis.total_records) * 100 : 0;

  const aPerEmp = a.employers > 0 ? Math.round(a.filings / a.employers) : 0;
  const bPerEmp = b.employers > 0 ? Math.round(b.filings / b.employers) : 0;

  const entities = [a, b];

  return (
    <>
      <nav aria-label="Breadcrumb" className="pb-2">
        <Link href={`/sector/${aSlug}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="size-3.5" /> Back to {a.label}
        </Link>
      </nav>

      <section className="space-y-4 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <GitCompare className="size-3" /> Industry comparison
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight max-w-4xl">
          {a.label} <span className="text-muted-foreground">vs</span> {b.label}
        </h1>
        <p className="text-muted-foreground max-w-3xl">
          NAICS-sector comparison built from the {SITE_NAME} corpus.
          Filing volume, distinct sponsor count, sponsor concentration and
          dominant occupations.
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
                {i === 0 ? 'Sector A' : 'Sector B'}
              </div>
              <Link href={`/sector/${e.slug}`} className="text-lg font-bold tracking-tight hover:text-primary">
                {e.label}
              </Link>
              <div className="flex flex-wrap gap-2 mt-3 text-xs">
                <Badge variant="outline">NAICS {e.naics2}</Badge>
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
          <CardDescription>Filings / employer is a concentration hint — higher means a few sponsors do most of the filing.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <table className="w-full text-sm">
            <thead className="border-t border-b bg-muted/30">
              <tr>
                <th className="text-left p-3 font-medium text-muted-foreground w-1/3">Metric</th>
                <th className="text-right p-3 font-medium">{a.label}</th>
                <th className="text-right p-3 font-medium">{b.label}</th>
              </tr>
            </thead>
            <tbody className="[&_tr]:border-b last:[&_tr]:border-b-0">
              <Row label="Total filings" a={fmt(a.filings)} b={fmt(b.filings)}
                   winner={a.filings > b.filings ? 'a' : a.filings < b.filings ? 'b' : null} />
              <Row label="National share %" a={`${aShare.toFixed(2)}%`} b={`${bShare.toFixed(2)}%`}
                   winner={aShare > bShare ? 'a' : bShare > aShare ? 'b' : null} />
              <Row label="Distinct sponsors" a={fmt(a.employers)} b={fmt(b.employers)}
                   winner={a.employers > b.employers ? 'a' : a.employers < b.employers ? 'b' : null} />
              <Row label="Filings / employer" a={fmt(aPerEmp)} b={fmt(bPerEmp)} winner={null} />
              <Row label="Rank" a={`#${a.rank}`} b={`#${b.rank}`}
                   winner={a.rank < b.rank ? 'a' : a.rank > b.rank ? 'b' : null} />
              <Row label="Top sponsor"
                   a={aEmps[0]?.canonical_name ?? '—'}
                   b={bEmps[0]?.canonical_name ?? '—'} winner={null} />
              <Row label="Top occupation"
                   a={aSocs[0]?.soc_title ?? '—'}
                   b={bSocs[0]?.soc_title ?? '—'} winner={null} />
            </tbody>
          </table>
        </CardContent>
      </Card>

      {(aYearly.length > 0 || bYearly.length > 0) ? (
        <Card
          className="mb-6"
          data-section-id="yearly"
          data-section-label="Yearly trend"
        >
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Filings by fiscal year</CardTitle>
            <CardDescription>Year-over-year H-1B demand within each sector.</CardDescription>
          </CardHeader>
          <CardContent>
            <YearlyOverlay
              a={{ name: a.label, points: aYearly }}
              b={{ name: b.label, points: bYearly }}
            />
          </CardContent>
        </Card>
      ) : null}

      <div
        className="grid md:grid-cols-2 gap-4 mb-6"
        data-section-id="top-sponsors"
        data-section-label="Top sponsors"
      >
        {[{ ent: a, emps: aEmps }, { ent: b, emps: bEmps }].map(({ ent, emps }) => (
          <Card key={ent.slug}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base truncate">Top 5 sponsors — {ent.label}</CardTitle>
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

      <div
        className="grid md:grid-cols-2 gap-4 mb-6"
        data-section-id="top-occupations"
        data-section-label="Top occupations"
      >
        {[{ ent: a, socs: aSocs }, { ent: b, socs: bSocs }].map(({ ent, socs }) => (
          <Card key={ent.slug}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base truncate">Top 5 occupations — {ent.label}</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              {socs.length > 0 ? (
                <ul className="divide-y">
                  {socs.map((o, i) => (
                    <li key={o.soc_code} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                      <span className="text-muted-foreground tabular-nums w-5">{i + 1}</span>
                      <span className="font-mono text-xs text-muted-foreground w-16">{o.soc_code}</span>
                      <span className="flex-1 truncate">
                        {o.soc_slug ? (
                          <Link href={`/occupation/${o.soc_slug}`} className="hover:text-primary">{o.soc_title ?? '—'}</Link>
                        ) : (o.soc_title ?? '—')}
                      </span>
                      <span className="tabular-nums font-medium">{fmt(o.filings)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground px-5 pb-5">No occupation breakdown.</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div
        className="grid md:grid-cols-2 gap-4 mb-6"
        data-section-id="top-states"
        data-section-label="Top states"
      >
        {[{ ent: a, states: aStates }, { ent: b, states: bStates }].map(({ ent, states }) => (
          <Card key={ent.slug}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base truncate">Top 5 hiring states — {ent.label}</CardTitle>
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
                      <span className="tabular-nums font-medium">{fmt(s.filings)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground px-5 pb-5">No state breakdown.</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div data-section-id="swap" data-section-label="Swap entities">
      <CompareSwapper
        kind="sector"
        current={{
          left:  { slug: aSlug, label: a.label },
          right: { slug: bSlug, label: b.label },
        }}
        peers={listTopSectors(30)
          .filter((p) => p.slug !== aSlug && p.slug !== bSlug)
          .map<PeerOption>((p) => ({
            slug: p.slug,
            label: p.label,
            hint: `NAICS ${p.naics2}`,
          }))}
      />
      </div>

      <Card className="mt-4 bg-muted/20">
        <CardContent className="p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground">Or browse the full sector index.</div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm"><Link href={`/sector/${aSlug}`}>{a.label}</Link></Button>
            <Button asChild variant="outline" size="sm"><Link href={`/sector/${bSlug}`}>{b.label}</Link></Button>
            <Button asChild size="sm"><Link href="/sector">Browse all <ArrowRight className="size-3" /></Link></Button>
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

function YearlyOverlay({
  a, b,
}: {
  a: { name: string; points: Array<{ year: number; filings: number }> };
  b: { name: string; points: Array<{ year: number; filings: number }> };
}) {
  const years = Array.from(new Set([...a.points.map((p) => p.year), ...b.points.map((p) => p.year)])).sort();
  const aIdx = new Map(a.points.map((p) => [p.year, p.filings]));
  const bIdx = new Map(b.points.map((p) => [p.year, p.filings]));
  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div>
        <div className="flex items-center gap-2 text-sm mb-2">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: 'hsl(217 91% 55%)' }} />
          <span className="truncate font-medium">{a.name}</span>
        </div>
        <LineChartClient data={years.map((y) => ({ label: `FY${y}`, value: aIdx.get(y) ?? 0 }))} color="hsl(217 91% 55%)" height={200} />
      </div>
      <div>
        <div className="flex items-center gap-2 text-sm mb-2">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: 'hsl(262 83% 62%)' }} />
          <span className="truncate font-medium">{b.name}</span>
        </div>
        <LineChartClient data={years.map((y) => ({ label: `FY${y}`, value: bIdx.get(y) ?? 0 }))} color="hsl(262 83% 62%)" height={200} />
      </div>
    </div>
  );
}
