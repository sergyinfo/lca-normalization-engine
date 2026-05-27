/**
 * Build-time feature flags. Read once at module load — `NEXT_PUBLIC_*` env
 * vars are inlined into the bundle at `next build`, so flipping a flag
 * requires a rebuild (and a docker image rebuild for production).
 *
 * Default for every flag is OFF. A flag is ON only when the env var is
 * exactly the string "true".
 */

export const FEATURES = {
  /** Public JSON API + /api/docs page + nav/footer links. */
  api: process.env.NEXT_PUBLIC_FEATURE_API === 'true',
} as const;
