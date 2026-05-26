'use client';

/**
 * Diverging horizontal bar chart of YoY share change. Top-N states by
 * absolute |Δ share|, sorted descending → ascending (winners up top, losers
 * down bottom). Pure Recharts; themed via recharts-shared tokens.
 */
import {
  BarChart, Bar, XAxis, YAxis, Cell, Tooltip, ReferenceLine,
  ResponsiveContainer,
} from 'recharts';

import {
  TOOLTIP_CONTENT_STYLE, TOOLTIP_ITEM_STYLE, TOOLTIP_LABEL_STYLE,
  TOOLTIP_CURSOR_FILL,
} from './recharts-shared';

export interface MoverRow {
  /** 2-letter postal code, used as the y-axis label. */
  code: string;
  /** Full state name (in tooltip). */
  name: string;
  /** YoY share change, in percentage points (e.g. 4.2 means +4.2 pp). */
  deltaPct: number;
}

export interface BiggestMoversChartProps {
  data: ReadonlyArray<MoverRow>;
  height?: number;
}

export function BiggestMoversChart({ data, height = 360 }: BiggestMoversChartProps) {
  // Recharts wants a mutable array.
  const rows = [...data].sort((a, b) => b.deltaPct - a.deltaPct);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={rows}
        layout="vertical"
        margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
      >
        <XAxis
          type="number"
          tickFormatter={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`}
          tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
          axisLine={{ stroke: 'var(--color-border)' }}
          tickLine={{ stroke: 'var(--color-border)' }}
        />
        <YAxis
          type="category"
          dataKey="code"
          width={40}
          tick={{ fill: 'var(--color-foreground)', fontSize: 12, fontWeight: 600 }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_CONTENT_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
          cursor={{ fill: TOOLTIP_CURSOR_FILL, fillOpacity: 0.25 }}
          formatter={(value: number, _name, item) => {
            const row = item?.payload as MoverRow | undefined;
            const sign = value >= 0 ? '+' : '';
            return [`${sign}${value.toFixed(2)} pp`, row?.name ?? ''];
          }}
          labelFormatter={(label) => `${label}`}
        />
        <ReferenceLine x={0} stroke="var(--color-border)" />
        <Bar dataKey="deltaPct" radius={[0, 4, 4, 0]}>
          {rows.map((row) => (
            <Cell
              key={row.code}
              fill={row.deltaPct >= 0 ? 'var(--color-primary)' : 'var(--color-destructive)'}
              fillOpacity={0.85}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
