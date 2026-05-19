/**
 * Slugify utility — used by the build script to turn canonical employer
 * names ("Cognizant Technology Solutions US Corp.") into URL slugs
 * ("cognizant-technology-solutions-us-corp"). Kept here in /lib so the
 * runtime app can also slugify user input if we later add fuzzy search.
 */

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // strip diacritics
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')          // collapse non-alphanumerics to dashes
    .replace(/^-+|-+$/g, '')              // trim leading/trailing dashes
    .replace(/-{2,}/g, '-')               // collapse runs
    .slice(0, 80);                         // sane URL length cap
}

export function stateNameFromCode(code: string): string {
  return STATE_NAMES[code.toUpperCase()] ?? code;
}

/* -------------------------------------------------------------------------- */
/* SEO slug builders                                                          */
/*                                                                            */
/* Title comes first (primary ranking signal), short stable code goes at the  */
/* tail so a single URL works as both a human-readable label and a stable     */
/* deterministic key:                                                         */
/*   /occupation/software-developers-15-1252                                  */
/*   /state/new-hampshire-nh                                                  */
/*   /sector/arts-entertainment-recreation-71                                 */
/* -------------------------------------------------------------------------- */

/**
 * Strip a known code suffix from a slug. Lets a route handler accept the
 * full SEO slug and recover the short canonical id.
 *   parseTrailingCode("software-developers-15-1252", /-(\d{2}-\d{4})$/) → "15-1252"
 */
export function parseTrailingCode(slug: string, pattern: RegExp): string | null {
  const m = slug.match(pattern);
  return m?.[1] ?? null;
}

export function toOccupationSlug(socCode: string, socTitle: string | null): string {
  const titlePart = socTitle ? slugify(socTitle) : '';
  return titlePart ? `${titlePart}-${socCode.toLowerCase()}` : socCode.toLowerCase();
}

export function toStateSlug(stateCode: string, stateName: string): string {
  const titlePart = slugify(stateName);
  const codePart  = stateCode.toLowerCase();
  return titlePart ? `${titlePart}-${codePart}` : codePart;
}

export function toSectorSlug(naics2: string, label: string): string {
  const titlePart = slugify(label);
  return titlePart ? `${titlePart}-${naics2}` : naics2;
}

const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama',       AK: 'Alaska',         AZ: 'Arizona',       AR: 'Arkansas',
  CA: 'California',    CO: 'Colorado',       CT: 'Connecticut',   DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',       GA: 'Georgia',        HI: 'Hawaii',        ID: 'Idaho',
  IL: 'Illinois',      IN: 'Indiana',        IA: 'Iowa',          KS: 'Kansas',
  KY: 'Kentucky',      LA: 'Louisiana',      ME: 'Maine',         MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan',       MN: 'Minnesota',     MS: 'Mississippi',
  MO: 'Missouri',      MT: 'Montana',        NE: 'Nebraska',      NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey',     NM: 'New Mexico',    NY: 'New York',
  NC: 'North Carolina',ND: 'North Dakota',   OH: 'Ohio',          OK: 'Oklahoma',
  OR: 'Oregon',        PA: 'Pennsylvania',   RI: 'Rhode Island',  SC: 'South Carolina',
  SD: 'South Dakota',  TN: 'Tennessee',      TX: 'Texas',         UT: 'Utah',
  VT: 'Vermont',       VA: 'Virginia',       WA: 'Washington',    WV: 'West Virginia',
  WI: 'Wisconsin',     WY: 'Wyoming',        PR: 'Puerto Rico',   VI: 'Virgin Islands',
};

export const NAICS_LABELS: Record<string, string> = {
  '11': 'Agriculture, Forestry, Fishing & Hunting',
  '21': 'Mining, Quarrying, Oil & Gas',
  '22': 'Utilities',
  '23': 'Construction',
  '31': 'Manufacturing (food/textile)',
  '32': 'Manufacturing (paper/chemicals)',
  '33': 'Manufacturing (metal/machinery/electronics)',
  '42': 'Wholesale Trade',
  '44': 'Retail Trade (motor/furniture)',
  '45': 'Retail Trade (general)',
  '48': 'Transportation',
  '49': 'Warehousing & Postal',
  '51': 'Information',
  '52': 'Finance & Insurance',
  '53': 'Real Estate, Rental & Leasing',
  '54': 'Professional, Scientific & Technical Services',
  '55': 'Management of Companies',
  '56': 'Administrative & Support Services',
  '61': 'Educational Services',
  '62': 'Health Care & Social Assistance',
  '71': 'Arts, Entertainment & Recreation',
  '72': 'Accommodation & Food Services',
  '81': 'Other Services',
  '92': 'Public Administration',
};
