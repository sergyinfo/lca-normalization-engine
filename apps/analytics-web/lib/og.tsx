/**
 * Shared layout for per-entity Open Graph cards.
 *
 * Each entity route's opengraph-image.tsx looks up the entity row, picks an
 * eyebrow / title / stat to surface, and passes them to renderEntityOg().
 * That keeps the four entity-specific files trivial.
 *
 * The bottom strip is a watermark with site name + URL (driven by lib/site.ts),
 * so even cropped social shares carry attribution.
 *
 * Constraints (next/og):
 *   - flexbox-only CSS (no `display: block`, no `display: grid`)
 *   - inline styles only
 *   - no external fonts unless you ship them via fetch() in this file
 */

import { ImageResponse } from 'next/og';
import { SITE_NAME, SITE_HOST } from './site';

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = 'image/png';

export interface EntityOgProps {
  eyebrow: string;        // e.g. "H-1B Sponsor", "Occupation 15-1252", "State"
  title: string;          // entity name
  stats: Array<{ label: string; value: string }>;  // 2-3 highlight metrics
  accent?: string;        // accent color hex
}

export function renderEntityOg({
  eyebrow, title, stats, accent = '#38bdf8',
}: EntityOgProps): ImageResponse {
  // Truncate the title to keep the layout stable — long canonical_name values
  // can exceed 80 chars and break the visual hierarchy.
  const safeTitle = title.length > 70 ? title.slice(0, 68) + '…' : title;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: '64px 80px',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #0f172a 100%)',
          color: '#f8fafc',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 22, color: accent, fontWeight: 600, letterSpacing: '0.06em', display: 'flex' }}>
          {eyebrow.toUpperCase()}
        </div>

        <div style={{
          fontSize: safeTitle.length > 40 ? 60 : 72,
          fontWeight: 700, marginTop: 14, lineHeight: 1.1, maxWidth: 1040,
          display: 'flex',
        }}>
          {safeTitle}
        </div>

        <div style={{ flex: 1, display: 'flex' }} />

        <div style={{ display: 'flex', gap: 64, alignItems: 'flex-end' }}>
          {stats.map((s) => (
            <div key={s.label} style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{
                fontSize: 16, color: '#94a3b8', textTransform: 'uppercase',
                letterSpacing: '0.06em', fontWeight: 600,
              }}>
                {s.label}
              </div>
              <div style={{
                fontSize: 56, fontWeight: 700, color: '#f8fafc', marginTop: 6, lineHeight: 1,
              }}>
                {s.value}
              </div>
            </div>
          ))}
        </div>

        {/* Watermark strip: brand + URL anchored to the bottom. */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12,
          marginTop: 32, paddingTop: 20, borderTop: '1px solid rgba(148,163,184,0.25)',
        }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#f8fafc' }}>{SITE_NAME}</div>
          <div style={{ fontSize: 18, color: '#94a3b8' }}>·</div>
          <div style={{ fontSize: 20, color: accent }}>{SITE_HOST}</div>
        </div>
      </div>
    ),
    { ...OG_SIZE },
  );
}
