'use client';

/**
 * Windowed fiscal-year nav for the homepage. Active year highlighted; reads + sets
 * the selected year from HomeYearContext (the dashboard islands react to it).
 *
 * Rendered twice by the page (responsive): a vertical, scroll-sticky RAIL on the
 * left for desktop, and a horizontal sticky BAR at the top for mobile — so you can
 * switch year from anywhere without scrolling back up.
 *
 *  - Vertical (desktop): the visible-year count is sized to the VIEWPORT HEIGHT —
 *    a tall screen shows all 2010–2025 (arrows hidden); a short one shows fewer
 *    with up/down arrows. Re-measured on resize.
 *  - Horizontal (mobile): a fixed, narrow window (4) that fits a phone width with
 *    "All years" fully visible. Arrows page through the rest.
 *
 * Arrows advance STEP years per click (not 1) so paging a 16-year range is quick.
 */

import { useEffect, useState } from 'react';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useHomeYear } from '@/components/home/HomeYearContext';

const STEP = 3;               // years advanced per arrow click
const MOBILE_WINDOW = 4;      // fixed count on the horizontal (mobile) bar
const DEFAULT_VERTICAL = 10;  // SSR / first-paint count before height is measured
const ROW_PX = 30;            // ≈ height of one year pill (vertical)
const CHROME_PX = 180;        // sticky offset + arrows + divider + "All" + breathing room

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
  const vertical = orientation === 'vertical';

  // Vertical rail sizes itself to the viewport; horizontal stays a fixed window.
  const [count, setCount] = useState(vertical ? DEFAULT_VERTICAL : MOBILE_WINDOW);
  const [start, setStart] = useState(() =>
    Math.max(0, asc.length - (vertical ? DEFAULT_VERTICAL : MOBILE_WINDOW)),
  );

  useEffect(() => {
    if (!vertical) return;
    const compute = () => {
      const fit = Math.floor((window.innerHeight - CHROME_PX) / ROW_PX);
      const n = Math.max(5, Math.min(asc.length, fit));
      setCount(n);
      setStart(Math.max(0, asc.length - n)); // re-anchor to the latest years
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [vertical, asc.length]);

  const maxStart = Math.max(0, asc.length - count);
  const s = Math.min(start, maxStart);
  const visible = asc.slice(s, s + count);

  const Older = vertical ? ChevronUp : ChevronLeft;     // scroll toward earlier years
  const Newer = vertical ? ChevronDown : ChevronRight;  // scroll toward later years
  const canOlder = s > 0;
  const canNewer = s < maxStart;
  const paged = maxStart > 0;  // arrows only when the window can't hold every year

  return (
    <div
      role="group"
      aria-label="Filter by fiscal year"
      className={
        'inline-flex items-center gap-0.5 rounded-lg border bg-card p-1 ' +
        (vertical ? 'flex-col' : 'w-full justify-center overflow-x-auto')
      }
    >
      {paged ? (
        <button type="button" aria-label={`Earlier years (−${STEP})`} disabled={!canOlder}
          onClick={() => setStart((v) => Math.max(0, v - STEP))} className={`${arrow(canOlder)} shrink-0`}>
          <Older className="size-4" />
        </button>
      ) : null}

      {visible.map((y) => (
        <button key={y} type="button" aria-pressed={selected === y}
          onClick={() => setSelected(y)} className={`${pill(selected === y)} shrink-0`}>
          {y}
        </button>
      ))}

      {paged ? (
        <button type="button" aria-label={`Later years (+${STEP})`} disabled={!canNewer}
          onClick={() => setStart((v) => Math.min(maxStart, v + STEP))} className={`${arrow(canNewer)} shrink-0`}>
          <Newer className="size-4" />
        </button>
      ) : null}

      <div className={vertical ? 'my-0.5 h-px w-6 bg-border' : 'mx-0.5 h-6 w-px bg-border'} aria-hidden />

      <button type="button" aria-pressed={selected === 'all'}
        onClick={() => setSelected('all')} className={`${pill(selected === 'all')} shrink-0`}>
        {vertical ? 'All' : 'All years'}
      </button>
    </div>
  );
}
