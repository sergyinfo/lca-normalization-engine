'use client';

/**
 * Numbered pagination control: First · Prev · 1 2 … 5 6 7 … 9 10 · Next · Last.
 *
 * The current page lives in the URL (`?page=N`) so URLs are share-able and
 * browser back works as expected. Page 1 is implicit — we omit the param
 * entirely so the canonical `/employer` URL stays clean for SEO.
 *
 * Pure render component — call sites pass the current page + total page
 * count + a `goToPage` callback. Hook up `useSearchParams` / `useRouter`
 * in the parent component (see `usePagination` below for the standard
 * wiring).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

export interface PaginationProps {
  /** 1-indexed current page. */
  current: number;
  /** Total page count. ≥ 1. */
  total: number;
  /** Called when the user picks a page. */
  onChange: (page: number) => void;
  /** Total row count — surfaced as "Showing X-Y of Z" copy. */
  itemCount: number;
  /** Page size, used to compute the "Showing X-Y" range. */
  pageSize: number;
  /** Singular noun ("sponsor"), used as "showing X-Y of Z sponsors". */
  itemNoun?: string;
}

/**
 * URL-synced page state via `useState` + `window.history`.
 *
 * We deliberately avoid `useSearchParams` so the host page stays
 * statically generated: in Next.js 15 App Router, calling
 * `useSearchParams` inside a client component bails the surrounding page
 * out of SSG, which costs SEO (the page 1 HTML would render only a
 * Suspense fallback for crawlers).
 *
 * Trade-off: a hard reload of `/employer?page=2` paints with page 1
 * first, then the `useEffect` reads the URL and re-renders page 2.
 * That's fine — page 1 is the SEO-canonical content; deep links to
 * other pages still work, just with one extra paint.
 */
export function usePagination(pageSize: number) {
  const [current, setCurrent] = useState(1);

  // On mount: read ?page from the current URL and sync state.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const fromUrl = Number(new URLSearchParams(window.location.search).get('page'));
    if (Number.isFinite(fromUrl) && fromUrl > 1) setCurrent(fromUrl);
  }, []);

  const goToPage = useCallback((page: number) => {
    setCurrent(page);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (page <= 1) url.searchParams.delete('page');
    else url.searchParams.set('page', String(page));
    window.history.pushState({}, '', url);
    // Scroll back to the top of the table on page flip.
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }, []);

  // Honour back/forward navigation.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = () => {
      const fromUrl = Number(new URLSearchParams(window.location.search).get('page'));
      setCurrent(Number.isFinite(fromUrl) && fromUrl > 1 ? fromUrl : 1);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return { current, pageSize, goToPage };
}

/** Generate the visible page-button list with ellipses for > 7 pages. */
function buildPageList(current: number, total: number): Array<number | 'ellipsis-l' | 'ellipsis-r'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const items: Array<number | 'ellipsis-l' | 'ellipsis-r'> = [1];
  if (current > 4) items.push('ellipsis-l');
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let p = start; p <= end; p++) items.push(p);
  if (current < total - 3) items.push('ellipsis-r');
  items.push(total);
  return items;
}

export function Pagination({
  current, total, onChange, itemCount, pageSize, itemNoun = 'item',
}: PaginationProps) {
  const pages = useMemo(() => buildPageList(current, total), [current, total]);

  if (total <= 1) return null;

  const start = (current - 1) * pageSize + 1;
  const end = Math.min(itemCount, current * pageSize);

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t bg-card/50"
    >
      <span className="text-xs text-muted-foreground">
        Showing <span className="font-medium tabular-nums">{start.toLocaleString()}-{end.toLocaleString()}</span>
        {' '}of <span className="font-medium tabular-nums">{itemCount.toLocaleString()}</span> {itemNoun}{itemCount === 1 ? '' : 's'}
      </span>

      <div className="flex items-center gap-1">
        <PaginationButton
          aria-label="First page" disabled={current === 1}
          onClick={() => onChange(1)}
        >
          <ChevronsLeft className="size-4" />
        </PaginationButton>
        <PaginationButton
          aria-label="Previous page" disabled={current === 1}
          onClick={() => onChange(current - 1)}
        >
          <ChevronLeft className="size-4" />
        </PaginationButton>

        {pages.map((p, i) =>
          p === 'ellipsis-l' || p === 'ellipsis-r' ? (
            <span
              key={p + String(i)}
              aria-hidden="true"
              className="px-1.5 text-muted-foreground select-none"
            >
              …
            </span>
          ) : (
            <PaginationButton
              key={p}
              aria-label={`Page ${p}`}
              aria-current={p === current ? 'page' : undefined}
              active={p === current}
              onClick={() => onChange(p)}
            >
              {p}
            </PaginationButton>
          ),
        )}

        <PaginationButton
          aria-label="Next page" disabled={current === total}
          onClick={() => onChange(current + 1)}
        >
          <ChevronRight className="size-4" />
        </PaginationButton>
        <PaginationButton
          aria-label="Last page" disabled={current === total}
          onClick={() => onChange(total)}
        >
          <ChevronsRight className="size-4" />
        </PaginationButton>
      </div>
    </nav>
  );
}

function PaginationButton({
  children, active, disabled, onClick, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        `min-w-8 h-8 px-2 inline-flex items-center justify-center rounded-md text-xs font-medium tabular-nums transition-colors ` +
        (active
          ? 'bg-primary text-primary-foreground'
          : 'border bg-background text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-background')
      }
      {...rest}
    >
      {children}
    </button>
  );
}
