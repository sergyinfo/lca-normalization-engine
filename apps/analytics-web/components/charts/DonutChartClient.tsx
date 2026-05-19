'use client';

/**
 * Donut chart, vertical layout: donut on top, legend in a multi-column
 * grid below. Side-by-side legend kept truncating long sector / outcome
 * labels to one or two characters on narrow cards — vertical stacking
 * gives every label the full card width to render.
 */

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

export interface DonutDatum {
  label: string;
  value: number;
  color?: string;
}

type ValueFormat = 'number' | 'pct';

interface Props {
  data: DonutDatum[];
  /** Donut SVG size (square). Defaults 200. */
  size?: number;
  centerLabel?: string;
  centerValue?: string;
  valueFormat?: ValueFormat;
}

const PALETTE = [
  'hsl(217 91% 55%)',  // primary blue
  'hsl(190 95% 50%)',  // cyan
  'hsl(262 83% 62%)',  // violet
  'hsl(38  92% 50%)',  // amber
  'hsl(330 81% 60%)',  // pink
  'hsl(160 84% 39%)',  // emerald
  'hsl(20  91% 55%)',  // orange-red
  'hsl(220 14% 70%)',  // slate (other)
];

export function DonutChartClient({
  data, size = 200, centerLabel, centerValue, valueFormat = 'number',
}: Props) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const fmt = (n: number) => valueFormat === 'pct'
    ? `${n.toFixed(1)}%`
    : n.toLocaleString();

  return (
    <div className="flex flex-col items-center gap-5">
      {/* Donut */}
      <div className="relative" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={1.5}
              stroke="white"
              strokeWidth={2}
            >
              {data.map((d, i) => (
                <Cell key={i} fill={d.color ?? PALETTE[i % PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(v: number, name: string) => {
                const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0';
                return [`${fmt(v)} (${pct}%)`, name];
              }}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
            />
          </PieChart>
        </ResponsiveContainer>
        {centerValue ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            {centerLabel ? (
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {centerLabel}
              </div>
            ) : null}
            <div className="text-lg font-bold tabular-nums leading-tight">{centerValue}</div>
          </div>
        ) : null}
      </div>

      {/* Legend — multi-column grid so labels never get clipped. */}
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm w-full">
        {data.map((d, i) => {
          const pct = total > 0 ? ((d.value / total) * 100).toFixed(1) : '0';
          const color = d.color ?? PALETTE[i % PALETTE.length];
          return (
            <li key={i} className="flex items-center gap-2.5 min-w-0">
              <span
                className="inline-block size-2.5 rounded-sm flex-shrink-0"
                style={{ background: color }}
              />
              <span className="flex-1 truncate text-foreground/85" title={d.label}>
                {d.label}
              </span>
              <span className="font-semibold tabular-nums text-xs text-muted-foreground">
                {pct}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
