'use client';

/**
 * Windowed fiscal-year nav for the homepage. Shows WINDOW years at a time with
 * arrows to page through 2010–2025 + "All years"; active year highlighted. Reads
 * + sets the selected year from HomeYearContext (the dashboard islands react to it).
 *
 * Rendered twice by the page (responsive): a vertical, scroll-sticky RAIL on the
 * left for desktop, and a horizontal sticky BAR at the top for mobile — so you can
 * switch year from anywhere without scrolling back up. The "windowed 5 + arrows"
 * design (no dropdown) keeps a fixed footprint that never overflows a phone.
 */

import { useState } from 'react';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useHomeYear } from '@/components/home/HomeYearContext';

const WINDOW = 5;

const pill = (active: boolean): string =>
  'cursor-pointer rounded-md px-2.5 py-1 text-sm font-medium tabular-nums whitespace-nowrap transition-colors ' +
  (active
    ? 'bg-primary text-primary-foreground shadow-sm'
    : 'text-muted-foreground hover:bg-muted hover:text-foreground');

const arrow = (enabled: boolean): string =>
  'inline-flex items-center justify-center rounded-md p-1 ' +
  (enabled ? 'cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground' : 'opacity-30');

export function YearNav({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  const { years, selected, setSelected } = useHomeYear();
  const asc = [...years].sort((a, b) => a - b);
  const maxStart = Math.max(0, asc.length - WINDOW);
  // Default window = the latest WINDOW years (so the newest sit at the bottom/right).
  const [start, setStart] = useState(maxStart);
  const s = Math.min(start, maxStart);
  const visible = asc.slice(s, s + WINDOW);

  const vertical = orientation === 'vertical';
  const Older = vertical ? ChevronUp : ChevronLeft;     // scroll toward earlier years
  const Newer = vertical ? ChevronDown : ChevronRight;  // scroll toward later years
  const canOlder = s > 0;
  const canNewer = s < maxStart;

  return (
    <div
      role="group"
      aria-label="Filter by fiscal year"
      className={
        'inline-flex items-center gap-0.5 rounded-lg border bg-card p-1 ' +
        (vertical ? 'flex-col' : 'max-w-full overflow-x-auto')
      }
    >
      <button type="button" aria-label="Earlier years" disabled={!canOlder}
        onClick={() => setStart((v) => Math.max(0, v - 1))} className={`${arrow(canOlder)} shrink-0`}>
        <Older className="size-4" />
      </button>

      {visible.map((y) => (
        <button key={y} type="button" aria-pressed={selected === y}
          onClick={() => setSelected(y)} className={`${pill(selected === y)} shrink-0`}>
          {y}
        </button>
      ))}

      <button type="button" aria-label="Later years" disabled={!canNewer}
        onClick={() => setStart((v) => Math.min(maxStart, v + 1))} className={`${arrow(canNewer)} shrink-0`}>
        <Newer className="size-4" />
      </button>

      <div className={vertical ? 'my-0.5 h-px w-6 bg-border' : 'mx-0.5 h-6 w-px bg-border'} aria-hidden />

      <button type="button" aria-pressed={selected === 'all'}
        onClick={() => setSelected('all')} className={`${pill(selected === 'all')} shrink-0`}>
        {vertical ? 'All' : 'All years'}
      </button>
    </div>
  );
}
