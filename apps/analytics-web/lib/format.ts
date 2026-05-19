/**
 * Display formatting helpers. All return strings ready to drop into JSX.
 * Numbers come out of SQLite as `number | bigint | null`; these handle all
 * three uniformly so pages don't need defensive guards everywhere.
 */

export function fmt(n: number | bigint | null | undefined): string {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

export function fmtUsd(n: number | bigint | null | undefined): string {
  if (n == null) return '—';
  return `$${Number(n).toLocaleString('en-US')}`;
}

export function fmtUsdShort(n: number | bigint | null | undefined): string {
  if (n == null) return '—';
  const v = Number(n);
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${Math.round(v / 1000)}k`;
  return `$${v}`;
}

export function fmtPct(n: number | bigint | null | undefined, digits = 1): string {
  if (n == null) return '—';
  return `${Number(n).toFixed(digits)}%`;
}

export function fmtFy(year: number | null | undefined): string {
  if (year == null) return '—';
  return `FY${year}`;
}
