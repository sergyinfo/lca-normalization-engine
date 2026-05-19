import type { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: MONOREPO_ROOT,
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    mdxRs: true,
  },
};

export default nextConfig;
