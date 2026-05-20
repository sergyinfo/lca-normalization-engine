/**
 * Tiny inline trend SVG, rendered on the server. No client JS, no axes,
 * no tooltip — just a glanceable shape. Drop into a table cell to make
 * every row carry a yearly-trend signal.
 *
 * Values length is treated as evenly spaced points. Nulls = missing year;
 * the path simply skips them.
 */

export interface SparklineProps {
  values: Array<number | null>;
  width?: number;
  height?: number;
  /** Stroke colour. Defaults to the site primary. */
  color?: string;
  /** Show a soft area fill under the line. */
  fill?: boolean;
  /** Render endpoints as dots. */
  endpoints?: boolean;
}

export function Sparkline({
  values, width = 100, height = 28, color = 'hsl(217 91% 55%)',
  fill = true, endpoints = true,
}: SparklineProps) {
  const pts = values.map((v, i) => ({ v, i }));
  const real = pts.filter((p): p is { v: number; i: number } => p.v != null && Number.isFinite(p.v));
  if (real.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2}
              stroke="var(--color-border)" strokeWidth={1} strokeDasharray="2 2" />
      </svg>
    );
  }

  const max  = Math.max(...real.map((p) => p.v));
  const min  = Math.min(...real.map((p) => p.v));
  const span = max - min || 1;
  const stepX = (width - 2) / Math.max(1, values.length - 1);

  const xy = (i: number, v: number) => {
    const x = 1 + i * stepX;
    const y = 1 + (height - 2) * (1 - (v - min) / span);
    return [x, y] as const;
  };

  // Build a path that breaks on null gaps.
  let d = '';
  let prevValid = false;
  for (const p of pts) {
    if (p.v == null) { prevValid = false; continue; }
    const [x, y] = xy(p.i, p.v);
    d += `${prevValid ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
    prevValid = true;
  }

  // Area-fill path: drop down to baseline at start/end of each segment.
  let areaD = '';
  if (fill) {
    let segStart: number | null = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      if (p.v == null) {
        if (segStart != null) {
          const last = pts[i - 1]!;
          areaD += `L${xy(last.i, last.v as number)[0].toFixed(1)},${(height - 1).toFixed(1)} `;
          areaD += `Z `;
          segStart = null;
        }
        continue;
      }
      const [x, y] = xy(p.i, p.v);
      if (segStart == null) {
        areaD += `M${x.toFixed(1)},${(height - 1).toFixed(1)} `;
        areaD += `L${x.toFixed(1)},${y.toFixed(1)} `;
        segStart = i;
      } else {
        areaD += `L${x.toFixed(1)},${y.toFixed(1)} `;
      }
      if (i === pts.length - 1 && segStart != null) {
        areaD += `L${x.toFixed(1)},${(height - 1).toFixed(1)} Z `;
      }
    }
  }

  const first = real[0]!;
  const last  = real[real.length - 1]!;
  const [fx, fy] = xy(first.i, first.v);
  const [lx, ly] = xy(last.i,  last.v);

  return (
    <svg width={width} height={height} aria-hidden="true" style={{ display: 'block' }}>
      {fill ? <path d={areaD} fill={color} fillOpacity={0.12} /> : null}
      <path d={d} fill="none" stroke={color} strokeWidth={1.5}
            strokeLinecap="round" strokeLinejoin="round" />
      {endpoints ? (
        <>
          <circle cx={fx} cy={fy} r={1.6} fill={color} opacity={0.4} />
          <circle cx={lx} cy={ly} r={2}   fill={color} />
        </>
      ) : null}
    </svg>
  );
}
