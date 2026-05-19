'use client';

/**
 * P25 / P50 / P75 ribbon over years. The lighter outer band is the
 * inter-quartile range; the inner solid line is the median. Communicates
 * dispersion in one glance — much richer than a single median line.
 */

import {
  Area, ComposedChart, CartesianGrid, Legend, Line,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

export interface AreaBandDatum {
  label: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
}

interface Props {
  data: AreaBandDatum[];
  height?: number;
  color?: string;
}

export function AreaBandChartClient({
  data, height = 280, color = 'hsl(217 91% 55%)',
}: Props) {
  const fmt = (n: number) => '$' + (n / 1000).toFixed(0) + 'k';
  const fmtTip = (n: number) => '$' + Number(n).toLocaleString();

  // Recharts area expects a numeric range — we pass [p25, p75] as a
  // two-element array so it fills the band; nulls are skipped.
  const enriched = data.map((d) => ({
    label: d.label,
    range: d.p25 != null && d.p75 != null ? [d.p25, d.p75] : undefined,
    p50: d.p50,
  }));

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <ComposedChart data={enriched} margin={{ top: 12, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="label" fontSize={11} stroke="#64748b" />
          <YAxis tickFormatter={fmt} fontSize={11} stroke="#64748b" />
          <Tooltip
            formatter={(v: number | [number, number], name: string) => {
              if (Array.isArray(v)) return [`${fmtTip(v[0])} – ${fmtTip(v[1])}`, 'P25–P75'];
              return [fmtTip(v), name];
            }}
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area
            type="monotone"
            dataKey="range"
            name="P25–P75"
            stroke="none"
            fill={color}
            fillOpacity={0.18}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="p50"
            name="Median"
            stroke={color}
            strokeWidth={2.5}
            dot={{ r: 3, fill: color }}
            activeDot={{ r: 5 }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
