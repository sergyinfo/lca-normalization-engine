/**
 * Horizontal bar chart — pure HTML/CSS grid. No SVG, no client JS.
 *
 * Each row has a CSS-only hover tooltip that pops out of the bar showing
 * label · value · percentage of leader. Hover state also subtly highlights
 * the row so users get the affordance.
 */

import { fmt as fmtNum } from '@/lib/format';

export interface HBarDatum {
  label: string;
  value: number;
  /** Optional secondary text shown after the value (e.g. state code). */
  hint?: string;
}

type ValueFormat = 'number' | 'usd-short' | 'pct';

interface Props {
  data: HBarDatum[];
  labelWidth?: number;
  rowHeight?: number;
  valueFormat?: ValueFormat;
  gradient?: [string, string];
}

function fmtVal(n: number, f: ValueFormat): string {
  if (f === 'usd-short') return '$' + Math.round(n / 1000).toLocaleString() + 'k';
  if (f === 'pct')       return n.toFixed(1) + '%';
  return fmtNum(n);
}

export function HorizontalBarSvg({
  data,
  labelWidth = 160,
  rowHeight = 28,
  valueFormat = 'number',
  gradient = ['hsl(217 91% 55%)', 'hsl(190 95% 50%)'],
}: Props) {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">No data.</p>;
  }
  const max = Math.max(...data.map((d) => d.value), 1);
  const bg = `linear-gradient(90deg, ${gradient[0]} 0%, ${gradient[1]} 100%)`;
  return (
    <div className="w-full">
      {data.map((d, i) => {
        const pct = Math.max(0.6, (d.value / max) * 100);
        const pctOfLeader = (d.value / max) * 100;
        return (
          <div
            key={i}
            className="group flex items-center gap-3 rounded-sm px-1 -mx-1
                       transition-colors hover:bg-muted/40"
            style={{ height: rowHeight }}
          >
            {/* Label */}
            <div
              className="text-xs text-right text-foreground/85 truncate shrink-0"
              style={{ width: labelWidth }}
              title={d.label}
            >
              {d.label}
            </div>

            {/* Bar track + fill + tooltip anchor */}
            <div className="flex-1 min-w-0 relative">
              <div
                className="rounded-full bg-muted"
                style={{ height: 10 }}
              />
              <div
                className="absolute top-0 left-0 rounded-full shadow-sm
                           transition-all group-hover:brightness-110"
                style={{
                  width: `${pct}%`,
                  height: 10,
                  background: bg,
                }}
              />
              {/* Hover tooltip */}
              <div
                className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2
                           hidden group-hover:block z-20 whitespace-nowrap
                           rounded-md border bg-popover px-3 py-2 shadow-md text-xs"
              >
                <div className="font-semibold text-foreground">{d.label}</div>
                <div className="text-muted-foreground mt-0.5">
                  <span className="tabular-nums text-foreground/85 font-medium">
                    {fmtVal(d.value, valueFormat)}
                  </span>
                  {d.hint ? ` · ${d.hint}` : ''}
                  <span className="ml-2 opacity-70">
                    {pctOfLeader.toFixed(1)}% of leader
                  </span>
                </div>
              </div>
            </div>

            {/* Value */}
            <div
              className="text-xs font-semibold tabular-nums text-foreground/85 shrink-0 text-right"
              style={{ minWidth: 96 }}
            >
              {fmtVal(d.value, valueFormat)}
              {d.hint ? (
                <span className="text-muted-foreground font-normal"> · {d.hint}</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
