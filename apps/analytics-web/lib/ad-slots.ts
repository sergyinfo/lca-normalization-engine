/**
 * Ad-slot REGISTRY — the single source of truth for every ad placement on the
 * site. To wire up a slot after AdSense approval you only need its ad-unit id
 * (the `data-ad-slot` number Google gives each unit). Provide it EITHER way:
 *
 *   1. Edit this file — set `id` on the slot below. Simplest; committed in code.
 *   2. Or set the ADSENSE_SLOTS env JSON (overrides this file), e.g.
 *        ADSENSE_SLOTS='{"home-top":"1234567890","employer-top":"9876543210"}'
 *
 * Until a slot has an id it renders a native-styled placeholder, so the layout
 * is reserved and the site looks complete during AdSense review.
 *
 * `format` controls the size + the AdSense ad-format:
 *   horizontal  → responsive banner/leaderboard (page top & between big sections)
 *   in-article  → fluid in-content unit (between text/content blocks)
 *   rectangle   → medium rectangle (~336×280, good in a column or mid-content)
 *
 * NOTE: entity pages are statically prerendered, so adding/removing slots or
 * changing ids requires a rebuild (`docker compose build analytics-web`).
 */

export type AdFormat = 'horizontal' | 'in-article' | 'rectangle';

export interface AdSlotDef {
  format: AdFormat;
  /** Human description of where it appears (docs only). */
  where: string;
  /** Your AdSense ad-unit id (data-ad-slot). Leave empty to use ADSENSE_SLOTS env or a placeholder. */
  id?: string;
}

export const AD_SLOTS = {
  // ---- Home ----
  'home-top': { format: 'horizontal', where: 'Home — above the fold' },
  'home-mid': { format: 'in-article', where: 'Home — between sections' },
  'home-bottom': { format: 'horizontal', where: 'Home — above the footer' },

  // ---- Employer pages ----
  'employer-top': { format: 'horizontal', where: 'Employer detail — header' },
  'employer-mid': { format: 'in-article', where: 'Employer detail — mid content' },
  'employer-bottom': { format: 'horizontal', where: 'Employer detail — footer' },
  'employer-index-top': { format: 'horizontal', where: 'Employer index — top' },

  // ---- Occupation pages ----
  'occupation-top': { format: 'horizontal', where: 'Occupation detail — header' },
  'occupation-mid': { format: 'in-article', where: 'Occupation detail — mid content' },
  'occupation-bottom': { format: 'horizontal', where: 'Occupation detail — footer' },
  'occupation-index-top': { format: 'horizontal', where: 'Occupation index — top' },

  // ---- Sector pages ----
  'sector-top': { format: 'horizontal', where: 'Sector detail — header' },
  'sector-mid': { format: 'in-article', where: 'Sector detail — mid content' },
  'sector-bottom': { format: 'horizontal', where: 'Sector detail — footer' },
  'sector-index-top': { format: 'horizontal', where: 'Sector index — top' },

  // ---- State pages ----
  'state-top': { format: 'horizontal', where: 'State detail — header' },
  'state-mid': { format: 'in-article', where: 'State detail — mid content' },
  'state-bottom': { format: 'horizontal', where: 'State detail — footer' },
  'state-index-top': { format: 'horizontal', where: 'State index — top' },

  // ---- Ranking / SEO landing pages (shared RankingPage; each has a -bottom) ----
  'ranking-top-states': { format: 'horizontal', where: 'Top states ranking — top' },
  'ranking-top-states-bottom': { format: 'horizontal', where: 'Top states ranking — bottom' },
  'ranking-top-sponsors': { format: 'horizontal', where: 'Top sponsors ranking — top' },
  'ranking-top-sponsors-bottom': { format: 'horizontal', where: 'Top sponsors ranking — bottom' },
  'ranking-top-occupations': { format: 'horizontal', where: 'Top occupations ranking — top' },
  'ranking-top-occupations-bottom': { format: 'horizontal', where: 'Top occupations ranking — bottom' },
  'ranking-cleanest': { format: 'horizontal', where: 'Cleanest sponsors — top' },
  'ranking-cleanest-bottom': { format: 'horizontal', where: 'Cleanest sponsors — bottom' },
  'ranking-top-paying': { format: 'horizontal', where: 'Highest-paying jobs — top' },
  'ranking-top-paying-bottom': { format: 'horizontal', where: 'Highest-paying jobs — bottom' },
  'ranking-by-industry': { format: 'horizontal', where: 'By-industry — top' },
  'ranking-by-industry-bottom': { format: 'horizontal', where: 'By-industry — bottom' },
} satisfies Record<string, AdSlotDef>;

export type AdSlotName = keyof typeof AD_SLOTS;

/** Slot definition by name, with a safe default for any unregistered name. */
export function getSlotDef(name: string): AdSlotDef {
  return (AD_SLOTS as Record<string, AdSlotDef>)[name] ?? { format: 'horizontal', where: '(unregistered)' };
}

/** All slot names — used by docs/tooling to list what to create in AdSense. */
export const AD_SLOT_NAMES = Object.keys(AD_SLOTS) as AdSlotName[];
