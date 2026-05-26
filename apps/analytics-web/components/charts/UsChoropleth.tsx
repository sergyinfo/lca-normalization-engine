'use client';

/**
 * Interactive US states choropleth. Renders pure SVG (no recharts), all
 * 51 paths client-side. The interactivity layer:
 *
 *   - hover/focus a state → highlight its path, dim others, populate the
 *     side panel with rank + filings + share + yearly sparkline + top
 *     sponsor;
 *   - click → navigate to `/state/<slug>`;
 *   - keyboard: Tab through states, Enter follows the link.
 *
 * Default panel content (no hover) is whichever state is rank 1, so the
 * page is informative even before the user moves the mouse.
 *
 * Geo data is baked at build time (lib/us-states-geo.ts); the sentence-
 * transformer cost of a vector library doesn't apply here. Bundle weight
 * is the geo JSON (~140 kB pre-gzip) plus this component.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';

import { US_STATES_GEO, US_VIEW_BOX } from '@/lib/us-states-geo';
import { fmt } from '@/lib/format';
import { Sparkline } from './Sparkline';

export interface UsChoroplethDatum {
  /** 2-letter postal code (matches lib/us-states-geo.ts). */
  readonly code: string;
  /** Slug for `/state/<slug>`. */
  readonly slug: string;
  /** Display name (used in labels + panel). */
  readonly name: string;
  /** Quantitative metric — filings. */
  readonly value: number;
  /** Optional rank — defaults to the position in the sorted-desc `data` array. */
  readonly rank?: number;
  /** Share of the national total, 0–1. Computed if absent. */
  readonly sharePct?: number;
  /** Yearly filings, oldest → newest. Drives the panel sparkline. */
  readonly yearly?: ReadonlyArray<number | null>;
  /** Optional top sponsor metadata for the side panel. */
  readonly topSponsor?: { readonly name: string; readonly slug: string };
}

export interface UsChoroplethProps {
  data: ReadonlyArray<UsChoroplethDatum>;
  /** Accessible title for screen readers. */
  caption?: string;
  /** Color scale start (low values). */
  fillFrom?: string;
  /** Color scale end (high values). */
  fillTo?: string;
  /** Fill for states with no data. */
  noData?: string;
  /** First-year label for the sparkline ("FY2020") and last-year ("FY2025"). */
  yearLabels?: readonly [string, string];
}

const DEFAULT_FROM = 'var(--color-muted)';
const DEFAULT_TO = 'var(--color-primary)';
const DEFAULT_NODATA = 'var(--color-muted)';

// States too small to host an inline label cleanly. Their callout (leader
// line + label) is drawn in a second pass on top so it can never be hidden
// by a neighbour's polygon.
const LABEL_INLINE_DENYLIST = new Set([
  'CT', 'RI', 'NJ', 'DE', 'MD', 'DC', 'NH', 'VT', 'MA',
]);

