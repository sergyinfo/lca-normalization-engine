/**
 * Default Open Graph card for the site (1200x630 PNG).
 *
 * Applied automatically by Next.js to any route that doesn't define its own
 * opengraph-image. Entity routes override with dynamic per-entity cards.
 *
 * Uses next/og's edge-style runtime; flexbox-only CSS, no external fonts.
 */

import { ImageResponse } from 'next/og';
import { SITE_NAME, SITE_HOST } from '@/lib/site';

export const alt = `${SITE_NAME} — H-1B & LCA data`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: '72px 80px',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
          color: '#f8fafc',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 28, color: '#38bdf8', fontWeight: 600, letterSpacing: '0.05em' }}>
          {SITE_NAME.toUpperCase()}
        </div>
        <div style={{
          fontSize: 72, fontWeight: 700, marginTop: 18, lineHeight: 1.1,
          maxWidth: 980, display: 'flex',
        }}>
          US H-1B &amp; LCA data, made readable
        </div>
        <div style={{
          fontSize: 26, color: '#cbd5e1', marginTop: 24, maxWidth: 1000, lineHeight: 1.4,
          display: 'flex',
        }}>
          Per-employer profiles, occupation salary guides, state breakdowns,
          denial-rate trends — built on DOL Labor Condition Application disclosures.
        </div>

        <div style={{ flex: 1 }} />

        {/* Watermark: brand + URL anchored to the bottom-right. */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
          paddingTop: 32, borderTop: '1px solid rgba(148,163,184,0.25)',
        }}>
          <div style={{ display: 'flex', gap: 24, fontSize: 20, color: '#94a3b8' }}>
            <span>FY2020–FY2025</span>
            <span>·</span>
            <span>3.8M filings</span>
            <span>·</span>
            <span>Free &amp; public</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            <div style={{ fontSize: 24, color: '#f8fafc', fontWeight: 700 }}>{SITE_NAME}</div>
            <div style={{ fontSize: 18, color: '#38bdf8', marginTop: 2 }}>{SITE_HOST}</div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
