/**
 * SEO helpers. Builds canonical metadata and JSON-LD structured data
 * blocks that ship per entity page. The JSON-LD payloads are stringified
 * and injected via a <script type="application/ld+json"> tag.
 */

import type { Metadata } from 'next';
import type { EmployerRow, OccupationRow, StateRow, SectorRow } from './queries';
import { SITE_NAME, SITE_URL } from './site';

export function entityMetadata({
  title, description, path: urlPath,
}: { title: string; description: string; path: string }): Metadata {
  return {
    title,
    description,
    alternates: { canonical: urlPath },
    openGraph: { title, description, url: `${SITE_URL}${urlPath}`, type: 'article' },
    twitter:   { title, description, card: 'summary_large_image' },
  };
}

/* -------------------------------------------------------------------------- */
/* JSON-LD builders                                                           */
/* -------------------------------------------------------------------------- */

export function organizationJsonLd(e: EmployerRow, url: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: e.canonical_name,
    address: e.employer_state
      ? { '@type': 'PostalAddress', addressRegion: e.employer_state, addressCountry: 'US' }
      : undefined,
    url,
    identifier: e.fein ? { '@type': 'PropertyValue', propertyID: 'FEIN', value: e.fein } : undefined,
    description: `${e.canonical_name} has filed ${e.filings.toLocaleString()} H-1B Labor Condition Applications with the US Department of Labor.`,
  };
}

export function occupationJsonLd(o: OccupationRow, url: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Occupation',
    name: o.soc_title ?? o.soc_code,
    occupationalCategory: o.soc_code,
    estimatedSalary: o.p50_wage
      ? {
          '@type': 'MonetaryAmountDistribution',
          name: 'H-1B prevailing wage distribution',
          currency: 'USD',
          duration: 'P1Y',
          percentile25: o.p25_wage,
          median:       o.p50_wage,
          percentile75: o.p75_wage,
        }
      : undefined,
    url,
  };
}

export function placeJsonLd(s: StateRow, url: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'AdministrativeArea',
    name: s.name,
    containedInPlace: { '@type': 'Country', name: 'United States' },
    url,
  };
}

export function datasetJsonLd(url: string, description: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `${SITE_NAME} — H-1B / LCA data`,
    description,
    url,
    keywords: ['H-1B', 'LCA', 'Labor Condition Application', 'visa sponsorship', 'prevailing wage'],
    creator: { '@type': 'Organization', name: SITE_NAME },
    isAccessibleForFree: true,
    license: 'https://creativecommons.org/publicdomain/zero/1.0/',
  };
}

/** ItemList JSON-LD. Marks a ranked list of entities for Google's rich
 *  results. Position is 1-based. URLs should be absolute. */
export function itemListJsonLd(items: Array<{ url: string; name: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListOrder: 'https://schema.org/ItemListOrderDescending',
    numberOfItems: items.length,
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: it.url,
      name: it.name,
    })),
  };
}

/** WebSite JSON-LD with a SearchAction. Makes the site eligible for the
 *  Google sitelinks search box in the SERP. */
export function websiteJsonLd(url: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${url}/search?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}
