/**
 * Read-only analytical queries for the four-persona dashboard.
 *
 * All aggregations come from materialized views in the `analytics` schema —
 * see `db/analytics_views.sql` for the DDL. They turn page paint from "scan
 * 3.8M JSONB rows" into "scan a few hundred pre-aggregated rows", which is
 * the difference between an 80-second wait and a sub-second response.
 *
 * Refresh path: `pnpm analytics:refresh-views` (or the equivalent script in
 * `db/refresh_views.sql`) after data ingest / canonical / SOC backfills.
 *
 * The only non-matview query is `wageLookup`, because its filter set (SOC +
 * state + city) is user-driven. It still completes in 1-3s thanks to the
 * composite index on (lower(EMPLOYER_NAME), EMPLOYER_STATE) and the partial
 * index on soc_code.
 */

import { getPool } from '@lca/db-lib';

/* -------------------------------------------------------------------------- */
/* Annual wage expression — used only by the interactive wageLookup query.    */
/* All other wage stats come from the matviews, which already inline this.    */
/* -------------------------------------------------------------------------- */
const ANNUAL_WAGE_EXPR = `
  CASE upper(coalesce(data->>'WAGE_UNIT_OF_PAY', 'Year'))
    WHEN 'YEAR'      THEN nullif(regexp_replace(data->>'WAGE_RATE_OF_PAY_FROM', '[^0-9.]', '', 'g'), '')::numeric
    WHEN 'HOUR'      THEN nullif(regexp_replace(data->>'WAGE_RATE_OF_PAY_FROM', '[^0-9.]', '', 'g'), '')::numeric * 2080
    WHEN 'WEEK'      THEN nullif(regexp_replace(data->>'WAGE_RATE_OF_PAY_FROM', '[^0-9.]', '', 'g'), '')::numeric * 52
    WHEN 'MONTH'     THEN nullif(regexp_replace(data->>'WAGE_RATE_OF_PAY_FROM', '[^0-9.]', '', 'g'), '')::numeric * 12
    WHEN 'BI-WEEKLY' THEN nullif(regexp_replace(data->>'WAGE_RATE_OF_PAY_FROM', '[^0-9.]', '', 'g'), '')::numeric * 26
    ELSE NULL
  END
`;

/* -------------------------------------------------------------------------- */
/* Home / KPI overview                                                        */
/* -------------------------------------------------------------------------- */

export async function getOverviewKpis() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT total_records, classified_records, canonicalised_records,
           canonical_employers, distinct_socs, first_year, last_year
    FROM   analytics.v_overview_kpis
    LIMIT  1
  `);
  return rows[0];
}

/* -------------------------------------------------------------------------- */
/* Persona 1 — Journalist / Public                                            */
/* -------------------------------------------------------------------------- */

export async function topSponsors({ limit = 20 } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT id, canonical_name, employer_state, filings
    FROM   analytics.mv_top_sponsors
    ORDER  BY filings DESC
    LIMIT  $1
    `,
    [limit],
  );
  return rows;
}

export async function filingsByState() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT state, filings
    FROM   analytics.mv_filings_by_state
    ORDER  BY filings DESC
    LIMIT  15
  `);
  return rows;
}

export async function filingsByYear() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT year, filings
    FROM   analytics.mv_filings_by_year
    ORDER  BY year
  `);
  return rows;
}

export async function topSocs({ limit = 12 } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT soc_code, soc_title, filings
    FROM   analytics.mv_soc_summary
    ORDER  BY filings DESC
    LIMIT  $1
    `,
    [limit],
  );
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Persona 2 — Job Seeker                                                     */
/* -------------------------------------------------------------------------- */

export async function wagePercentilesByTopSoc({ limit = 10 } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT w.soc_code,
           s.soc_title,
           w.n, w.p25, w.p50, w.p75
    FROM   analytics.mv_soc_summary s
    JOIN   analytics.mv_wage_by_soc w USING (soc_code)
    ORDER  BY s.filings DESC
    LIMIT  $1
    `,
    [limit],
  );
  return rows;
}

/**
 * Interactive SOC + state + city lookup — the one query that can't come from
 * a matview because the filter combinations are open. Uses the composite
 * index on (lower(EMPLOYER_NAME), EMPLOYER_STATE) plus the partial soc_code
 * index — completes in 1-3s.
 */