export function UsChoropleth({
  data,
  caption = 'H-1B filings by US state',
  fillFrom = DEFAULT_FROM,
  fillTo = DEFAULT_TO,
  noData = DEFAULT_NODATA,
  yearLabels,
}: UsChoroplethProps) {
  const { byCode, max, total } = useMemo(() => {
    const byCode = new Map<string, UsChoroplethDatum>();
    let max = 0;
    let total = 0;
    for (const d of data) {
      byCode.set(d.code, d);
      if (d.value > max) max = d.value;
      total += d.value;
    }
    return { byCode, max, total };
  }, [data]);

  const logMax = Math.log1p(max || 1);
  const intensity = (v: number) => (logMax > 0 ? Math.log1p(v) / logMax : 0);

  // Default panel state — first datum with a non-zero value. When the host
  // page filters by region and no in-region state has data (e.g. clicking
  // "Territories" when no territory appears in the top-N states), defaultCode
  // is null and the side panel shows its empty-state prompt instead of
  // pretending whatever's rank #1 in the full set is active.
  const defaultCode = data.find((d) => d.value > 0)?.code ?? null;
  const [hovered, setHovered] = useState<string | null>(null);
  const activeCode = hovered ?? defaultCode;
  const active = activeCode ? byCode.get(activeCode) ?? null : null;
  const activeShare = active
    ? active.sharePct ?? (total > 0 ? active.value / total : 0)
    : 0;
  const activeRank = active?.rank ?? (active
    ? data.findIndex((d) => d.code === active.code) + 1 || null
    : null);

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_18rem]">
      {/* Map column */}
      <div>
        <svg
          viewBox={US_VIEW_BOX}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={caption}
          className="w-full h-auto"
          style={{ maxHeight: 520 }}
          onMouseLeave={() => setHovered(null)}
        >
          <title>{caption}</title>

          {/* State paths — base layer */}
          <g>
            {US_STATES_GEO.map((s) => {
              const datum = byCode.get(s.code);
              const v = datum?.value ?? 0;
              const t = datum ? intensity(v) : 0;
              const fill = datum
                ? `color-mix(in oklab, ${fillTo} ${(t * 100).toFixed(1)}%, ${fillFrom})`
                : noData;

              const isActive = activeCode === s.code;
              const dim = activeCode != null && !isActive;
              const label = datum
                ? `${s.name}: ${fmt(v)} filings`
                : `${s.name}: no data`;

              const pathEl = (
                <path
                  d={s.d}
                  fill={fill}
                  stroke={isActive ? 'var(--color-primary)' : 'var(--color-background)'}
                  strokeWidth={isActive ? 2 : 0.75}
                  vectorEffect="non-scaling-stroke"
                  opacity={dim ? 0.55 : 1}
                  className="transition-[opacity,stroke,stroke-width] duration-150 cursor-pointer"
                  onMouseEnter={() => setHovered(s.code)}
                  onFocus={() => setHovered(s.code)}
                  onBlur={() => setHovered(null)}
                  aria-current={isActive ? 'true' : undefined}
                >
                  <title>{label}</title>
                </path>
              );

              return datum ? (
                <Link
                  key={s.code}
                  href={`/state/${datum.slug}`}
                  aria-label={label}
                  prefetch={false}
                >
                  {pathEl}
                </Link>
              ) : (
                <g key={s.code} aria-label={label}>{pathEl}</g>
              );
            })}
          </g>

          {/* Labels — drawn after paths so they always sit on top */}
          <g aria-hidden="true" style={{ pointerEvents: 'none' }}>
            {US_STATES_GEO.map((s) => {
              if (LABEL_INLINE_DENYLIST.has(s.code)) return null;
              const datum = byCode.get(s.code);
              const isActive = activeCode === s.code;
              return (
                <text
                  key={s.code}
                  x={s.cx}
                  y={s.cy}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={11}
                  fontWeight={isActive ? 700 : 600}
                  fill={isActive ? 'var(--color-primary-foreground)' : 'var(--color-foreground)'}
                  style={{
                    paintOrder: 'stroke',
                    stroke: isActive
                      ? 'var(--color-primary)'
                      : 'var(--color-background)',
                    strokeWidth: 3,
                    strokeLinejoin: 'round',
                    opacity: datum ? 1 : 0.55,
                  }}
                >
                  {s.code}
                </text>
              );
            })}

            {/* Callout labels for tiny eastern states — drawn outside their
                polygon with a thin leader line. */}
            {US_STATES_GEO.filter((s) => s.callout).map((s) => {
              if (!s.callout) return null;
              const lx = s.cx + s.callout.dx;
              const ly = s.cy + s.callout.dy;
              const isActive = activeCode === s.code;
              return (
                <g key={`callout-${s.code}`}>
                  <line
                    x1={s.cx} y1={s.cy} x2={lx - 2} y2={ly}
                    stroke={isActive ? 'var(--color-primary)' : 'var(--color-muted-foreground)'}
                    strokeWidth={0.75}
                    vectorEffect="non-scaling-stroke"
                    opacity={isActive ? 1 : 0.6}
                  />
                  <text
                    x={lx} y={ly}
                    dominantBaseline="middle"
                    fontSize={10}
                    fontWeight={isActive ? 700 : 600}
                    fill={isActive ? 'var(--color-primary)' : 'var(--color-foreground)'}
                    style={{
                      paintOrder: 'stroke',
                      stroke: 'var(--color-background)',
                      strokeWidth: 3,
                      strokeLinejoin: 'round',
                    }}
                  >
                    {s.code}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* Legend */}
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="tabular-nums">0</span>
            <span
              className="block h-2 w-40 rounded-full"
              style={{ background: `linear-gradient(to right, ${fillFrom}, ${fillTo})` }}
            />
            <span className="tabular-nums">{fmt(max)}</span>
          </div>
          <span className="hidden sm:inline">log-scaled · hover a state for details</span>
        </div>
      </div>

      {/* Side panel */}
      <aside
        aria-live="polite"
        className="rounded-lg border bg-card p-4 shadow-sm flex flex-col gap-3 self-start"
      >
        {active ? (
          <>
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-2xl font-bold tracking-tight text-primary">
                {active.code}
              </span>
              <span className="text-sm font-medium leading-tight">{active.name}</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Rank</dt>
              <dd className="tabular-nums font-medium text-right">
                {activeRank ? `#${activeRank} of ${data.length}` : '—'}
              </dd>
              <dt className="text-muted-foreground">Filings</dt>
              <dd className="tabular-nums font-medium text-right">{fmt(active.value)}</dd>
              <dt className="text-muted-foreground">% of national</dt>
              <dd className="tabular-nums font-medium text-right">
                {(activeShare * 100).toFixed(1)}%
              </dd>
            </dl>

            {active.yearly && active.yearly.length > 1 ? (
              <div>
                <div className="text-xs text-muted-foreground mb-1">
                  {yearLabels ? `${yearLabels[0]}–${yearLabels[1]}` : 'Yearly trend'}
                </div>
                <Sparkline values={[...active.yearly]} width={240} height={48} />
              </div>
            ) : null}

            {active.topSponsor ? (
              <div className="text-xs">
                <div className="text-muted-foreground">Top sponsor</div>
                <Link
                  href={`/employer/${active.topSponsor.slug}`}
                  className="font-medium text-foreground hover:text-primary line-clamp-1"
                >
                  {active.topSponsor.name}
                </Link>
              </div>
            ) : null}

            <Link
              href={`/state/${active.slug}`}
              className="mt-auto inline-flex items-center justify-center rounded-md border border-input bg-background px-3 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-primary hover:text-primary-foreground"
            >
              View {active.code} details →
            </Link>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Hover a state on the map to see its details.
          </p>
        )}
      </aside>
    </div>
  );
}
