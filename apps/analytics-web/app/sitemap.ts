/**
 * Sitemap generator. Emits every URL Google should know about: the home
 * page, the four list pages, and every prebuilt entity page.
 *
 * Pulled from SQLite at build time, so the sitemap reflects whatever the
 * current top-N slice is. No external config — adding more entities to
 * lca.db automatically expands the sitemap.
 *
 * Sitemap size cap is 50k URLs / 50 MB per file. The launch slice is ~150
 * URLs, so we're nowhere near needing a sitemap index file.
 */

import type { MetadataRoute } from 'next';
import {
  listAllEmployerSlugs, listAllOccupationSlugs,
  listAllStateSlugs, listAllSectorSlugs,
} from '@/lib/queries';
import { SITE_URL } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  // Data refresh is quarterly; tell Google the entire surface was rebuilt
  // at this build time. Per-entity lastmod would be more precise once we
  // surface a generated_at column at the entity level.
  const lastModified = new Date();
  const url = (path: string) => `${SITE_URL}${path}`;

  const fixed: MetadataRoute.Sitemap = [
    { url: url('/'),                          lastModified, changeFrequency: 'weekly',  priority: 1.0 },
    { url: url('/employer'),                  lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: url('/occupation'),                lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: url('/state'),                     lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: url('/sector'),                    lastModified, changeFrequency: 'monthly', priority: 0.8 },
    // Ranking landing pages — high-traffic SEO targets.
    { url: url('/rankings'),                  lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: url('/top-h1b-sponsors'),          lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: url('/top-h1b-occupations'),       lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: url('/highest-paying-h1b-jobs'),   lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: url('/top-h1b-states'),            lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: url('/h1b-by-industry'),           lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: url('/cleanest-h1b-sponsors'),     lastModified, changeFrequency: 'monthly', priority: 0.9 },
  ];

  const employers   = listAllEmployerSlugs().map((slug) => ({
    url: url(`/employer/${slug}`),   lastModified, changeFrequency: 'monthly' as const, priority: 0.7,
  }));
  const occupations = listAllOccupationSlugs().map((slug) => ({
    url: url(`/occupation/${slug}`), lastModified, changeFrequency: 'monthly' as const, priority: 0.7,
  }));
  const states      = listAllStateSlugs().map((slug) => ({
    url: url(`/state/${slug}`),      lastModified, changeFrequency: 'monthly' as const, priority: 0.6,
  }));
  const sectors     = listAllSectorSlugs().map((slug) => ({
    url: url(`/sector/${slug}`),     lastModified, changeFrequency: 'monthly' as const, priority: 0.6,
  }));

  return [...fixed, ...employers, ...occupations, ...states, ...sectors];
}