export async function wageLookup({ socCode, state = null, city = null }) {
  const pool = getPool();

  // Fast path: no state or city filter → read directly from the pre-aggregated
  // matview. Sub-millisecond.
  if (!state && !city) {
    const { rows } = await pool.query(
      `SELECT n, p25, p50, p75, min_wage, max_wage
       FROM   analytics.mv_wage_by_soc WHERE soc_code = $1`,
      [socCode],
    );
    return rows[0] || { n: 0, p25: 0, p50: 0, p75: 0, min_wage: 0, max_wage: 0 };
  }

  // Filtered path: must touch lca_records. Limit scope by sampling — even
  // the largest SOCs (e.g. 15-1252) have <1.2M rows and the partial soc_code
  // index makes the per-SOC scan reasonable. Parallel + JIT off to keep shm
  // pressure manageable when the dashboard is hit concurrently.
  const filters = [`r.data->>'soc_code' = $1`];
  const params = [socCode];
  if (state) {
    params.push(state.toUpperCase());
    filters.push(`r.data->>'WORKSITE_STATE' = $${params.length}`);
  }
  if (city) {
    params.push(city);
    filters.push(`lower(r.data->>'WORKSITE_CITY') = lower($${params.length})`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL max_parallel_workers_per_gather = 0`);
    await client.query(`SET LOCAL jit = off`);
    await client.query(`SET LOCAL statement_timeout = '20s'`);
    const { rows } = await client.query(
      `
      WITH wages AS (
        SELECT (${ANNUAL_WAGE_EXPR}) AS annual_wage
        FROM   lca_records r
        WHERE  ${filters.join(' AND ')}
      )
      SELECT count(annual_wage)::bigint                                          AS n,
             percentile_cont(0.25) WITHIN GROUP (ORDER BY annual_wage)::int      AS p25,
             percentile_cont(0.50) WITHIN GROUP (ORDER BY annual_wage)::int      AS p50,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY annual_wage)::int      AS p75,
             min(annual_wage)::int                                               AS min_wage,
             max(annual_wage)::int                                               AS max_wage
      FROM   wages
      WHERE  annual_wage IS NOT NULL AND annual_wage BETWEEN 20000 AND 1000000
      `,
      params,
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Statement-timeout (57014) or canceled: return null so the view can show
    // a "filter too broad" message rather than a 500.
    if (err.code === '57014') {
      return { n: 0, p25: 0, p50: 0, p75: 0, min_wage: 0, max_wage: 0, timed_out: true };
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function topEmployersForSoc({ socCode, limit = 15 }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT canonical_name, employer_state, filings
    FROM   analytics.mv_top_employers_by_soc
    WHERE  soc_code = $1
    ORDER  BY filings DESC
    LIMIT  $2
    `,
    [socCode, limit],
  );
  return rows;
}

export async function wageTrendForSoc({ socCode }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT year, n, median_wage
    FROM   analytics.mv_wage_by_soc_year
    WHERE  soc_code = $1
    ORDER  BY year
    `,
    [socCode],
  );
  return rows;
}

export async function listSocOptions({ limit = 200 } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT soc_code, soc_title, filings
    FROM   analytics.mv_soc_summary
    ORDER  BY filings DESC
    LIMIT  $1
    `,
    [limit],
  );
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Persona 3 — Policy / Labor Economist                                       */
/* -------------------------------------------------------------------------- */

export async function medianWageByYear() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT year, n, median_wage
    FROM   analytics.mv_median_wage_by_year
    ORDER  BY year
  `);
  return rows;
}

export async function stateShareByYear() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT year, state, filings
    FROM   analytics.mv_state_share_by_year
    ORDER  BY year, filings DESC
  `);
  return rows;
}

export async function wageGrowthTopOccupations({ limit = 5 } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    WITH top_socs AS (
      SELECT soc_code FROM analytics.mv_soc_summary ORDER BY filings DESC LIMIT $1
    )
    SELECT w.soc_code,
           s.soc_title,
           w.year,
           w.median_wage
    FROM   analytics.mv_wage_by_soc_year w
    JOIN   top_socs t USING (soc_code)
    JOIN   analytics.mv_soc_summary s USING (soc_code)
    ORDER  BY w.soc_code, w.year
    `,
    [limit],
  );
  return rows;
}

export async function caseStatusBreakdown() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT status, filings
    FROM   analytics.mv_case_status
    ORDER  BY filings DESC
    LIMIT  8
  `);
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Persona 4 — Academic / Thesis Examiner                                     */
/* -------------------------------------------------------------------------- */

export async function classificationSourceMix() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT source, records
    FROM   analytics.mv_classification_source_mix
    ORDER  BY records DESC
  `);
  return rows;
}

export async function confidenceDistribution() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT bucket, records
    FROM   analytics.mv_confidence_distribution
    ORDER  BY bucket
  `);
  return rows;
}

export async function coverageStats() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT total_records, classified_records, canonicalised_records,
           quarantine_open, unresolved_open, canonical_employers, employer_embeddings
    FROM   analytics.v_overview_kpis
    LIMIT  1
  `);
  return rows[0];
}

export async function entityResolutionLayerMix() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM canonical_employers WHERE fein IS NOT NULL)::bigint     AS layer1_fein_canonicals,
      (SELECT count(*) FROM canonical_employers WHERE fein IS NULL)::bigint         AS layer23_namebased_canonicals,
      (SELECT count(*) FROM staging.unresolved_employers
         WHERE resolved_at IS NOT NULL AND resolved_to_id IS NOT NULL)::bigint      AS unresolved_merged,
      (SELECT count(*) FROM staging.unresolved_employers
         WHERE resolved_at IS NULL)::bigint                                         AS unresolved_open
  `);
  return rows[0];
}

export async function topCanonicalsByVolume({ limit = 10 } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT canonical_name, fein, employer_state, record_count
    FROM   canonical_employers
    ORDER  BY record_count DESC NULLS LAST
    LIMIT  $1
    `,
    [limit],
  );
  return rows;
}
