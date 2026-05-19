/**
 * JSON response helpers for the B2B API.
 *
 * Standard envelope:
 *   { "data": ..., "meta": {...} }
 * Error envelope:
 *   { "error": { "code": "...", "message": "..." } }
 *
 * All responses include CORS headers and a short cache-control so an
 * upstream CDN can absorb burst traffic.
 */

const COMMON_HEADERS: Record<string, string> = {
  'Content-Type':                  'application/json; charset=utf-8',
  'Access-Control-Allow-Origin':   '*',
  'Access-Control-Allow-Methods':  'GET, OPTIONS',
  'Access-Control-Allow-Headers':  'Authorization, X-API-Key, Content-Type',
  'Access-Control-Expose-Headers': 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
};

export function ok<T>(data: T, meta: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ data, meta }), {
    status: 200,
    headers: {
      ...COMMON_HEADERS,
      // 5 min CDN cache — data only updates quarterly, but keep TTL short
      // so revoked keys recover quickly.
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      ...extraHeaders,
    },
  });
}

export function err(
  code: string,
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { ...COMMON_HEADERS, 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

export const unauthorized   = (msg = 'Missing or invalid API key.')      => err('unauthorized',     msg, 401);
export const forbidden      = (msg = 'API key has been revoked.')        => err('forbidden',        msg, 403);
export const notFound       = (msg = 'Resource not found.')              => err('not_found',        msg, 404);
export const rateLimited    = (msg: string, resetSec: number)            => err('rate_limit_exceeded', msg, 429, {
  'Retry-After': String(resetSec),
});
