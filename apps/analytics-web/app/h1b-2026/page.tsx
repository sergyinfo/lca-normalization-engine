/**
 * /h1b-2026 — forward-year H-1B forecast landing page.
 *
 * A data-driven projection of FY2026 H-1B / LCA activity, produced BEFORE any
 * FY2026 data exists: deterministic trend numbers (OLS + CAGR, in site_forecast)
 * with an LLM-written narrative. Clearly labelled as a projection, not official data.
 *
 * Lifecycle: when FY2026 real data lands, generate-forecast.ts moves the forecast
 * to FY2027 and there is no site_forecast row for 2026 → this route 301s to home.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { TrendingUp, LineChart as LineIcon, Info, ArrowRight } from 'lucide-react';

import { getForecast, getSiteYearly, listTopEmployers, listTopOccupations } from '@/lib/queries';
import { fmt, fmtUsd } from '@/lib/format';
import { entityMetadata } from '@/lib/seo';
import { SITE_NAME } from '@/lib/site';
import { Badge } from '@/components/ui/badge';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from '@/components/ui/card';
import { LineChartClient } from '@/components/charts/LineChartClient';

const FORECAST_YEAR = 2026;

export function generateMetadata(): Metadata {
  const f = getForecast(FORECAST_YEAR);
  if (!f) return entityMetadata({ title: `H-1B ${FORECAST_YEAR} Forecast`, description: '', path: `/h1b-${FORECAST_YEAR}` });
  return entityMetadata({
    title: f.content.meta_title,
    description: f.content.meta_description,
    path: `/h1b-${FORECAST_YEAR}`,
  });
}

export default function ForecastPage() {
  const f = getForecast(FORECAST_YEAR);
  // No forecast for this year → its real data has landed (or never generated).
  // Preserve the indexed URL's equity with a redirect to home.
  if (!f) redirect('/');

  const yearly = getSiteYearly();
  const c = f.content;

  // Filings trajectory: actuals + the projected point (flagged with *).
  const filingsData = [
    ...yearly.map((y) => ({ label: String(y.year), value: y.filings })),
    { label: `${FORECAST_YEAR}*`, value: f.proj_filings },
  ];
  const wageActuals = yearly.filter((y) => y.median_wage != null);
  const wageData = [
    ...wageActuals.map((y) => ({ label: String(y.year), value: y.median_wage as number })),
    ...(f.proj_median_wage != null ? [{ label: `${FORECAST_YEAR}*`, value: f.proj_median_wage }] : []),
  ];

  const sponsors = listTopEmployers(8);
  const occupations = listTopOccupations(8);
  const updated = new Date(f.generated_at * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <article className="space-y-12">
      {/* ----- Hero ------------------------------------------------------- */}
      <section className="space-y-5 pt-4">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <Info className="size-3" />
          Forecast · projection from FY{f.base_first_year}–FY{f.base_last_year} trends · not official DOL data
        </Badge>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight max-w-4xl leading-[1.05]">
          H-1B {FORECAST_YEAR} forecast:{' '}
          <span className="bg-gradient-to-r from-primary to-cyan-500 bg-clip-text text-transparent">
            where the data points.
          </span>
        </h1>
        <p className="text-muted-foreground text-lg max-w-2xl">{c.intro}</p>

        <div className="grid gap-4 sm:grid-cols-3 pt-2">
          <StatCard
            label={`Projected FY${FORECAST_YEAR} filings`}
            value={fmt(f.proj_filings)}
            sub={`range ${fmt(f.proj_filings_lo)}–${fmt(f.proj_filings_hi)}`}
            icon={<TrendingUp className="size-4" />}
          />
          <StatCard
            label="Recent filings trend"
            value={`${f.cagr_pct != null && f.cagr_pct >= 0 ? '+' : ''}${f.cagr_pct ?? 0}%/yr`}
            sub={`FY${f.base_first_year}–FY${f.base_last_year} CAGR`}
            icon={<LineIcon className="size-4" />}
          />
          <StatCard
            label={`Projected median wage`}
            value={f.proj_median_wage != null ? fmtUsd(f.proj_median_wage) : '—'}
            sub={`FY${FORECAST_YEAR}, full-time equivalent`}
            icon={<TrendingUp className="size-4" />}
          />
        </div>
      </section>

      {/* ----- Filings trajectory ---------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Filings trajectory &amp; FY{FORECAST_YEAR} projection</CardTitle>
          <CardDescription>
            H-1B LCA filings per fiscal year. FY{FORECAST_YEAR} (marked *) is the projected value
            from a linear trend over the recent window — not actual data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LineChartClient data={filingsData} valueFormat="number" />
          <p className="mt-4 text-muted-foreground leading-relaxed">{c.filings_outlook}</p>
        </CardContent>
      </Card>

      {/* ----- Wage trajectory ------------------------------------------- */}
      {wageData.length > 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Median wage trajectory</CardTitle>
            <CardDescription>
              Median annualised prevailing wage on certified filings, by fiscal year.
              FY{FORECAST_YEAR} (*) is projected.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LineChartClient data={wageData} valueFormat="usd-short" color="#0891b2" />
            <p className="mt-4 text-muted-foreground leading-relaxed">{c.wage_outlook}</p>
          </CardContent>
        </Card>
      )}

      {/* ----- Likely top sponsors --------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Likely top FY{FORECAST_YEAR} sponsors</CardTitle>
          <CardDescription>{c.sponsors_outlook}</CardDescription>
        </CardHeader>
        <CardContent>
          <LeaderTable
            rows={sponsors.map((e) => ({
              href: `/employer/${e.slug}`,
              name: e.canonical_name,
              metric: fmt(e.filings),
              metricLabel: 'filings to date',
            }))}
          />
        </CardContent>
      </Card>

      {/* ----- Hot occupations ------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Occupations to watch in FY{FORECAST_YEAR}</CardTitle>
          <CardDescription>{c.occupations_outlook}</CardDescription>
        </CardHeader>
        <CardContent>
          <LeaderTable
            rows={occupations.map((o) => ({
              href: `/occupation/${o.slug}`,
              name: o.soc_title ?? o.soc_code,
              metric: fmt(o.filings),
              metricLabel: 'filings to date',
            }))}
          />
        </CardContent>
      </Card>

      {/* ----- Bottom line ----------------------------------------------- */}
      <section className="rounded-lg border bg-card p-6">
        <h2 className="text-xl font-semibold tracking-tight">The bottom line</h2>
        <p className="mt-2 text-muted-foreground leading-relaxed">{c.bottom_line}</p>
      </section>

      {/* ----- Methodology / disclaimer ---------------------------------- */}
      <section className="text-sm text-muted-foreground leading-relaxed border-t pt-6">
        <p>
          <strong className="text-foreground">How this forecast is made.</strong> The projected
          FY{FORECAST_YEAR} figures are computed deterministically from {SITE_NAME}&rsquo;s historical
          DOL disclosure data — an ordinary-least-squares linear trend over FY{f.base_first_year}–FY
          {f.base_last_year}, with a residual-based range. The written analysis is generated by a
          language model that is given only those real numbers and the current leaders; it does not
          invent figures. This is a <strong className="text-foreground">projection, not official or
          guaranteed data</strong>, and it will be replaced with actuals as the Department of Labor
          publishes FY{FORECAST_YEAR} releases. Generated {updated}.
        </p>
        <p className="mt-3">
          <Link href="/methodology" className="text-primary hover:underline inline-flex items-center gap-1">
            Full methodology <ArrowRight className="size-3" />
          </Link>
        </p>
      </section>
    </article>
  );
}

function StatCard({ label, value, sub, icon }: { label: string; value: string; sub: string; icon: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
        {icon} {label}
      </div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function LeaderTable({ rows }: { rows: Array<{ href: string; name: string; metric: string; metricLabel: string }> }) {
  return (
    <ol className="divide-y">
      {rows.map((r, i) => (
        <li key={r.href} className="flex items-center justify-between gap-4 py-2.5">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-5 shrink-0 text-sm tabular-nums text-muted-foreground">{i + 1}</span>
            <Link href={r.href} className="truncate font-medium hover:text-primary">{r.name}</Link>
          </div>
          <div className="shrink-0 text-right">
            <div className="tabular-nums font-semibold">{r.metric}</div>
            <div className="text-xs text-muted-foreground">{r.metricLabel}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
