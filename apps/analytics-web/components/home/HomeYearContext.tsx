'use client';

/**
 * Shared fiscal-year selection for the homepage dashboard.
 *
 * The homepage interleaves year-aware blocks (KPI strip, charts, top tables)
 * with server components (Summary, ad slots). To keep one source of truth for
 * the selected year while letting those server components pass straight through,
 * we use a client Context provider that wraps the whole page content; the
 * year-aware blocks are small client "islands" that read the context, and the
 * server children render untouched between them.
 *
 * State + ?fy= URL sync come from `useYearParam` (defaults to the latest FY, so
 * the first paint matches the statically-generated HTML).
 */

import { createContext, useContext, type ReactNode } from 'react';
import { YearSelector, useYearParam, type YearValue } from '@/components/YearSelector';

interface HomeYearCtx {
  years: number[];
  selected: YearValue;
  setSelected: (y: YearValue) => void;
}

const Ctx = createContext<HomeYearCtx | null>(null);

export function useHomeYear(): HomeYearCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useHomeYear must be used within <HomeYearProvider>');
  return c;
}

export function HomeYearProvider({
  years, defaultYear, children,
}: { years: number[]; defaultYear: number; children: ReactNode }) {
  const [selected, setSelected] = useYearParam(defaultYear);
  return <Ctx.Provider value={{ years, selected, setSelected }}>{children}</Ctx.Provider>;
}

/** The year picker — a labelled segmented control, wired to context. */
export function HomeYearBar() {
  const { years, selected, setSelected } = useHomeYear();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Fiscal year
      </span>
      <YearSelector years={years} selected={selected} onSelect={setSelected} />
    </div>
  );
}
