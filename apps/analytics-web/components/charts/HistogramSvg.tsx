/**
 * Sorted descending bar chart ("Pareto spread"). One thin bar per data
 * point. Visually answers "what does the long tail look like?" much better
 * than linear-bucketed histograms — which collapse 99% of points into a
 * single bucket when the data is power-law (top sponsor 50× the median).
 *
 * Name kept as HistogramSvg so existing imports keep working.
 */

import { fmt as fmtNum } from '@/lib/format';

type ValueFormat = 'number' | 'usd-short' | 'pct';

interface Props {
  values: number[];
  /**
   * Bar area height in px. Omit to let the chart fill its parent
   * vertically (parent must be flex-col with a known height).
   */
  height?: number;
  gradient?: [string, string];
  valueFormat?: ValueFormat;
}

function fmtVal(n: number, f: ValueFormat): string {
  if (f === 'usd-short') return '$' + Math.round(n / 1000).toLocaleString() + 'k';
  if (f === 'pct')       return n.toFixed(1) + '%';
  return fmtNum(n);
}

export function HistogramSvg({
  values,
  height,
  gradient = ['hsl(217 91% 55%)', 'hsl(190 95% 50%)'],
  valueFormat = 'number',
}: Props) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => b - a);
  const max = sorted[0]!;
  const min = sorted[sorted.length - 1]!;
  const medianVal = sorted[Math.floor(sorted.length / 2)]!;
  const medianPct = max > 0 ? (medianVal / max) * 100 : 0;
  const bg = `linear-gradient(to top, ${gradient[0]} 0%, ${gradient[1]} 100%)`;

  // If a fixed height is given, use that; otherwise stretch to parent.
  const barAreaStyle = height != null ? { height } : undefined;
  const barAreaClass = height != null
    ? 'relative flex items-end gap-0.5'
    : 'relative flex items-end gap-0.5 flex-1 min-h-[140px]';

  return (
    <div className="w-full h-full flex flex-col">
      <div className={barAreaClass} style={barAreaStyle}>
        {/* Median marker — dashed line, positioned as % from bottom so it
            works for both fixed and flex heights. */}
        <div
          className="absolute left-0 right-0 border-t border-dashed border-border pointer-events-none"
          style={{ bottom: `${medianPct}%` }}
        >
          <span className="absolute -top-3 right-0 text-[10px] text-muted-foreground bg-card px-1">
            median {fmtVal(medianVal, valueFormat)}
          </span>
        </div>

        {sorted.map((v, i) => {
          const hPct = Math.max(2, (v / max) * 100);
          return (
            <div
              key={i}
              className="group relative flex-1 flex items-end min-w-0 h-full"
            >
              <div
                className="w-full rounded-sm transition-opacity group-hover:opacity-80"
                style={{ height: `${hPct}%`, background: bg }}
              />
              {/* Hover tooltip */}
              <div
                className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2
                           hidden group-hover:block z-20 whitespace-nowrap
                           rounded-md border bg-popover px-2.5 py-1.5 shadow-md text-xs"
              >
                <div className="font-semibold tabular-nums">
                  #{i + 1} · {fmtVal(v, valueFormat)}
                </div>
                <div className="text-muted-foreground">
                  {((v / max) * 100).toFixed(1)}% of #1
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Axis: rank-low → rank-high with min and max values */}
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums pt-1.5">
        <span>#1: <span className="font-semibold tabular-nums">{fmtVal(max, valueFormat)}</span></span>
        <span className="opacity-70">rank</span>
        <span>#{sorted.length}: <span className="font-semibold tabular-nums">{fmtVal(min, valueFormat)}</span></span>
      </div>
    </div>
  );
}
