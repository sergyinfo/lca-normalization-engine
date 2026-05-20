/**
 * Inline proportional bar, rendered server-side as a single SVG. Drop into
 * a table cell next to a number to make the magnitude visually obvious.
 *
 * No 'use client' — zero hydration cost. Pass the row's value plus the
 * column max so the bar widths render in proportion.
 */

interface MiniBarProps {
  value: number;
  max: number;
  width?: number;
  height?: number;
  color?: string;
}

export function MiniBar({
  value, max, width = 80, height = 6, color = 'hsl(217 91% 55%)',
}: MiniBarProps) {
  const ratio = max > 0 ? Math.max(0.02, Math.min(1, value / max)) : 0;
  const w = Math.round(width * ratio);
  return (
    <svg
      width={width}
      height={height}
      aria-hidden="true"
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      <rect x={0} y={0} width={width} height={height} rx={height / 2}
            fill="var(--color-muted)" />
      <rect x={0} y={0} width={w} height={height} rx={height / 2} fill={color} />
    </svg>
  );
}
