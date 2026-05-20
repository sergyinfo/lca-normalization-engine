/**
 * Shared Recharts styling — Recharts injects inline styles directly on its
 * Tooltip/Axis DOM, bypassing Tailwind. We point it at CSS variables instead
 * so the tooltip flips with our theme tokens automatically.
 */

export const TOOLTIP_CONTENT_STYLE: React.CSSProperties = {
  fontSize: 12,
  borderRadius: 8,
  backgroundColor: 'var(--color-popover)',
  color: 'var(--color-popover-foreground)',
  border: '1px solid var(--color-border)',
  boxShadow: '0 4px 12px rgba(0 0 0 / 0.08)',
};

export const TOOLTIP_LABEL_STYLE: React.CSSProperties = {
  color: 'var(--color-foreground)',
  fontWeight: 600,
};

export const TOOLTIP_ITEM_STYLE: React.CSSProperties = {
  color: 'var(--color-foreground)',
};

export const TOOLTIP_CURSOR_FILL = 'var(--color-muted)';
