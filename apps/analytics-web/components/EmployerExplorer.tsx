'use client';

/**
 * /employer index — interactive shell.
 *
 * KPI strip + biggest YoY share movers + search + sortable table.
 *
 * Employers have no 2-letter ticker, so the movers chart uses a synthetic
 * "shortCode" — first whitespace-delimited token of the canonical name,
 * uppercased, truncated to 12 chars. Good enough for AMAZON / INFOSYS /
 * TATA / WAL-MART recognition without committing to a real ticker scheme.
 * Full name still appears in the tooltip.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Sparkline } from '@/components/charts/Sparkline';
import { MiniBar } from '@/components/charts/MiniBar';
import { BiggestMoversChart, type MoverRow } from '@/components/charts/BiggestMoversChart';
import { EntityKpiStrip, type EntityKpiData } from '@/components/EntityKpiStrip';
import { SortableTable } from '@/components/SortableTable';
import { usePagination } from '@/components/Pagination';
import { TableToolbar } from '@/components/TableToolbar';
import { PageMinimap } from '@/components/PageMinimap';
import { fmt, fmtPct } from '@/lib/format';

export interface EmployerExplorerRow {
  slug: string;
  canonical_name: string;
  employer_state: string | null;
  filings: number;
  certified_pct: number | null;
  denied_pct: number | null;
  rank: number;
  yearly: ReadonlyArray<number | null>;
}

export interface EmployerExplorerProps {
  rows: ReadonlyArray<EmployerExplorerRow>;
  years: ReadonlyArray<number>;
}

function shortCode(name: string): string {
  const first = name.split(/[\s,]+/)[0] ?? name;
  return first.replace(/[^A-Za-z0-9.\-]/g, '').slice(0, 12).toUpperCase();
}

export function EmployerExplorer({ rows, years }: EmployerExplorerProps) {
  const [search, setSearch] = useState('');
  const [bottomFocused, setBottomFocused] = useState(false);
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
          // Threshold keeps tiny employers from dominating the headline
          // with noise — needs ≥ 2 000 filings across the two years.
          if (Math.abs(delta) > biggestAbs && (last + prev) > 2_000) {
            biggestAbs = Math.abs(delta);
            biggest = {
              code: shortCode(r.canonical_name),
              name: r.canonical_name,
              deltaPct: delta,
            };
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
    // Deduplicate codes so the chart doesn't show two "AMAZON" rows when
    // a power-law employer has FEIN/state-disambiguated entries.
    const seen = new Map<string, number>();
    return rows
      .map((r) => {
        const last = r.yearly[lastIdx] ?? 0;
        const prev = r.yearly[prevIdx] ?? 0;
        if (last + prev < 2_000) return null;
        const sLast = (last / totalLast) * 100;
        const sPrev = (prev / totalPrev) * 100;
        let code = shortCode(r.canonical_name);
        const collision = seen.get(code) ?? 0;
        if (collision > 0) code = `${code}·${collision + 1}`;
        seen.set(code, collision + 1);
        return { code, name: r.canonical_name, deltaPct: sLast - sPrev };
      })
      .filter((m): m is MoverRow => m !== null)
      .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))
      .slice(0, 12);
  }, [rows, years]);

  const tableRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
      r.canonical_name.toLowerCase().includes(needle) ||
      (r.employer_state?.toLowerCase().includes(needle) ?? false),
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
        <EntityKpiStrip kpis={kpis} entityLabel="Sponsors tracked" />
      </section>

      {moverRows.length > 0 ? (
        <Card data-section-id="movers" data-section-label="Biggest movers">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">
              Biggest share movers, FY{years[years.length - 2]} → FY{years[years.length - 1]}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Year-over-year change in each sponsor&rsquo;s share of national H-1B
              filings (in percentage points). Positive bars = gained share; negative
              = lost. Hover for the full company name.
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            <BiggestMoversChart data={moverRows} />
          </CardContent>
        </Card>
      ) : null}

      <Card data-section-id="table" data-section-label="Sponsors table">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">
            {fmt(tableRows.length)} sponsor{tableRows.length === 1 ? '' : 's'}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableToolbar current={safePage} total={totalPages} onPageChange={goToPage} itemCount={tableRows.length} pageSize={pageSize} itemNoun="sponsor"
            search={search} onSearch={onSearchChange} searchPlaceholder="Filter by name or state code…" searchLabel="Filter sponsors by company name or state code" position="top" />
          <SortableTable initialSort={{ key: 'rank', dir: 'asc' }} page={safePage} pageSize={pageSize} revision={tableRows}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12" data-sort-key="rank" data-sort-type="number">#</TableHead>
                  <TableHead data-sort-key="name" data-sort-type="string">Employer</TableHead>
                  <TableHead className="w-16" data-sort-key="state" data-sort-type="string">State</TableHead>
                  <TableHead className="text-right" data-sort-key="filings" data-sort-type="number">Filings</TableHead>
                  <TableHead className="w-28">Trend FY{yearStart}–FY{yearEnd}</TableHead>
                  <TableHead className="text-right" data-sort-key="cert" data-sort-type="number">Certified</TableHead>
                  <TableHead className="text-right" data-sort-key="denied" data-sort-type="number">Denied</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tableRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-muted-foreground text-sm">
                      No sponsors match — try clearing the search.
                    </TableCell>
                  </TableRow>
                ) : tableRows.map((e, idx) => {
                  const series = e.yearly;
                  return (
                    <TableRow key={e.slug} className={idx < pageStart || idx >= pageStart + pageSize ? 'pgn-initial-hidden' : undefined}>
                      <TableCell className="text-muted-foreground tabular-nums" data-sort-value={e.rank}>{e.rank}</TableCell>
                      <TableCell data-sort-value={e.canonical_name}>
                        <Link href={`/employer/${e.slug}`} className="font-medium hover:text-primary">
                          {e.canonical_name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs font-mono" data-sort-value={e.employer_state ?? ''}>
                        {e.employer_state ?? '—'}
                      </TableCell>
                      <TableCell className="text-right" data-sort-value={e.filings}>
                        <div className="flex items-center justify-end gap-2">
                          <MiniBar value={e.filings} max={maxFilings} />
                          <span className="tabular-nums">{fmt(e.filings)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {series && series.length > 1
                          ? <Sparkline values={[...series]} />
                          : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums" data-sort-value={e.certified_pct ?? ''}>
                        {fmtPct(e.certified_pct, 1)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums" data-sort-value={e.denied_pct ?? ''}>
                        {fmtPct(e.denied_pct, 1)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </SortableTable>
          {(totalPages > 1 || bottomFocused) && (
            <TableToolbar current={safePage} total={totalPages} onPageChange={goToPage} itemCount={tableRows.length} pageSize={pageSize} itemNoun="sponsor"
              search={search} onSearch={onSearchChange} searchPlaceholder="Filter by name or state code…" searchLabel="Filter sponsors by company name or state code"
              onSearchFocusChange={setBottomFocused} position="bottom" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
