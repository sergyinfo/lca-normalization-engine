/**
 * robots.txt. Default policy: allow everything, point at the sitemap.
 * The B2B API endpoints are noindexed (no value to Google) but stay
 * accessible to programmatic clients.
 */

import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',          // B2B endpoints, not for Google
          '/_next/',        // build assets (Next handles this already, but explicit)
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
