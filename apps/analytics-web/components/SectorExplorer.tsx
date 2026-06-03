'use client';

/**
 * /sector index — interactive shell.
 *
 * KPI strip + biggest YoY share movers + search + sortable table.
 * No region/per-capita (those are state-specific). YoY share is computed
 * against the in-set total — moving sector share, not absolute volume.
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
import { BiggestMoversChart, type MoverRow } from '@/components/charts/BiggestMoversChart';
import { EntityKpiStrip, type EntityKpiData } from '@/components/EntityKpiStrip';
import { SortableTable } from '@/components/SortableTable';
import { Pagination, usePagination } from '@/components/Pagination';
import { PageMinimap } from '@/components/PageMinimap';
import { fmt } from '@/lib/format';

export interface SectorExplorerRow {
  naics2: string;
  slug: string;
  label: string;
  filings: number;
  employers: number;
  rank: number;
  yearly: ReadonlyArray<number | null>;
}

export interface SectorExplorerProps {
  rows: ReadonlyArray<SectorExplorerRow>;
  years: ReadonlyArray<number>;
}

export function SectorExplorer({ rows, years }: SectorExplorerProps) {
  const [search, setSearch] = useState('');
  const { current: currentPage, pageSize, goToPage } = usePagination(50);
  const onSearchChange = (v: string) => {
    setSearch(v);
    if (currentPage !== 1) goToPage(1);
  };

  const kpis: EntityKpiData = useMemo(() => {
    const total = rows.reduce((s, r) => s + r.filings, 0);
    const sorted = [...rows].sort((a, b) => b.filings - a.filings);
    const top5 = sorted.slice(0, 5).reduce((s, r) => s + r.filings, 0);

    let biggest: EntityKpiData['biggestMover'] = null;
    let biggestAbs = 0;
    if (years.length >= 2 && total > 0) {
      const lastIdx = years.length - 1;
      const prevIdx = lastIdx - 1;
      let totalLast = 0, totalPrev = 0;
      for (const r of rows) {
        totalLast += r.yearly[lastIdx] ?? 0;
        totalPrev += r.yearly[prevIdx] ?? 0;
      }
      if (totalLast > 0 && totalPrev > 0) {
        for (const r of rows) {
          const last = r.yearly[lastIdx] ?? 0;
          const prev = r.yearly[prevIdx] ?? 0;
          const sLast = (last / totalLast) * 100;
          const sPrev = (prev / totalPrev) * 100;
          const delta = sLast - sPrev;
          if (Math.abs(delta) > biggestAbs && (last + prev) > 1000) {
            biggestAbs = Math.abs(delta);
            biggest = { code: r.naics2, name: r.label, deltaPct: delta };
          }
        }
      }
    }

    return {
      totalFilings: total,
      entityCount: rows.length,
      topFiveSharePct: total > 0 ? top5 / total : 0,
      biggestMover: biggest,
    };
  }, [rows, years]);

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
    return rows
      .map((r) => {
        const last = r.yearly[lastIdx] ?? 0;
        const prev = r.yearly[prevIdx] ?? 0;
        if (last + prev < 1000) return null;
        const sLast = (last / totalLast) * 100;
        const sPrev = (prev / totalPrev) * 100;
        return { code: r.naics2, name: r.label, deltaPct: sLast - sPrev };
      })
      .filter((m): m is MoverRow => m !== null)
      .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))
      .slice(0, 12);
  }, [rows, years]);

  const tableRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
      r.naics2.includes(needle) ||
      r.label.toLowerCase().includes(needle),
    );
  }, [rows, search]);

  const maxFilings = rows.reduce((m, r) => Math.max(m, r.filings), 0);
  const yearStart = years[0];
  const yearEnd = years[years.length - 1];

  const totalPages = Math.max(1, Math.ceil(tableRows.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * pageSize;

  return (
    <div className="space-y-6">
      <PageMinimap />

      <section data-section-id="kpis" data-section-label="KPIs">
        <EntityKpiStrip kpis={kpis} entityLabel="Sectors tracked" />
      </section>

      {moverRows.length > 0 ? (
        <Card data-section-id="movers" data-section-label="Biggest movers">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">
              Biggest share movers, FY{years[years.length - 2]} → FY{years[years.length - 1]}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Year-over-year change in each sector&rsquo;s share of national H-1B filings
              (in percentage points). Positive bars = gained share; negative = lost.
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            <BiggestMoversChart data={moverRows} />
          </CardContent>
        </Card>
      ) : null}

      <Card data-section-id="table" data-section-label="Sectors table">
        <CardHeader className="pb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-semibold">
            {fmt(tableRows.length)} sector{tableRows.length === 1 ? '' : 's'}
          </CardTitle>
          <label className="relative w-full sm:w-72">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Filter sectors…"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full rounded-md border bg-background h-9 pl-8 pr-3 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label="Filter sectors by NAICS code or label"
            />
          </label>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <SortableTable initialSort={{ key: 'rank', dir: 'asc' }} page={safePage} pageSize={pageSize} revision={tableRows}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12" data-sort-key="rank"  data-sort-type="number">#</TableHead>
                  <TableHead className="w-20" data-sort-key="naics" data-sort-type="string">NAICS</TableHead>
                  <TableHead             data-sort-key="label" data-sort-type="string">Sector</TableHead>
                  <TableHead className="text-right" data-sort-key="filings" data-sort-type="number">Filings</TableHead>
                  <TableHead className="w-28">Trend FY{yearStart}–FY{yearEnd}</TableHead>
                  <TableHead className="text-right" data-sort-key="employers" data-sort-type="number">Employers</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tableRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-6 text-center text-muted-foreground text-sm">
                      No sectors match — try clearing the search.
                    </TableCell>
                  </TableRow>
                ) : tableRows.map((s, idx) => {
                  const series = s.yearly;
                  return (
                    <TableRow key={s.naics2} className={idx < pageStart || idx >= pageStart + pageSize ? 'pgn-initial-hidden' : undefined}>
                      <TableCell className="text-muted-foreground tabular-nums" data-sort-value={s.rank}>{s.rank}</TableCell>
                      <TableCell className="font-mono text-xs" data-sort-value={s.naics2}>
                        <Link href={`/sector/${s.slug}`} className="hover:text-primary">{s.naics2}</Link>
                      </TableCell>
                      <TableCell data-sort-value={s.label}>
                        <Link href={`/sector/${s.slug}`} className="font-medium hover:text-primary">
                          {s.label}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right" data-sort-value={s.filings}>
                        <div className="flex items-center justify-end gap-2">
                          <MiniBar value={s.filings} max={maxFilings} />
                          <span className="tabular-nums">{fmt(s.filings)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {series && series.length > 1
                          ? <Sparkline values={[...series]} />
                          : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums" data-sort-value={s.employers}>{fmt(s.employers)}</TableCell>
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
            itemNoun="sector"
          />
        </CardContent>
      </Card>
    </div>
  );
}
