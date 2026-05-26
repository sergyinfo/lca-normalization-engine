/**
 * Four headline metrics above an entity index page (state / sector /
 * occupation). Computed entirely from already-loaded data — no DB
 * roundtrip. Display-only; keep CPU light.
 */
import { TrendingDown, TrendingUp } from 'lucide-react';

import { fmt } from '@/lib/format';

export interface EntityKpiData {
  /** Total filings across the current (filtered) entity set. */
  totalFilings: number;
  /** How many entities are in the set right now. */
  entityCount: number;
  /** 0–1. Combined share of the top-5 entities in `totalFilings`. */
  topFiveSharePct: number;
  /** Entity with the largest YoY share change (positive or negative). */
  biggestMover: {
    code: string;
    name: string;
    /** Signed YoY share change in percentage points. */
    deltaPct: number;
  } | null;
}

export interface EntityKpiStripProps {
  kpis: EntityKpiData;
  /**
   * Label for the 2nd card — e.g. "States tracked" / "Sectors tracked" /
   * "Occupations tracked". Defaults to "Entities tracked".
   */
  entityLabel?: string;
}

export function EntityKpiStrip({
  kpis,
  entityLabel = 'Entities tracked',
}: EntityKpiStripProps) {
  const mover = kpis.biggestMover;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Kpi label="Total filings" value={fmt(kpis.totalFilings)} />
      <Kpi label={entityLabel} value={String(kpis.entityCount)} />
      <Kpi
        label="Top-5 concentration"
        value={`${(kpis.topFiveSharePct * 100).toFixed(1)}%`}
        sub="of all H-1B filings"
      />
      <Kpi
        label="Biggest YoY mover"
        value={mover ? `${mover.code} ${formatDelta(mover.deltaPct)}` : '—'}
        sub={mover ? mover.name : undefined}
        trend={mover ? (mover.deltaPct >= 0 ? 'up' : 'down') : undefined}
      />
    </div>
  );
}

function Kpi({
  label, value, sub, trend,
}: {
  label: string;
  value: string;
  sub?: string;
  trend?: 'up' | 'down';
}) {
  const Icon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : null;
  const tone = trend === 'up'
    ? 'text-emerald-600 dark:text-emerald-400'
    : trend === 'down'
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-foreground';
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 flex items-baseline gap-1.5 text-2xl font-bold tabular-nums ${tone}`}>
        {Icon ? <Icon className="size-5 shrink-0" /> : null}
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{sub}</div> : null}
    </div>
  );
}

function formatDelta(deltaPct: number): string {
  const sign = deltaPct >= 0 ? '+' : '';
  return `${sign}${deltaPct.toFixed(1)} pp`;
}
