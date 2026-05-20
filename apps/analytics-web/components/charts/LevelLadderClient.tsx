'use client';

/**
 * Wage-level ladder — P25/P50/P75 grouped bars per PW_WAGE_LEVEL.
 * Used on /occupation/[soc] to visualise the entry→senior salary runway.
 */

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  TOOLTIP_CONTENT_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_ITEM_STYLE, TOOLTIP_CURSOR_FILL,
} from './recharts-shared';

export interface LevelDatum {
  level: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
}

interface Props {
  data: LevelDatum[];
  height?: number;
}

export function LevelLadderClient({ data, height = 280 }: Props) {
  const fmt = (n: number) => '$' + (n / 1000).toFixed(0) + 'k';
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="level" fontSize={12} stroke="var(--color-muted-foreground)" />
          <YAxis tickFormatter={fmt} fontSize={11} stroke="var(--color-muted-foreground)" />
          <Tooltip
            formatter={(v: number, name: string) => ['$' + Number(v).toLocaleString(), name]}
            cursor={{ fill: TOOLTIP_CURSOR_FILL, opacity: 0.4 }}
            contentStyle={TOOLTIP_CONTENT_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            itemStyle={TOOLTIP_ITEM_STYLE}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="p25" name="P25" fill="#93c5fd" radius={[3, 3, 0, 0]} />
          <Bar dataKey="p50" name="Median" fill="#2563eb" radius={[3, 3, 0, 0]} />
          <Bar dataKey="p75" name="P75" fill="#1d4ed8" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
