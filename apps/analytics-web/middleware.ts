import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { FEATURES } from '@/lib/features';

/**
 * Gate every /api/* route behind the `api` feature flag. When the flag is
 * off, requests to /api/v1/* return a JSON 404 and /api/docs is delegated
 * to the page-level notFound() (still rendered through Next's 404 page).
 */
export function middleware(req: NextRequest) {
  if (FEATURES.api) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/api/v1/')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
