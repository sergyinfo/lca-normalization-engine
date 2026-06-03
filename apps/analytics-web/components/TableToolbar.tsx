'use client';

/**
 * One-line table toolbar: a filter input on the left and numbered pagination on
 * the right. Rendered above (and, for multi-page tables, below) a data table.
 *
 * - On small screens the search collapses to an icon; tapping it expands a
 *   full-width input (and temporarily hides the pager) with a clear/close button.
 * - Returns null when there's nothing to show (no search + a single page), so
 *   short tables don't get an empty bar — the host renders the bottom toolbar
 *   only for multi-page tables, the top one always.
 */
import { useRef, useState } from 'react';
import { Search, X, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { buildPageList, PaginationButton } from '@/components/Pagination';

export interface TableToolbarProps {
  current: number;
  total: number;
  onPageChange: (page: number) => void;
  itemCount: number;
  pageSize: number;
  itemNoun?: string;
  /** Filter — omit `onSearch` for tables without a filter (e.g. rankings). */
  search?: string;
  onSearch?: (value: string) => void;
  searchPlaceholder?: string;
  searchLabel?: string;
  /** Notifies the host when the filter input gains/loses focus, so the host can
   *  keep a (otherwise-hideable) bottom toolbar mounted while you're typing in it. */
  onSearchFocusChange?: (focused: boolean) => void;
  position?: 'top' | 'bottom';
}

const INPUT_CLS =
  'w-full rounded-md border bg-background h-9 pl-8 pr-3 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const ICON_BTN_CLS =
  'inline-flex items-center justify-center size-9 rounded-md border bg-background text-foreground hover:bg-muted cursor-pointer';

export function TableToolbar({
  current, total, onPageChange, itemCount, pageSize, itemNoun = 'item',
  search, onSearch, searchPlaceholder, searchLabel, onSearchFocusChange, position = 'bottom',
}: TableToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  const hasSearch = typeof onSearch === 'function';
  const hasPages = total > 1;
  if (!hasSearch && !hasPages) return null;

  const start = (current - 1) * pageSize + 1;
  const end = Math.min(itemCount, current * pageSize);
  const pages = buildPageList(current, total);

  // Change page, then scroll the table card to the top (not the document top).
  const go = (page: number) => {
    onPageChange(page);
    if (typeof window === 'undefined') return;
    requestAnimationFrame(() => {
      const card = ref.current?.closest<HTMLElement>('[data-section-id]');
      if (card) window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - 16, behavior: 'smooth' });
    });
  };

  return (
    <div
      ref={ref}
      className={`flex items-center gap-2 px-3 py-2 bg-card/50 ${position === 'top' ? 'border-b' : 'border-t'}`}
    >
      {/* Filter — desktop */}
      {hasSearch && (
        <label className="relative hidden sm:block w-full max-w-[15rem]">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search" value={search} onChange={(e) => onSearch!(e.target.value)}
            onFocus={() => onSearchFocusChange?.(true)} onBlur={() => onSearchFocusChange?.(false)}
            placeholder={searchPlaceholder} aria-label={searchLabel} className={INPUT_CLS}
          />
        </label>
      )}

      {/* Filter — mobile (icon → inline input) */}
      {hasSearch && (
        <div className={`sm:hidden flex items-center gap-1 ${mobileOpen ? 'flex-1 min-w-0' : ''}`}>
          {mobileOpen ? (
            <>
              <label className="relative flex-1 min-w-0">
                <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  autoFocus type="search" value={search} onChange={(e) => onSearch!(e.target.value)}
                  placeholder={searchPlaceholder} aria-label={searchLabel} className={INPUT_CLS}
                  onFocus={() => onSearchFocusChange?.(true)}
                  onBlur={() => { onSearchFocusChange?.(false); if (!search) setMobileOpen(false); }}
                />
              </label>
              <button type="button" aria-label="Clear filter" className={ICON_BTN_CLS}
                onClick={() => { onSearch!(''); setMobileOpen(false); }}>
                <X className="size-4" />
              </button>
            </>
          ) : (
            <button type="button" aria-label="Filter" className={ICON_BTN_CLS} onClick={() => setMobileOpen(true)}>
              <Search className="size-4" />
            </button>
          )}
        </div>
      )}

      {/* Pagination — right (hidden on mobile while the search input is expanded) */}
      {hasPages && (
        <div className={`ml-auto flex items-center gap-2 ${mobileOpen ? 'hidden sm:flex' : ''}`}>
          <span className="hidden md:inline text-xs text-muted-foreground whitespace-nowrap">
            Showing <span className="font-medium tabular-nums">{start.toLocaleString()}–{end.toLocaleString()}</span>{' '}
            of <span className="font-medium tabular-nums">{itemCount.toLocaleString()}</span> {itemNoun}{itemCount === 1 ? '' : 's'}
          </span>
          <div className="flex items-center gap-1">
            <PaginationButton aria-label="First page" disabled={current === 1} onClick={() => go(1)}><ChevronsLeft className="size-4" /></PaginationButton>
            <PaginationButton aria-label="Previous page" disabled={current === 1} onClick={() => go(current - 1)}><ChevronLeft className="size-4" /></PaginationButton>
            {pages.map((p, i) =>
              p === 'ellipsis-l' || p === 'ellipsis-r'
                ? <span key={p + String(i)} aria-hidden="true" className="px-1 text-muted-foreground select-none">…</span>
                : <PaginationButton key={p} aria-label={`Page ${p}`} aria-current={p === current ? 'page' : undefined} active={p === current} onClick={() => go(p)}>{p}</PaginationButton>,
            )}
            <PaginationButton aria-label="Next page" disabled={current === total} onClick={() => go(current + 1)}><ChevronRight className="size-4" /></PaginationButton>
            <PaginationButton aria-label="Last page" disabled={current === total} onClick={() => go(total)}><ChevronsRight className="size-4" /></PaginationButton>
          </div>
        </div>
      )}

      {/* Single-page tables with a filter: show the row count instead of a pager */}
      {!hasPages && hasSearch && (
        <span className={`ml-auto text-xs text-muted-foreground whitespace-nowrap ${mobileOpen ? 'hidden sm:inline' : 'hidden xs:inline sm:inline'}`}>
          <span className="font-medium tabular-nums">{itemCount.toLocaleString()}</span> {itemNoun}{itemCount === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}
