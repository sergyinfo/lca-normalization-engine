'use client';

/**
 * Client-side sortable table wrapper. Hydrates over existing server-rendered
 * `<Table>` markup — no data-driven refactor needed at the call site.
 *
 * Usage:
 *   <SortableTable>
 *     <Table>
 *       <TableHeader>
 *         <TableRow>
 *           <TableHead data-sort-key="rank"    data-sort-type="number">#</TableHead>
 *           <TableHead data-sort-key="name"    data-sort-type="string">Name</TableHead>
 *           <TableHead data-sort-key="filings" data-sort-type="number">Filings</TableHead>
 *         </TableRow>
 *       </TableHeader>
 *       <TableBody>
 *         <TableRow>
 *           <TableCell data-sort-value="1">1</TableCell>
 *           <TableCell data-sort-value="Cognizant">Cognizant…</TableCell>
 *           <TableCell data-sort-value="1400940">{fmt(1400940)}</TableCell>
 *         </TableRow>
 *       </TableBody>
 *     </Table>
 *   </SortableTable>
 *
 * Headers without `data-sort-key` are inert. The first key with
 * `data-default-sort` is applied on hydration (or pass `initialSort`).
 *
 * Sorts are stable — equal keys keep original order — so secondary sort
 * works via JS click sequence.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type SortType = 'number' | 'string';
type Direction = 'asc' | 'desc';

interface Props {
  children: ReactNode;
  /** Initial column to sort by. */
  initialSort?: { key: string; dir: Direction };
  /**
   * Display-only pagination. When `pageSize` is set, the host renders ALL rows
   * (so every row is in the SSR HTML for crawlers); rows outside the current
   * `page` are hidden via inline `display:none` AFTER sorting, so sort +
   * pagination compose. The host marks off-page rows with the
   * `pgn-initial-hidden` class for the pre-JS paint; the inline style set here
   * overrides it once hydrated.
   */
  page?: number;
  pageSize?: number;
  /** Bump to re-apply sort + pagination when the rendered rows change (e.g. search). */
  revision?: unknown;
}

export function SortableTable({ children, initialSort, page, pageSize, revision }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<{ key: string; dir: Direction } | null>(initialSort ?? null);

  // On first paint, detect `data-default-sort` attribute on a header.
  useEffect(() => {
    if (sort || !ref.current) return;
    const def = ref.current.querySelector<HTMLTableCellElement>('th[data-default-sort]');
    if (def?.dataset.sortKey) {
      setSort({
        key: def.dataset.sortKey,
        dir: (def.dataset.defaultSort as Direction) === 'desc' ? 'desc' : 'asc',
      });
    }
  }, [sort]);

  // Wire click handlers on sortable headers.
  const onHeaderClick = useCallback((key: string) => {
    setSort((prev) => {
      if (prev?.key === key) {
        return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      }
      // First click on a numeric column → descending; string → ascending.
      const th = ref.current?.querySelector<HTMLTableCellElement>(`th[data-sort-key="${key}"]`);
      const type = (th?.dataset.sortType as SortType) ?? 'string';
      return { key, dir: type === 'number' ? 'desc' : 'asc' };
    });
  }, []);

  // Find the column index for the active key + read the type.
  const columnInfo = useMemo(() => {
    if (!sort || !ref.current) return null;
    const headers = ref.current.querySelectorAll<HTMLTableCellElement>('thead th');
    for (let i = 0; i < headers.length; i++) {
      if (headers[i]!.dataset.sortKey === sort.key) {
        return {
          index: i,
          type: (headers[i]!.dataset.sortType as SortType) ?? 'string',
        };
      }
    }
    return null;
  }, [sort]);

  // Apply sort by re-appending tbody rows in the new order.
  useEffect(() => {
    if (!ref.current) return;
    const tbody = ref.current.querySelector('tbody');
    if (!tbody) return;

    // Decorate header arrows + aria-sort.
    const headers = ref.current.querySelectorAll<HTMLTableCellElement>('thead th[data-sort-key]');
    headers.forEach((h) => {
      const key = h.dataset.sortKey!;
      h.setAttribute('aria-sort',
        sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
      );
      // Cursor / role
      h.style.cursor = 'pointer';
      h.style.userSelect = 'none';

      // Manage the indicator span.
      let indicator = h.querySelector<HTMLSpanElement>('span[data-sort-arrow]');
      if (!indicator) {
        indicator = document.createElement('span');
        indicator.dataset.sortArrow = 'true';
        indicator.style.marginLeft = '4px';
        indicator.style.fontSize = '10px';
        indicator.style.opacity = '0.6';
        h.appendChild(indicator);
      }
      if (sort?.key === key) {
        indicator.textContent = sort.dir === 'asc' ? '▲' : '▼';
        indicator.style.opacity = '1';
        indicator.style.color = 'hsl(217 91% 55%)';
      } else {
        indicator.textContent = '↕';
        indicator.style.opacity = '0.35';
        indicator.style.color = 'inherit';
      }
    });

    // Reorder rows for the active sort (if any).
    if (sort && columnInfo) {
      const rows = Array.from(tbody.querySelectorAll(':scope > tr'));
      if (rows.length > 0) {
        const idx = columnInfo.index;
        const type = columnInfo.type;
        const dir = sort.dir === 'asc' ? 1 : -1;

        // Decorated sort to keep it stable (explicit tiebreaker by original index).
        const decorated = rows.map((row, i) => {
          const cell = row.children[idx] as HTMLTableCellElement | undefined;
          const raw = cell?.dataset.sortValue ?? cell?.textContent ?? '';
          return { row, i, key: raw };
        });

        decorated.sort((a, b) => {
          let cmp = 0;
          if (type === 'number') {
            const an = parseNumber(a.key);
            const bn = parseNumber(b.key);
            if (an === null && bn === null) cmp = 0;
            else if (an === null) cmp = 1;        // nulls last
            else if (bn === null) cmp = -1;
            else cmp = an - bn;
          } else {
            cmp = a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' });
          }
          return cmp !== 0 ? cmp * dir : a.i - b.i;
        });

        const frag = document.createDocumentFragment();
        decorated.forEach((d) => frag.appendChild(d.row));
        tbody.appendChild(frag);
      }
    }

    // Display-only pagination: after any reorder, hide rows outside the current
    // page (DOM order). Inline style overrides the pre-JS `pgn-initial-hidden`
    // class. All rows stay in the DOM, so they remain crawlable.
    if (pageSize && pageSize > 0) {
      const all = Array.from(tbody.querySelectorAll<HTMLElement>(':scope > tr'));
      const startI = (Math.max(1, page ?? 1) - 1) * pageSize;
      all.forEach((r, i) => {
        r.style.display = i >= startI && i < startI + pageSize ? 'table-row' : 'none';
      });
    }
  }, [sort, columnInfo, page, pageSize, revision]);

  // Click handler delegation for the header row.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: Event) => {
      const target = (e.target as HTMLElement).closest('th[data-sort-key]') as HTMLTableCellElement | null;
      if (!target || !target.dataset.sortKey) return;
      // Skip if header is inside a cell role like a button.
      onHeaderClick(target.dataset.sortKey);
    };
    el.addEventListener('click', handler);
    return () => el.removeEventListener('click', handler);
  }, [onHeaderClick]);

  return <div ref={ref}>{children}</div>;
}

function parseNumber(raw: string): number | null {
  if (raw === '' || raw == null) return null;
  // Strip $, %, commas, spaces — leave digits, minus, decimal.
  const cleaned = raw.replace(/[^\d.\-eE]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
