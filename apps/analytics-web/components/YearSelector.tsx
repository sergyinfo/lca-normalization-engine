'use client';

/**
 * YearSelector — fiscal-year filter for entity hero stats.
 *
 * Renders the most-recent N years as buttons + an "All years" toggle; older
 * years collapse into a native <select> (no extra dep, SSG-safe). Pure render
 * component: the parent owns the selected year via `useYearParam`.
 *
 * Why not `useSearchParams`? In the Next.js 15 App Router, reading
 * `useSearchParams` inside a client component bails the surrounding page out of
 * static generation — and these entity pages are SSG (`dynamicParams = false`).
 * So we mirror `usePagination`: default to the latest year (matching the SSG
 * HTML), and sync `?fy=` via `window.history` in effects only. A deep link to
 * `?fy=2018` paints the latest year first, then re-renders — fine, the latest
 * year is the canonical content.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export type YearValue = number | 'all';

export interface YearSelectorProps {
  /** Available years (any order). */
  years: number[];
  /** Currently selected year, or 'all'. */
  selected: YearValue;
  /** Called when the user picks a year (or 'all'). */
  onSelect: (y: YearValue) => void;
  /** How many of the most-recent years to show as buttons (rest go in a select). */
  maxButtons?: number;
}

export function YearSelector({ years, selected, onSelect, maxButtons = 6 }: YearSelectorProps) {
  if (!years.length) return null;
  const asc = [...years].sort((a, b) => a - b);
  const recent = asc.slice(-maxButtons);
  const older = asc.slice(0, -maxButtons);
  const olderActive = typeof selected === 'number' && older.includes(selected);

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label="Filter stats by fiscal year"
    >
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground mr-1">
        Fiscal year
      </span>

      {older.length > 0 ? (
        <select
          aria-label="Earlier fiscal years"
          className="h-8 rounded-md border border-input bg-background px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          value={olderActive ? String(selected) : ''}
          onChange={(e) => { if (e.target.value) onSelect(Number(e.target.value)); }}
        >
          <option value="">Earlier…</option>
          {older.map((y) => <option key={y} value={y}>FY{y}</option>)}
        </select>
      ) : null}

      {recent.map((y) => (
        <Button
          key={y}
          type="button"
          size="sm"
          variant={selected === y ? 'default' : 'outline'}
          aria-pressed={selected === y}
          onClick={() => onSelect(y)}
        >
          FY{y}
        </Button>
      ))}

      <Button
        type="button"
        size="sm"
        variant={selected === 'all' ? 'default' : 'outline'}
        aria-pressed={selected === 'all'}
        onClick={() => onSelect('all')}
      >
        All years
      </Button>
    </div>
  );
}

/**
 * Lightweight two-way toggle: latest FY vs. All years. Used on entity pages,
 * where the full year picker is intentionally reserved for the homepage — here
 * we only contrast "the latest year" against "all years (2010 onward)".
 */
export function LatestAllToggle({
  latestYear, selected, onSelect,
}: { latestYear: number; selected: YearValue; onSelect: (y: YearValue) => void }) {
  const latestActive = selected !== 'all';
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Fiscal year view">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground mr-1">View</span>
      <Button
        type="button" size="sm"
        variant={latestActive ? 'default' : 'outline'}
        aria-pressed={latestActive}
        onClick={() => onSelect(latestYear)}
      >
        FY{latestYear}
      </Button>
      <Button
        type="button" size="sm"
        variant={selected === 'all' ? 'default' : 'outline'}
        aria-pressed={selected === 'all'}
        onClick={() => onSelect('all')}
      >
        All years
      </Button>
    </div>
  );
}

/**
 * Year-filter state synced to `?fy=`. Defaults to `defaultYear` (the latest FY,
 * which the SSG HTML renders), so a fresh load with no query string matches the
 * server markup. `?fy=all` and `?fy=2018` are restored on mount + on back/forward.
 */
export function useYearParam(defaultYear: number): [YearValue, (y: YearValue) => void] {
  const [year, setYear] = useState<YearValue>(defaultYear);

  const readUrl = useCallback((): YearValue => {
    if (typeof window === 'undefined') return defaultYear;
    const raw = new URLSearchParams(window.location.search).get('fy');
    if (raw === 'all') return 'all';
    const n = Number(raw);
    return raw && Number.isFinite(n) ? n : defaultYear;
  }, [defaultYear]);

  // On mount: honour a deep-linked ?fy=.
  useEffect(() => { setYear(readUrl()); }, [readUrl]);

  // Honour back/forward.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = () => setYear(readUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [readUrl]);

  const select = useCallback((y: YearValue) => {
    setYear(y);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (y === defaultYear) url.searchParams.delete('fy'); // default → clean canonical URL
    else url.searchParams.set('fy', String(y));
    window.history.replaceState({}, '', url);
  }, [defaultYear]);

  return [year, select];
}
