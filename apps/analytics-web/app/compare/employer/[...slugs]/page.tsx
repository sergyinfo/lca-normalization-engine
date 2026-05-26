import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, GitCompare, ArrowRight } from 'lucide-react';

import {
  getEmployer, getEmployerTopSocs, getEmployerYearly, listTopEmployers,
} from '@/lib/queries';
import { CompareSwapper } from '@/components/CompareSwapper';
import type { PeerOption } from '@/components/ComparePicker';
import { fmt, fmtPct, fmtFy } from '@/lib/format';
import { entityMetadata } from '@/lib/seo';
import { SITE_NAME } from '@/lib/site';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StackedBarSvg } from '@/components/charts/StackedBarSvg';
import { LineChartClient } from '@/components/charts/LineChartClient';

// Pre-render top-10 × top-10 pairs at build time. Other pairs render on demand.
export const dynamicParams = true;

export function generateStaticParams() {
  const top = listTopEmployers(10);
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
  if (!aSlug || !bSlug) return { title: 'Compare sponsors' };
  const a = getEmployer(aSlug);
  const b = getEmployer(bSlug);
  if (!a || !b) return { title: 'Not found' };
  // Canonical points at the alphabetically-sorted pair so /A/B and /B/A
  // both fold onto the same indexable URL (A < B). Page itself still
  // renders with whichever order the visitor requested.
  const [c0, c1] = [aSlug, bSlug].sort() as [string, string];
  return entityMetadata({
    title: `${a.canonical_name} vs ${b.canonical_name} — H-1B Sponsor Comparison`,
    description: `Side-by-side H-1B sponsorship comparison: ${a.canonical_name} (${fmt(a.filings)} filings) vs ${b.canonical_name} (${fmt(b.filings)} filings). Certification rates, denial rates, top occupations, yearly trend.`,
    path: `/compare/employer/${c0}/${c1}`,
  });
}

