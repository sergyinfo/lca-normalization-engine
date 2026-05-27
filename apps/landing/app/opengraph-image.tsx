import { ImageResponse } from 'next/og';

export const dynamic = 'force-static';
export const alt = 'h1b.report — H-1B salaries & employer database';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OG() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 80,
          background: '#0b0d10',
          color: '#e7ecf3',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        }}
      >
        <div style={{ display: 'flex', fontSize: 32, fontWeight: 600, color: '#9aa6b8' }}>
          <span>h1b</span>
          <span style={{ color: '#f6c344' }}>.report</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 84, fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.02em' }}>
            Every H-1B salary,
          </div>
          <div style={{ display: 'flex', fontSize: 84, fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.02em' }}>
            every sponsoring employer,
          </div>
          <div style={{ display: 'flex', fontSize: 84, fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.02em', color: '#f6c344' }}>
            one fast search.
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 24, color: '#5e6a7e' }}>
          <span>12M+ certified LCAs &middot; 2002 — present</span>
          <span>Launching late 2026</span>
        </div>
      </div>
    ),
    size,
  );
}
