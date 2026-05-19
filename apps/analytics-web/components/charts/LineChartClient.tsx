'use client';

/**
 * Time-series line chart. Suited to per-year metrics (filings, median wage).
 */

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface LineDatum {
  label: string;
  value: number | null;
}

type ValueFormat = 'number' | 'usd-short';

interface Props {
  data: LineDatum[];
  height?: number;
  color?: string;
  /** Serialisable format selector — functions can't cross the RSC boundary. */
  valueFormat?: ValueFormat;
}

export function LineChartClient({
  data, height = 260, color = '#2563eb', valueFormat = 'number',
}: Props) {
  const fmt = valueFormat === 'usd-short'
    ? (n: number) => '$' + (n / 1000).toFixed(0) + 'k'
    : (n: number) => n.toLocaleString();
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="label" fontSize={11} stroke="#64748b" />
          <YAxis tickFormatter={fmt} fontSize={11} stroke="#64748b" />
          <Tooltip formatter={(v: number) => [fmt(v), 'Value']} contentStyle={{ fontSize: 12 }} />
          <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2}
                fill={color} fillOpacity={0.12} connectNulls />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
