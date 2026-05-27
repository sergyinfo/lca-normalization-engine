/**
 * Single source of truth for site branding. Overridable via env so the same
 * codebase can be re-skinned for a different domain without touching code.
 *
 * Set these in .env / deploy environment:
 *   NEXT_PUBLIC_SITE_NAME=<your site name>
 *   NEXT_PUBLIC_SITE_URL=<https://your-domain.tld>
 *
 * NEXT_PUBLIC_ prefix lets these be inlined into client bundles too — needed
 * for components that hydrate on the client (e.g. AdSense slot scripts).
 */

export const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME ?? 'H1B Report';
export const SITE_URL  = process.env.NEXT_PUBLIC_SITE_URL  ?? 'https://h1b.report';

/** Hostname stripped of protocol — used in OG watermarks where the visual
 *  weight of "https://" adds noise. */
export const SITE_HOST = SITE_URL.replace(/^https?:\/\//, '');

/** Google Tag Manager container ID. Set NEXT_PUBLIC_GTM_ID="" to disable
 *  injection entirely (e.g., during local development). */
export const GTM_ID = process.env.NEXT_PUBLIC_GTM_ID ?? 'GTM-NGCWHKZ2';
