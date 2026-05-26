'use client';

/**
 * Client subtree for `RankingPage`: the ranked Card + Table + numbered
 * pagination. Lives in its own file so the surrounding page can stay a
 * server component (intro/hero/methodology stay server-rendered for SEO).
 *
 * Pagination uses the same history-API hook as the entity explorers — no
 * `useSearchParams` so the page stays statically generated.
 */
import Link from 'next/link';

import { fmt } from '@/lib/format';
import { SortableTable } from '@/components/SortableTable';
import { Pagination, usePagination } from '@/components/Pagination';
import {
  Card, CardContent, CardHeader, CardTitle,
} from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

import type { RankingRow } from './RankingPage';

export interface PaginatedRankingTableProps {
  rows: ReadonlyArray<RankingRow>;
  /** Singular noun for the "Showing X-Y of Z" copy. Regular plural only — the
   *  Pagination control appends "s". Defaults to "entry" via the table-title
   *  copy, but pagination noun is "row" so "rows" stays grammatical. */
  itemNoun?: string;
  /** Rows per page. Defaults to 50. */
  pageSize?: number;
}

export function PaginatedRankingTable({
  rows, itemNoun = 'row', pageSize: pageSizeProp = 50,
}: PaginatedRankingTableProps) {
  const { current: currentPage, pageSize, goToPage } = usePagination(pageSizeProp);

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pagedRows = rows.slice(pageStart, pageStart + pageSize);

  return (
    <Card className="mt-2" data-section-id="table" data-section-label="Ranked table">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">
          {fmt(rows.length)} ranked entries
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <SortableTable initialSort={{ key: 'rank', dir: 'asc' }}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12" data-sort-key="rank" data-sort-type="number">#</TableHead>
                <TableHead data-sort-key="entity" data-sort-type="string">Entity</TableHead>
                {rows[0]?.cells.map((cell, i) => (
                  <TableHead
                    key={i}
                    className={cell.numeric ? 'text-right' : undefined}
                    data-sort-key={cell.sortKey}
                    data-sort-type={cell.sortType ?? (cell.numeric ? 'number' : 'string')}
                  >
                    {cell.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedRows.map((r) => (
                <TableRow key={`${r.rank}-${r.href}`}>
                  <TableCell className="text-muted-foreground tabular-nums" data-sort-value={r.rank}>{r.rank}</TableCell>
                  <TableCell data-sort-value={r.primary}>
                    <Link href={r.href} className="font-medium hover:text-primary">
                      {r.primary}
                    </Link>
                  </TableCell>
                  {r.cells.map((c, i) => (
                    <TableCell
                      key={i}
                      className={c.numeric ? 'text-right tabular-nums' : undefined}
                      data-sort-value={c.sortValue ?? undefined}
                    >
                      {c.value}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SortableTable>
        <Pagination
          current={safePage}
          total={totalPages}
          onChange={goToPage}
          itemCount={rows.length}
          pageSize={pageSize}
          itemNoun={itemNoun}
        />
      </CardContent>
    </Card>
  );
}