export default async function CompareEmployersPage(
  { params }: { params: Promise<{ slugs: string[] }> },
) {
  const { slugs } = await params;
  if (slugs.length !== 2) notFound();
  const [aSlug, bSlug] = slugs as [string, string];
  const a = getEmployer(aSlug);
  const b = getEmployer(bSlug);
  if (!a || !b) notFound();

  const aTopSocs = getEmployerTopSocs(aSlug).slice(0, 5);
  const bTopSocs = getEmployerTopSocs(bSlug).slice(0, 5);
  const aYearly  = getEmployerYearly(aSlug);
  const bYearly  = getEmployerYearly(bSlug);

  const entities = [a, b];

  return (
    <>
      <nav aria-label="Breadcrumb" className="pb-2">
        <Link
          href={`/employer/${aSlug}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Back to {a.canonical_name}
        </Link>
      </nav>

      {/* Hero */}
      <section className="space-y-4 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <GitCompare className="size-3" /> Side-by-side comparison
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight max-w-4xl">
          {a.canonical_name}{' '}
          <span className="text-muted-foreground">vs</span>{' '}
          {b.canonical_name}
        </h1>
        <p className="text-muted-foreground max-w-3xl">
          A direct H-1B sponsorship comparison built from the same DOL Labor
          Condition Application data that drives every page on {SITE_NAME}.
          Total filings, outcome rates, top occupations and yearly demand
          side-by-side.
        </p>
      </section>

      {/* Entity cards — two columns of names + states + ranks */}
      <div className="grid md:grid-cols-2 gap-4 pb-6">
        {entities.map((e, i) => (
          <Card key={e.slug} className={i === 0 ? 'border-primary/30' : 'border-violet-300/40'}>
            <CardContent className="p-5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                {i === 0 ? 'Entity A' : 'Entity B'}
              </div>
              <Link
                href={`/employer/${e.slug}`}
                className="text-lg font-bold tracking-tight hover:text-primary"
              >
                {e.canonical_name}
              </Link>
              <div className="flex flex-wrap gap-2 mt-3 text-xs">
                {e.employer_state ? (
                  <Badge variant="outline">{e.employer_state}</Badge>
                ) : null}
                <Badge variant="secondary">Rank #{e.rank}</Badge>
                {e.fein ? <Badge variant="outline">FEIN {e.fein}</Badge> : null}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* KPI comparison */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Key metrics</CardTitle>
          <CardDescription>
            All percentages are share of total LCAs filed by each sponsor.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <table className="w-full text-sm">
            <thead className="border-t border-b bg-muted/30">
              <tr>
                <th className="text-left p-3 font-medium text-muted-foreground w-1/3">Metric</th>
                <th className="text-right p-3 font-medium">{a.canonical_name}</th>
                <th className="text-right p-3 font-medium">{b.canonical_name}</th>
              </tr>
            </thead>
            <tbody className="[&_tr]:border-b last:[&_tr]:border-b-0">
              <CompareRow
                label="Total filings"
                a={fmt(a.filings)} b={fmt(b.filings)}
                winner={a.filings > b.filings ? 'a' : a.filings < b.filings ? 'b' : null}
              />
              <CompareRow
                label="Certified %"
                a={fmtPct(a.certified_pct, 2)} b={fmtPct(b.certified_pct, 2)}
                winner={pickHigh(a.certified_pct, b.certified_pct)}
              />
              <CompareRow
                label="Denied %"
                a={fmtPct(a.denied_pct, 2)} b={fmtPct(b.denied_pct, 2)}
                winner={pickLow(a.denied_pct, b.denied_pct)}
              />
              <CompareRow
                label="Withdrawn %"
                a={fmtPct(a.withdrawn_pct, 2)} b={fmtPct(b.withdrawn_pct, 2)}
                winner={null}
              />
              <CompareRow
                label="Cert-withdrawn %"
                a={fmtPct(a.cert_withdrawn_pct, 2)} b={fmtPct(b.cert_withdrawn_pct, 2)}
                winner={null}
              />
              <CompareRow
                label="Rank"
                a={a.rank != null ? `#${a.rank}` : '—'}
                b={b.rank != null ? `#${b.rank}` : '—'}
                winner={
                  a.rank != null && b.rank != null
                    ? (a.rank < b.rank ? 'a' : a.rank > b.rank ? 'b' : null)
                    : null
                }
              />
              <CompareRow
                label="Active years"
                a={`${fmtFy(a.first_year)}–${fmtFy(a.last_year)}`}
                b={`${fmtFy(b.first_year)}–${fmtFy(b.last_year)}`}
                winner={null}
              />
              <CompareRow
                label="Worksite state"
                a={a.employer_state ?? '—'} b={b.employer_state ?? '—'}
                winner={null}
              />
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Outcomes — stacked bar each */}
      <div className="grid md:grid-cols-2 gap-4 mb-6">
        {entities.map((e) => (
          <Card key={e.slug}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base truncate">Outcomes — {e.canonical_name}</CardTitle>
              <CardDescription>DOL case-status mix.</CardDescription>
            </CardHeader>
            <CardContent>
              <StackedBarSvg
                slices={outcomeSlices(e)}
              />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Yearly trend — overlay */}
      {(aYearly.length > 0 || bYearly.length > 0) ? (
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Yearly filing volume</CardTitle>
            <CardDescription>
              Year-over-year H-1B demand for each sponsor.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <YearlyOverlay
              a={{ name: a.canonical_name, points: aYearly }}
              b={{ name: b.canonical_name, points: bYearly }}
            />
          </CardContent>
        </Card>
      ) : null}

      {/* Top occupations side by side */}
      <div className="grid md:grid-cols-2 gap-4 mb-6">
        {[{ ent: a, socs: aTopSocs }, { ent: b, socs: bTopSocs }].map(({ ent, socs }) => (
          <Card key={ent.slug}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base truncate">Top 5 occupations — {ent.canonical_name}</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              {socs.length > 0 ? (
                <ul className="divide-y">
                  {socs.map((s, i) => (
                    <li key={s.soc_code} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                      <span className="text-muted-foreground tabular-nums w-5">{i + 1}</span>
                      <span className="font-mono text-xs text-muted-foreground w-16">{s.soc_code}</span>
                      <span className="flex-1 truncate">
                        {s.soc_slug ? (
                          <Link href={`/occupation/${s.soc_slug}`} className="hover:text-primary">
                            {s.soc_title ?? '—'}
                          </Link>
                        ) : (s.soc_title ?? '—')}
                      </span>
                      <span className="tabular-nums font-medium">{fmt(s.filings)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground px-5 pb-5">No occupation breakdown available.</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Swap picker — change either side without leaving the comparison */}
      <CompareSwapper
        kind="employer"
        current={{
          left:  { slug: aSlug, label: a.canonical_name },
          right: { slug: bSlug, label: b.canonical_name },
        }}
        peers={listTopEmployers(50)
          .filter((p) => p.slug !== aSlug && p.slug !== bSlug)
          .map<PeerOption>((p) => ({
            slug: p.slug,
            label: p.canonical_name,
            hint: p.employer_state ?? undefined,
          }))}
      />

      {/* Bottom links */}
      <Card className="mt-4 bg-muted/20">
        <CardContent className="p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground">
            Or browse the full sponsor index.
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/employer/${aSlug}`}>{a.canonical_name}</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/employer/${bSlug}`}>{b.canonical_name}</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/employer">
                Browse all <ArrowRight className="size-3" />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

/* ---- helpers ----------------------------------------------------------- */

function CompareRow({
  label, a, b, winner,
}: { label: string; a: string; b: string; winner: 'a' | 'b' | null }) {
  return (
    <tr>
      <td className="p-3 text-muted-foreground">{label}</td>
      <td className={`p-3 text-right tabular-nums ${winner === 'a' ? 'font-bold text-primary' : ''}`}>
        {a}
        {winner === 'a' ? <span className="ml-1.5 text-[10px] uppercase tracking-wider text-primary">▲</span> : null}
      </td>
      <td className={`p-3 text-right tabular-nums ${winner === 'b' ? 'font-bold text-primary' : ''}`}>
        {b}
        {winner === 'b' ? <span className="ml-1.5 text-[10px] uppercase tracking-wider text-primary">▲</span> : null}
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
function pickLow(av: number | null, bv: number | null): 'a' | 'b' | null {
  if (av == null || bv == null) return null;
  if (av < bv) return 'a';
  if (bv < av) return 'b';
  return null;
}

function outcomeSlices(e: ReturnType<typeof getEmployer> & {}) {
  if (!e) return [];
  return [
    { label: 'Certified',      value: e.certified_pct ?? 0,      color: 'hsl(160 84% 39%)' },
    { label: 'Cert-withdrawn', value: e.cert_withdrawn_pct ?? 0, color: 'hsl(38 92% 50%)' },
    { label: 'Withdrawn',      value: e.withdrawn_pct ?? 0,      color: 'hsl(220 14% 70%)' },
    { label: 'Denied',         value: e.denied_pct ?? 0,         color: 'hsl(0 84% 60%)' },
  ].filter((s) => s.value > 0);
}

function YearlyOverlay({
  a, b,
}: {
  a: { name: string; points: Array<{ year: number; filings: number }> };
  b: { name: string; points: Array<{ year: number; filings: number }> };
}) {
  // Merge year axis; one series per entity.
  const years = Array.from(new Set([...a.points.map((p) => p.year), ...b.points.map((p) => p.year)])).sort();
  const aIdx = new Map(a.points.map((p) => [p.year, p.filings]));
  const bIdx = new Map(b.points.map((p) => [p.year, p.filings]));
  const aData = years.map((y) => ({ label: `FY${y}`, value: aIdx.get(y) ?? 0 }));
  const bData = years.map((y) => ({ label: `FY${y}`, value: bIdx.get(y) ?? 0 }));
  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div>
        <div className="flex items-center gap-2 text-sm mb-2">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: 'hsl(217 91% 55%)' }} />
          <span className="truncate font-medium">{a.name}</span>
        </div>
        <LineChartClient data={aData} color="hsl(217 91% 55%)" height={200} />
      </div>
      <div>
        <div className="flex items-center gap-2 text-sm mb-2">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: 'hsl(262 83% 62%)' }} />
          <span className="truncate font-medium">{b.name}</span>
        </div>
        <LineChartClient data={bData} color="hsl(262 83% 62%)" height={200} />
      </div>
    </div>
  );
}
