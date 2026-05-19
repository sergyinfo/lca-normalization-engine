/**
 * Compact 100%-stacked horizontal bar with inline legend. Server-rendered.
 *
 * Designed for outcome breakdowns ("85% certified · 10% withdrawn · 5%
 * denied") where a full donut chart would be a wasteful 300px-tall card.
 */

export interface StackSlice {
  label: string;
  value: number;
  color: string;
}

interface Props {
  slices: StackSlice[];
  /** Bar height in px. */
  height?: number;
  /** Show "label NN.N%" tags under the bar. Defaults true. */
  showLegend?: boolean;
}

export function StackedBarSvg({ slices, height = 22, showLegend = true }: Props) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className="space-y-3">
      <div
        className="flex w-full overflow-hidden"
        style={{ height, borderRadius: height / 2 }}
        aria-label="100% stacked outcome bar"
      >
        {slices.map((s, i) => {
          const pct = (s.value / total) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={i}
              title={`${s.label}: ${pct.toFixed(1)}%`}
              style={{
                width: `${pct}%`,
                background: s.color,
              }}
            />
          );
        })}
      </div>
      {showLegend ? (
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
          {slices.map((s, i) => {
            const pct = (s.value / total) * 100;
            return (
              <div key={i} className="inline-flex items-center gap-2">
                <span
                  className="inline-block size-2.5 rounded-sm"
                  style={{ background: s.color }}
                />
                <span className="text-muted-foreground">{s.label}</span>
                <span className="font-semibold tabular-nums">{pct.toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
