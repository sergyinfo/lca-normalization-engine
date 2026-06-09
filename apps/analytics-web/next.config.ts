import type { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Standalone output gives us a self-contained .next/standalone directory
 * (server.js + minimal node_modules) suitable for `node server.js` on the
 * VPS — no `next start` runtime needed in the container.
 *
 * Data access uses the built-in `node:sqlite` module (Node 22.5+), so we
 * have no native deps to mark as external.
 *
 * `outputFileTracingRoot` is pinned to the monorepo root so Next's tracer
 * resolves workspace deps correctly when the app lives in apps/*. Without
 * this, the standalone output can miss files outside the app dir.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.join(__dirname, '..', '..');
const LCA_DB_PATH   = path.join(__dirname, 'data', 'lca.db');

/**
 * Pull the SEO redirect list from SQLite at build time. Next.js calls this
 * during `next build` and bakes the rules into the framework, so there is
 * no SQLite read in the runtime hot path — 301s are served by the edge.
 *
 * Defensive: tolerates a missing lca.db or a missing redirects table
 * (very-old snapshots) so the build never fails over this.
 */
// The forecast page lives at the year-agnostic /h1b-forecast. Any old year-stamped
// URL (e.g. /h1b-2026, /h1b-2027) 301s there so links never break on rollover.
const FORECAST_YEAR_REDIRECT = {
  source: '/h1b-:year(\\d{4})',
  destination: '/h1b-forecast',
  permanent: true,
};

async function loadRedirects() {
  if (!existsSync(LCA_DB_PATH)) {
    console.warn('[next.config] No lca.db at build time — skipping redirects');
    return [FORECAST_YEAR_REDIRECT];
  }
  try {
    const db = new DatabaseSync(LCA_DB_PATH, { readOnly: true });
    let rows: Array<{ source_path: string; target_path: string }> = [];
    try {
      rows = db.prepare('SELECT source_path, target_path FROM redirects').all() as typeof rows;
    } catch {
      // Table may not exist on snapshots predating the SEO redirect layer.
    }
    db.close();
    if (rows.length > 0) {
      console.log(`[next.config] Loaded ${rows.length} redirect rules from lca.db`);
    }
    return [
      FORECAST_YEAR_REDIRECT,
      ...rows.map((r) => ({
        source: r.source_path,
        destination: r.target_path,
        permanent: true,           // 301 Moved Permanently — preserves link equity
      })),
    ];
  } catch (err) {
    console.warn('[next.config] Failed to load redirects:', err);
    return [FORECAST_YEAR_REDIRECT];
  }
}

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: MONOREPO_ROOT,
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    mdxRs: true,
  },
  redirects: loadRedirects,
};

export default nextConfig;
