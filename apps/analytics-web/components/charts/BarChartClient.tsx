'use client';

/**
 * Generic horizontal or vertical bar chart. Tables on the same page carry
 * the canonical data for SEO; this is the visual layer that hydrates.
 */

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  TOOLTIP_CONTENT_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_ITEM_STYLE, TOOLTIP_CURSOR_FILL,
} from './recharts-shared';

export interface BarDatum {
  label: string;
  value: number;
}

type ValueFormat = 'number' | 'usd-short';

interface Props {
  data: BarDatum[];
  height?: number;
  horizontal?: boolean;
  color?: string;
  valueFormat?: ValueFormat;
}

export function BarChartClient({
  data, height = 280, horizontal = false, color = '#2563eb', valueFormat = 'number',
}: Props) {
  const fmt = valueFormat === 'usd-short'
    ? (n: number) => '$' + (n / 1000).toFixed(0) + 'k'
    : (n: number) => n.toLocaleString();
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'}
                  margin={{ top: 8, right: 8, bottom: 8, left: horizontal ? 100 : 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          {horizontal ? (
            <>
              <XAxis type="number" tickFormatter={fmt} fontSize={11} stroke="var(--color-muted-foreground)" />
              <YAxis type="category" dataKey="label" fontSize={11} stroke="var(--color-muted-foreground)" width={120} />
            </>
          ) : (
            <>
              <XAxis dataKey="label" fontSize={11} stroke="var(--color-muted-foreground)" interval={0} angle={-25} textAnchor="end" height={60} />
              <YAxis tickFormatter={fmt} fontSize={11} stroke="var(--color-muted-foreground)" />
            </>
          )}
          <Tooltip
            formatter={(v: number) => [fmt(v), 'Value']}
            cursor={{ fill: TOOLTIP_CURSOR_FILL, opacity: 0.4 }}
            contentStyle={TOOLTIP_CONTENT_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            itemStyle={TOOLTIP_ITEM_STYLE}
          />
          <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
