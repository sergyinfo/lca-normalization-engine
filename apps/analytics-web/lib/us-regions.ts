/**
 * US Census Bureau standard regions for the four-region filter on /state.
 * Territories (PR, GU, VI, AS, MP) bundled as "Territories" so they're
 * filterable but don't clutter the four-region chips.
 */

export type Region = 'Northeast' | 'South' | 'Midwest' | 'West' | 'Territories';

export const REGIONS: readonly Region[] = [
  'Northeast', 'South', 'Midwest', 'West', 'Territories',
];

const REGION_STATES: Record<Region, readonly string[]> = {
  Northeast: ['CT', 'ME', 'MA', 'NH', 'NJ', 'NY', 'PA', 'RI', 'VT'],
  South: [
    'AL', 'AR', 'DC', 'DE', 'FL', 'GA', 'KY', 'LA', 'MD', 'MS', 'NC', 'OK',
    'SC', 'TN', 'TX', 'VA', 'WV',
  ],
  Midwest: ['IL', 'IN', 'IA', 'KS', 'MI', 'MN', 'MO', 'NE', 'ND', 'OH', 'SD', 'WI'],
  West: [
    'AK', 'AZ', 'CA', 'CO', 'HI', 'ID', 'MT', 'NV', 'NM', 'OR', 'UT', 'WA', 'WY',
  ],
  Territories: ['PR', 'GU', 'VI', 'AS', 'MP'],
};

/** Inverse index: state code → region. */
export const STATE_TO_REGION: Readonly<Record<string, Region>> = (() => {
  const out: Record<string, Region> = {};
  for (const region of REGIONS) {
    for (const code of REGION_STATES[region]) out[code] = region;
  }
  return out;
})();

export function regionOf(code: string): Region | null {
  return STATE_TO_REGION[code] ?? null;
}

export function statesInRegion(region: Region): readonly string[] {
  return REGION_STATES[region];
}
