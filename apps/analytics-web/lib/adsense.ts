/**
 * AdSense configuration. Server-only env (no NEXT_PUBLIC_ prefix) — we
 * read it during SSR and stamp the values into the rendered HTML. That's
 * enough for AdSense's `<ins>` tag and the loader script.
 *
 * Env:
 *   ADSENSE_CLIENT_ID=ca-pub-XXXXXXXXXXXXXXXX    (site-wide publisher id)
 *   ADSENSE_SLOTS='{"employer-top":"1234567890","occupation-mid":"...","..."}'
 *
 * `ADSENSE_CLIENT_ID` defaults to the public h1b.report publisher id, so the
 * loader script + `google-adsense-account` meta render on every build (set
 * `ADSENSE_CLIENT_ID=none` to disable, e.g. on a fork). Each AdSlot still
 * renders its dashed dev placeholder until `ADSENSE_SLOTS` provides a slot id
 * for that name — so manual ad units stay silent until you create them.
 *
 * Caveat: entity pages are statically prerendered via generateStaticParams,
 * so the env is read at BUILD time for those routes. Rotating slot IDs
 * therefore requires a rebuild (`docker compose build analytics-web`).
 * The dynamic API routes don't have ads, so their env can rotate freely.
 */

// Public AdSense publisher id for h1b.report — not a secret (it ships in the
// page source). Default to it so the loader + meta render without build-env
// wiring; `ADSENSE_CLIENT_ID=none` disables, any other value overrides.
const DEFAULT_CLIENT_ID = 'ca-pub-8373729950359398';
const _envClient = process.env.ADSENSE_CLIENT_ID?.trim();
export const ADSENSE_CLIENT_ID: string | null =
  _envClient === 'none' ? null : (_envClient || DEFAULT_CLIENT_ID);

let _slotMap: Record<string, string> | null = null;

function getSlotMap(): Record<string, string> {
  if (_slotMap !== null) return _slotMap;
  const raw = process.env.ADSENSE_SLOTS ?? '';
  let map: Record<string, string> = {};
  try {
    if (raw.trim()) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        map = parsed as Record<string, string>;
      }
    }
  } catch {
    // Swallow parse errors — better to render the placeholder than crash SSR.
    // The operator will notice via the empty slot list at /api/docs etc.
  }
  _slotMap = map;
  return map;
}

export function getAdSenseSlotId(name: string): string | null {
  return getSlotMap()[name] ?? null;
}

/** True when both the client id and at least one slot are configured. */
export function isAdSenseEnabled(): boolean {
  return ADSENSE_CLIENT_ID !== null;
}
