/**
 * API authentication + rate limiting wrapper.
 *
 * Usage in a route handler:
 *
 *   export const GET = withAuth(async (req, ctx) => {
 *     const { slug } = await ctx.params;
 *     return ok(...);
 *   });
 *
 * The wrapper:
 *   1. Extracts the API key from `Authorization: Bearer ...` or `X-API-Key`.
 *   2. SHA-256s it and looks up the active row in keys.db.
 *   3. Checks the in-process rolling-24h rate limit for the key's tier.
 *   4. Calls the handler, then merges X-RateLimit-* response headers.
 *
 * Rate limit storage is intentionally in-process (Map). On a single-VPS
 * deploy that's the right trade-off: zero infra, sub-µs cost per request,
 * and the worst case after a restart is a free user gets to start their
 * 100 req/day allowance over. For multi-instance scaling this would move
 * to Redis.
 */

import crypto from 'node:crypto';
import { findActiveByHash, type ApiKeyTier, type ApiKeyRow } from '../keys-db';
import { unauthorized, forbidden, rateLimited } from './responses';

/** Daily request budget by tier. */
const TIER_LIMITS: Record<ApiKeyTier, number> = {
  free:       100,
  pro:       10_000,
  enterprise: 1_000_000,
};

const WINDOW_MS = 24 * 60 * 60 * 1000;   // 24 h rolling window

interface Counter {
  count: number;
  windowStart: number;     // epoch ms
}

const COUNTERS = new Map<number, Counter>();

/** Hash a raw key with sha256, hex-encoded. Same on both write + read paths. */
export function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Parse `Authorization: Bearer …` or `X-API-Key: …`. Bearer wins if both set. */
function extractKey(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(\S+)$/i);
    if (m) return m[1];
  }
  const x = req.headers.get('x-api-key');
  if (x && x.trim()) return x.trim();
  return null;
}

/** Returns { allowed, remaining, resetSec }. Mutates the counter on allow. */
function checkAndIncrement(keyRow: ApiKeyRow): {
  allowed: boolean; limit: number; remaining: number; resetSec: number;
} {
  const limit = TIER_LIMITS[keyRow.tier];
  const now = Date.now();
  const existing = COUNTERS.get(keyRow.id);
  let counter: Counter;
  if (!existing || now - existing.windowStart >= WINDOW_MS) {
    counter = { count: 0, windowStart: now };
    COUNTERS.set(keyRow.id, counter);
  } else {
    counter = existing;
  }
  const resetSec = Math.max(0, Math.ceil((counter.windowStart + WINDOW_MS - now) / 1000));
  if (counter.count >= limit) {
    return { allowed: false, limit, remaining: 0, resetSec };
  }
  counter.count += 1;
  return { allowed: true, limit, remaining: limit - counter.count, resetSec };
}

export type AuthedHandler<Ctx = unknown> = (
  req: Request, ctx: Ctx & { keyRow: ApiKeyRow },
) => Promise<Response> | Response;

export function withAuth<Ctx>(handler: AuthedHandler<Ctx>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    const raw = extractKey(req);
    if (!raw) return unauthorized('Provide an API key via `Authorization: Bearer <key>` or `X-API-Key`.');

    const row = findActiveByHash(hashKey(raw));
    if (!row) return forbidden('Unknown or revoked API key.');

    const rl = checkAndIncrement(row);
    if (!rl.allowed) {
      const hh = Math.floor(rl.resetSec / 3600);
      const mm = Math.floor((rl.resetSec % 3600) / 60);
      return rateLimited(
        `Daily quota of ${rl.limit} requests exhausted. Resets in ${hh}h ${mm}m.`,
        rl.resetSec,
      );
    }

    const res = await handler(req, { ...ctx, keyRow: row });

    // Merge rate-limit headers onto the handler's response.
    res.headers.set('X-RateLimit-Limit',     String(rl.limit));
    res.headers.set('X-RateLimit-Remaining', String(rl.remaining));
    res.headers.set('X-RateLimit-Reset',     String(rl.resetSec));
    return res;
  };
}

/** OPTIONS handler for CORS preflight. Exported for use in every route file. */
export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':   '*',
      'Access-Control-Allow-Methods':  'GET, OPTIONS',
      'Access-Control-Allow-Headers':  'Authorization, X-API-Key, Content-Type',
      'Access-Control-Max-Age':        '86400',
    },
  });
}
