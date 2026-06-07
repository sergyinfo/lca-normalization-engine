'use client';

/**
 * YearSelector — fiscal-year filter rendered as a single segmented control
 * (a row of connected pills inside one bordered "track"): the most-recent N
 * years + "All years", with older years tucked into a compact dropdown segment.
 * One control, one shape, no redundant copy.
 *
 * Why not `useSearchParams`? In the Next.js 15 App Router, reading it inside a
 * client component bails the surrounding page out of static generation — and
 * these pages are SSG. So state defaults to the latest year (matching the SSG
 * HTML) and syncs `?fy=` via `window.history` in effects only (see
 * `useYearParam`).
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export type YearValue = number | 'all';

/** One pill inside the segmented track. */
const seg = (active: boolean): string =>
  'cursor-pointer rounded-md px-2.5 py-1 text-sm font-medium tabular-nums whitespace-nowrap transition-colors ' +
  (active
    ? 'bg-primary text-primary-foreground shadow-sm'
    : 'text-muted-foreground hover:bg-muted hover:text-foreground');

/** The bordered track that holds the pills. */
const TRACK = 'inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border bg-card p-1';

export interface YearSelectorProps {
  /** Available years (any order). */
  years: number[];
  /** Currently selected year, or 'all'. */
  selected: YearValue;
  /** Called when the user picks a year (or 'all'). */
  onSelect: (y: YearValue) => void;
  /** How many of the most-recent years to show as pills (rest go in the dropdown). */
  maxButtons?: number;
}

export function YearSelector({ years, selected, onSelect, maxButtons = 6 }: YearSelectorProps) {
  if (!years.length) return null;
  const asc = [...years].sort((a, b) => a - b);
  const recent = asc.slice(-maxButtons);
  const older = asc.slice(0, -maxButtons);
  const olderActive = typeof selected === 'number' && older.includes(selected);

  return (
    <div role="group" aria-label="Filter by fiscal year" className={TRACK}>
      {older.length > 0 ? (
        <div className="relative shrink-0">
          <select
            aria-label="Earlier fiscal years"
            className={`${seg(olderActive)} appearance-none bg-transparent pr-6 focus:outline-none`}
            value={olderActive ? String(selected) : ''}
            onChange={(e) => { if (e.target.value) onSelect(Number(e.target.value)); }}
          >
            <option value="" disabled>Earlier</option>
            {[...older].reverse().map((y) => <option key={y} value={y}>FY{y}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1 top-1/2 size-3.5 -translate-y-1/2 opacity-60" />
        </div>
      ) : null}

      {recent.map((y) => (
        <button key={y} type="button" aria-pressed={selected === y}
          onClick={() => onSelect(y)} className={`${seg(selected === y)} shrink-0`}>
          {y}
        </button>
      ))}

      <button type="button" aria-pressed={selected === 'all'}
        onClick={() => onSelect('all')} className={`${seg(selected === 'all')} shrink-0`}>
        All years
      </button>
    </div>
  );
}

/**
 * Lightweight two-way toggle: latest FY vs. All years, as a 2-pill segmented
 * control matching YearSelector. Used on entity pages, where the full year
 * picker is intentionally reserved for the homepage.
 */
export function LatestAllToggle({
  latestYear, selected, onSelect,
}: { latestYear: number; selected: YearValue; onSelect: (y: YearValue) => void }) {
  const latestActive = selected !== 'all';
  return (
    <div role="group" aria-label="Fiscal year view" className={TRACK}>
      <button type="button" aria-pressed={latestActive}
        onClick={() => onSelect(latestYear)} className={`${seg(latestActive)} shrink-0`}>
        FY{latestYear}
      </button>
      <button type="button" aria-pressed={selected === 'all'}
        onClick={() => onSelect('all')} className={`${seg(selected === 'all')} shrink-0`}>
        All years
      </button>
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
