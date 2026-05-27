import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

const SITE = 'https://h1b.report';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${SITE}/`,              lastModified: now, changeFrequency: 'weekly',  priority: 1.0 },
    { url: `${SITE}/about/`,        lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${SITE}/methodology/`,  lastModified: now, changeFrequency: 'yearly',  priority: 0.7 },
  ];
}
