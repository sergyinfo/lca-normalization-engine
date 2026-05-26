'use client';

/**
 * /state index — interactive shell.
 *
 * Owns three pieces of UI state:
 *   - region    (All | Northeast | South | Midwest | West | Territories)
 *   - metric    ('absolute' filings vs 'perCapita' filings / 100k workers)
 *   - search    free-text filter for the table
 *
 * The KPI strip, choropleth, and table all derive from these. The
 * biggest-movers chart is global — it shows top movers across all states
 * regardless of region filter, so the editorial signal stays visible.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Sparkline } from '@/components/charts/Sparkline';
import { MiniBar } from '@/components/charts/MiniBar';
import { UsChoropleth, type UsChoroplethDatum } from '@/components/charts/UsChoropleth';
import { BiggestMoversChart, type MoverRow } from '@/components/charts/BiggestMoversChart';
import { EntityKpiStrip, type EntityKpiData } from '@/components/EntityKpiStrip';
import { SortableTable } from '@/components/SortableTable';
import { Pagination, usePagination } from '@/components/Pagination';
import { fmt } from '@/lib/format';
import { REGIONS, regionOf, type Region } from '@/lib/us-regions';
import { perCapita, WORKFORCE_K } from '@/lib/us-workforce';

export interface StateExplorerRow {
  code: string;
  slug: string;
  name: string;
  filings: number;
  rank: number;
  yearly: ReadonlyArray<number | null>;
  topSponsor?: { name: string; slug: string };
}

export interface StateExplorerProps {
  rows: ReadonlyArray<StateExplorerRow>;
  years: ReadonlyArray<number>;
  yearLabels?: readonly [string, string];
}

type Metric = 'absolute' | 'perCapita';
type RegionFilter = 'All' | Region;

const REGION_OPTIONS: RegionFilter[] = ['All', ...REGIONS];

export function StateExplorer({ rows, years, yearLabels }: StateExplorerProps) {
  const [region, setRegion] = useState<RegionFilter>('All');
  const [metric, setMetric] = useState<Metric>('absolute');
  const [search, setSearch] = useState('');
  const { current: currentPage, pageSize, goToPage } = usePagination(50);
  const resetPage = () => { if (currentPage !== 1) goToPage(1); };
  const onSearchChange = (v: string) => { setSearch(v); resetPage(); };
  const onRegionChange = (r: RegionFilter) => { setRegion(r); resetPage(); };
  const onMetricChange = (m: Metric) => { setMetric(m); resetPage(); };

  // ---- region region-counts for chip badges -----------------------------
  const counts = useMemo(() => {
    const out: Record<RegionFilter, number> = {
      All: rows.length, Northeast: 0, South: 0, Midwest: 0, West: 0, Territories: 0,
    };
    for (const r of rows) {
      const reg = regionOf(r.code);
      if (reg) out[reg] += 1;
    }
    return out;
  }, [rows]);

  // ---- metric-applied value per row ------------------------------------
  const valued = useMemo(() => rows.map((r) => {
    const v = metric === 'perCapita' ? (perCapita(r.filings, r.code) ?? 0) : r.filings;
    return { ...r, value: v };
  }), [rows, metric]);

  // ---- choropleth data: re-rank by current metric so panel ranking is honest
  const choroplethData = useMemo<UsChoroplethDatum[]>(() => {
    const sorted = [...valued].sort((a, b) => b.value - a.value);
    const totalAbs = rows.reduce((s, r) => s + r.filings, 0);
    return sorted.map((r, i) => {
      const sharePct = metric === 'absolute'
        ? (totalAbs > 0 ? r.filings / totalAbs : 0)
        : 0;
      const inRegion = region === 'All' ? true : regionOf(r.code) === region;
      return {
        code: r.code,
        slug: r.slug,
        name: r.name,
        value: inRegion ? r.value : 0,        // dims out-of-region states in the map
        rank: i + 1,
        sharePct,
        yearly: r.yearly,
        topSponsor: r.topSponsor,
      };
    });
  }, [valued, rows, metric, region]);

  // ---- KPIs (computed off ABSOLUTE filings even when per-capita is selected,
  //      because "1.2M total filings" beats "0.3 filings/100k workers" at the
  //      top of the page).
  const kpis: EntityKpiData = useMemo(() => {
    const inRegion = (code: string) =>
      region === 'All' ? true : regionOf(code) === region;
    const scoped = rows.filter((r) => inRegion(r.code));
    const total = scoped.reduce((s, r) => s + r.filings, 0);
    const sorted = [...scoped].sort((a, b) => b.filings - a.filings);
    const top5 = sorted.slice(0, 5).reduce((s, r) => s + r.filings, 0);

    // Biggest YoY mover: compare last two valid yearly entries by share-of-region.
    let biggest: EntityKpiData['biggestMover'] = null;
    let biggestAbs = 0;
    if (years.length >= 2 && total > 0) {
      const lastIdx = years.length - 1;
      const prevIdx = lastIdx - 1;
      // Regional totals at last + prev year (needed for share denominators).
      let totalLast = 0, totalPrev = 0;
      for (const r of scoped) {
        totalLast += r.yearly[lastIdx] ?? 0;
        totalPrev += r.yearly[prevIdx] ?? 0;
      }
      if (totalLast > 0 && totalPrev > 0) {
        for (const r of scoped) {
          const last = r.yearly[lastIdx] ?? 0;
          const prev = r.yearly[prevIdx] ?? 0;
          const sLast = (last / totalLast) * 100;
          const sPrev = (prev / totalPrev) * 100;
          const delta = sLast - sPrev;
          if (Math.abs(delta) > biggestAbs && (last + prev) > 1000) {
            biggestAbs = Math.abs(delta);
            biggest = { code: r.code, name: r.name, deltaPct: delta };
          }
        }
      }
    }

    return {
      totalFilings: total,
      entityCount: scoped.length,
      topFiveSharePct: total > 0 ? top5 / total : 0,
      biggestMover: biggest,
    };
  }, [rows, region, years]);

  // ---- Biggest movers chart data: top-12 by |Δ| across ALL states ------
  const moverRows: MoverRow[] = useMemo(() => {
    if (years.length < 2) return [];
    const lastIdx = years.length - 1;
    const prevIdx = lastIdx - 1;
    let totalLast = 0, totalPrev = 0;
    for (const r of rows) {
      totalLast += r.yearly[lastIdx] ?? 0;
      totalPrev += r.yearly[prevIdx] ?? 0;
    }
    if (totalLast === 0 || totalPrev === 0) return [];
    const movers: MoverRow[] = rows
      .map((r) => {
        const last = r.yearly[lastIdx] ?? 0;
        const prev = r.yearly[prevIdx] ?? 0;
        if (last + prev < 1000) return null;
        const sLast = (last / totalLast) * 100;
        const sPrev = (prev / totalPrev) * 100;
        return { code: r.code, name: r.name, deltaPct: sLast - sPrev };
      })
      .filter((m): m is MoverRow => m !== null)
      .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))
      .slice(0, 12);
    return movers;
  }, [rows, years]);

  // ---- Table rows: filter by region + search ---------------------------
  const tableRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (region !== 'All' && regionOf(r.code) !== region) return false;
      if (!needle) return true;
      return (
        r.code.toLowerCase().includes(needle) ||
        r.name.toLowerCase().includes(needle)
      );
    });
  }, [rows, region, search]);

  const maxAbs = rows.reduce((m, r) => Math.max(m, r.filings), 0);
  const yearStart = years[0];
  const yearEnd = years[years.length - 1];

  const totalPages = Math.max(1, Math.ceil(tableRows.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pagedRows = tableRows.slice(pageStart, pageStart + pageSize);

  return (
    <div className="space-y-6">
      <EntityKpiStrip kpis={kpis} entityLabel="States tracked" />

      {/* Region chips + metric toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {REGION_OPTIONS.map((opt) => {
            const isActive = region === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onRegionChange(opt)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'border bg-card text-foreground hover:bg-muted'
                }`}
                aria-pressed={isActive}
              >
                {opt}
                <span className="tabular-nums opacity-70">{counts[opt]}</span>
              </button>
            );
          })}
        </div>

        <fieldset className="inline-flex items-center rounded-md border bg-card p-0.5 text-xs">
          <legend className="sr-only">Map metric</legend>
          {(['absolute', 'perCapita'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onMetricChange(m)}
              aria-pressed={metric === m}
              className={`rounded px-2.5 py-1 transition-colors ${
                metric === m
                  ? 'bg-primary text-primary-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {m === 'absolute' ? 'Filings' : 'Per 100k workers'}
            </button>
          ))}
        </fieldset>
      </div>

      {/* Map */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">
            Filings intensity {region !== 'All' && <span className="text-muted-foreground font-normal">· {region}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <UsChoropleth
            data={choroplethData}
            caption={`H-1B ${metric === 'absolute' ? 'filings' : 'filings per 100k workers'} by US state`}
            yearLabels={yearStart != null && yearEnd != null
              ? yearLabels ?? [`FY${yearStart}`, `FY${yearEnd}`]
              : undefined}
          />
        </CardContent>
      </Card>

      {/* Biggest movers */}
      {moverRows.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">
              Biggest share movers, FY{years[years.length - 2]} → FY{years[years.length - 1]}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Year-over-year change in each state&rsquo;s share of national H-1B filings
              (in percentage points). Positive bars = gained share; negative = lost.
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            <BiggestMoversChart data={moverRows} />
          </CardContent>
        </Card>
      ) : null}

      {/* Table */}
      <Card>
        <CardHeader className="pb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-semibold">
            {fmt(tableRows.length)} state{tableRows.length === 1 ? '' : 's'}
            {region !== 'All' && <span className="text-muted-foreground font-normal"> · {region}</span>}
          </CardTitle>
          <label className="relative w-full sm:w-64">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Filter states…"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full rounded-md border bg-background h-9 pl-8 pr-3 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label="Filter states by code or name"
            />
          </label>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <SortableTable initialSort={{ key: 'rank', dir: 'asc' }}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12" data-sort-key="rank" data-sort-type="number">#</TableHead>
                  <TableHead className="w-16" data-sort-key="code" data-sort-type="string">Code</TableHead>
                  <TableHead             data-sort-key="name" data-sort-type="string">State</TableHead>
                  <TableHead className="w-24 hidden md:table-cell" data-sort-key="region" data-sort-type="string">Region</TableHead>
                  <TableHead className="text-right" data-sort-key="filings" data-sort-type="number">Filings</TableHead>
                  {metric === 'perCapita' ? (
                    <TableHead className="text-right hidden lg:table-cell" data-sort-key="percapita" data-sort-type="number">/ 100k</TableHead>
                  ) : null}
                  <TableHead className="w-28">Trend FY{yearStart}–FY{yearEnd}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tableRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-6 text-center text-muted-foreground text-sm">
                      No states match — try clearing the filters.
                    </TableCell>
                  </TableRow>
                ) : pagedRows.map((s) => {
                  const series = s.yearly;
                  const pc = perCapita(s.filings, s.code);
                  return (
                    <TableRow key={s.code}>
                      <TableCell className="text-muted-foreground tabular-nums" data-sort-value={s.rank}>{s.rank}</TableCell>
                      <TableCell className="font-mono text-xs" data-sort-value={s.code}>
                        <Link href={`/state/${s.slug}`} className="hover:text-primary">{s.code}</Link>
                      </TableCell>
                      <TableCell data-sort-value={s.name}>
                        <Link href={`/state/${s.slug}`} className="font-medium hover:text-primary">
                          {s.name}
                        </Link>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground" data-sort-value={regionOf(s.code) ?? 'zzz'}>
                        {regionOf(s.code) ?? '—'}
                      </TableCell>
                      <TableCell className="text-right" data-sort-value={s.filings}>
                        <div className="flex items-center justify-end gap-2">
                          <MiniBar value={s.filings} max={maxAbs} />
                          <span className="tabular-nums">{fmt(s.filings)}</span>
                        </div>
                      </TableCell>
                      {metric === 'perCapita' ? (
                        <TableCell className="text-right tabular-nums hidden lg:table-cell" data-sort-value={pc ?? 0}>
                          {pc != null && WORKFORCE_K[s.code] ? pc.toFixed(2) : '—'}
                        </TableCell>
                      ) : null}
                      <TableCell>
                        {series && series.length > 1
                          ? <Sparkline values={[...series]} />
                          : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </SortableTable>
          <Pagination
            current={safePage}
            total={totalPages}
            onChange={goToPage}
            itemCount={tableRows.length}
            pageSize={pageSize}
            itemNoun="state"
          />
        </CardContent>
      </Card>
    </div>
  );
}
