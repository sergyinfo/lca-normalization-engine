#!/usr/bin/env node
/**
 * CI guard: every materialized view DEFINED in analytics_views.sql must also be
 * REFRESHED in refresh_views.sql.
 *
 * Why: the quarterly burst (burst-finalize.sh) refreshes matviews via the
 * hand-maintained refresh_views.sql list — it does NOT DROP+CREATE from
 * analytics_views.sql. If a new matview is added to analytics_views.sql but not
 * to the refresh list, the burst silently ships STALE data for it. That exact
 * drift left `mv_site_dims_by_year` un-refreshed, blanking the homepage
 * Sponsors/SOCs KPIs for the newest fiscal year (FY2026).
 *
 * Pure Node builtins, no deps. Exits non-zero (with the offending names) on drift.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = resolve(here, '../apps/analytics-ui/db');

const names = (file, re) => {
  const txt = readFileSync(resolve(dbDir, file), 'utf8');
  const out = new Set();
  let m;
  while ((m = re.exec(txt))) out.add(m[1]);
  return out;
};

const defined = names('analytics_views.sql',
  /CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:analytics\.)?(mv_[a-z_]+)/gi);
const refreshed = names('refresh_views.sql',
  /REFRESH\s+MATERIALIZED\s+VIEW\s+(?:CONCURRENTLY\s+)?(?:analytics\.)?(mv_[a-z_]+)/gi);

const missing = [...defined].filter((n) => !refreshed.has(n)).sort();

if (missing.length) {
  console.error('\n✗ refresh_views.sql is MISSING matviews defined in analytics_views.sql:\n');
  for (const n of missing) console.error('   - ' + n);
  console.error('\nThe quarterly burst would ship these STALE. Add a');
  console.error('`REFRESH MATERIALIZED VIEW analytics.<name>;` line to');
  console.error('apps/analytics-ui/db/refresh_views.sql for each (mind dependency order).');
  process.exit(1);
}
console.log(`✓ refresh_views.sql covers all ${defined.size} matviews in analytics_views.sql`);
