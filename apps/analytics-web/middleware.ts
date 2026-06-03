import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { FEATURES } from '@/lib/features';

/**
 * Two jobs:
 *
 * 1. Origin verification. The app is served from a public Lambda Function URL
 *    fronted by CloudFront. CloudFront injects a shared secret header
 *    (`x-origin-verify`); requests that hit the Function URL directly (bypassing
 *    CloudFront) won't have it. When ORIGIN_VERIFY_SECRET is set we require a
 *    match and 403 otherwise. When it's unset (local dev, or before the secret
 *    is wired) the check is skipped — it fails OPEN so a misconfiguration can
 *    never take the site down.
 *
 * 2. Gate every /api/* route behind the `api` feature flag (unchanged).
 */
const ORIGIN_SECRET = process.env.ORIGIN_VERIFY_SECRET;

export function middleware(req: NextRequest) {
  if (ORIGIN_SECRET && req.headers.get('x-origin-verify') !== ORIGIN_SECRET) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  if (!FEATURES.api && req.nextUrl.pathname.startsWith('/api/v1/')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  // Run on every Lambda-served route. Next internals + static files are served
  // from S3/CloudFront and never reach the Lambda, so they're excluded.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
