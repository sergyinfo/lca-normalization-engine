'use client';

/**
 * Compact horizontal bar chart for the home page — "Median wage across
 * top occupations". Lifts visual richness on the home without needing a
 * full entity page click-through.
 */

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from 'recharts';
import {
  TOOLTIP_CONTENT_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_ITEM_STYLE, TOOLTIP_CURSOR_FILL,
} from './recharts-shared';

export interface HomeWageDatum {
  label: string;
  value: number;
}

export function HomeWageChartClient({ data }: { data: HomeWageDatum[] }) {
  const max = Math.max(...data.map((d) => d.value));
  const fmtAxis = (n: number) => '$' + Math.round(n / 1000) + 'k';
  const fmtTip  = (n: number) => '$' + Number(n).toLocaleString();
  return (
    <div style={{ width: '100%', height: 360 }}>
      <ResponsiveContainer>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 24, bottom: 4, left: 12 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
          <XAxis type="number" tickFormatter={fmtAxis} fontSize={11} stroke="var(--color-muted-foreground)" />
          <YAxis
            type="category"
            dataKey="label"
            fontSize={12}
            stroke="var(--color-muted-foreground)"
            width={210}
            tick={{ fill: 'var(--color-foreground)' }}
          />
          <Tooltip
            formatter={(v: number) => [fmtTip(v), 'Median wage']}
            cursor={{ fill: TOOLTIP_CURSOR_FILL, opacity: 0.4 }}
            contentStyle={TOOLTIP_CONTENT_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            itemStyle={TOOLTIP_ITEM_STYLE}
          />
          <defs>
            <linearGradient id="homewage-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor="hsl(160 84% 39%)" />
              <stop offset="50%"  stopColor="hsl(217 91% 55%)" />
              <stop offset="100%" stopColor="hsl(262 83% 62%)" />
            </linearGradient>
          </defs>
          <Bar dataKey="value" radius={[0, 4, 4, 0]} fill="url(#homewage-grad)">
            {data.map((_, i) => (
              <Cell key={i} fill="url(#homewage-grad)" />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
