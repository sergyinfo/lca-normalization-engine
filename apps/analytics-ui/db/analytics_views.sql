-- Materialized + plain views powering the LCA Analytics dashboard.
--
-- Why: the dashboard runs heavy aggregations over 3.8M+ JSONB rows. Computing
-- them on every request takes 30-90s cold cache. Each matview captures a
-- panel as a tiny pre-aggregated table, turning page paint into a few index
-- scans on rows that fit in shared_buffers.
--
-- Build order matters — later matviews can depend on earlier ones (e.g.
-- mv_state_share_by_year reads mv_filings_by_state). The plain VIEW
-- v_overview_kpis at the bottom composes from the matviews and a few
-- small base-table counts, so it always reflects the freshest state
-- without needing its own refresh.
--
-- Refresh: `pnpm analytics:refresh-views` after data ingest / backfills.

CREATE SCHEMA IF NOT EXISTS analytics;

-- ---------------------------------------------------------------------------
-- Filings by fiscal year
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_filings_by_year CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_filings_by_year AS
SELECT filing_year::int AS year, count(*)::bigint AS filings
FROM   lca_records
GROUP  BY filing_year;

-- ---------------------------------------------------------------------------
-- Filings by worksite state
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_filings_by_state CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_filings_by_state AS
SELECT data->>'WORKSITE_STATE' AS state, count(*)::bigint AS filings
FROM   lca_records
WHERE  data->>'WORKSITE_STATE' IS NOT NULL
  AND  length(data->>'WORKSITE_STATE') = 2
GROUP  BY state;

-- ---------------------------------------------------------------------------
-- Top sponsors by canonical_employer
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_top_sponsors CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_top_sponsors AS
SELECT ce.id, ce.canonical_name, ce.employer_state, ce.fein,
       count(*)::bigint AS filings
FROM   lca_records r
JOIN   canonical_employers ce ON ce.id::text = r.data->>'canonical_employer_id'
GROUP  BY ce.id, ce.canonical_name, ce.employer_state, ce.fein;

CREATE INDEX IF NOT EXISTS mv_top_sponsors_filings_idx
  ON analytics.mv_top_sponsors (filings DESC);

-- ---------------------------------------------------------------------------
-- SOC summary
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_soc_summary CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_soc_summary AS
SELECT
  s.soc_code,
  (SELECT soc_title FROM soc_aliases sa WHERE sa.soc_code = s.soc_code LIMIT 1) AS soc_title,
  s.filings
FROM (
  SELECT r.data->>'soc_code' AS soc_code, count(*)::bigint AS filings
  FROM   lca_records r
  WHERE  r.data->>'soc_code' IS NOT NULL
  GROUP  BY r.data->>'soc_code'
) s;

CREATE INDEX IF NOT EXISTS mv_soc_summary_filings_idx
  ON analytics.mv_soc_summary (filings DESC);
CREATE INDEX IF NOT EXISTS mv_soc_summary_code_idx
  ON analytics.mv_soc_summary (soc_code);

-- ---------------------------------------------------------------------------
-- Wage percentiles by SOC
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_wage_by_soc CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_wage_by_soc AS
WITH wages AS (
  SELECT
    r.data->>'soc_code' AS soc_code,
    CASE upper(coalesce(r.data->>'WAGE_UNIT_OF_PAY', 'Year'))
      WHEN 'YEAR'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric
      WHEN 'HOUR'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 2080
      WHEN 'WEEK'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 52
      WHEN 'MONTH'     THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 12
      WHEN 'BI-WEEKLY' THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 26
      ELSE NULL
    END AS annual_wage
  FROM   lca_records r
  WHERE  r.data->>'soc_code' IS NOT NULL
)
SELECT soc_code,
       count(annual_wage)::bigint                                          AS n,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY annual_wage)::int      AS p25,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY annual_wage)::int      AS p50,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY annual_wage)::int      AS p75,
       min(annual_wage)::int                                               AS min_wage,
       max(annual_wage)::int                                               AS max_wage
FROM   wages
WHERE  annual_wage BETWEEN 20000 AND 1000000
GROUP  BY soc_code;

CREATE INDEX IF NOT EXISTS mv_wage_by_soc_code_idx
  ON analytics.mv_wage_by_soc (soc_code);

-- ---------------------------------------------------------------------------
-- Median wage by year
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_median_wage_by_year CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_median_wage_by_year AS
WITH wages AS (
  SELECT r.filing_year::int AS year,
    CASE upper(coalesce(r.data->>'WAGE_UNIT_OF_PAY', 'Year'))
      WHEN 'YEAR'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric
      WHEN 'HOUR'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 2080
      WHEN 'WEEK'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 52
      WHEN 'MONTH'     THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 12
      WHEN 'BI-WEEKLY' THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 26
      ELSE NULL
    END AS annual_wage
  FROM lca_records r
)
SELECT year,
       count(annual_wage)::bigint                                         AS n,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY annual_wage)::int     AS median_wage
FROM   wages
WHERE  annual_wage BETWEEN 20000 AND 1000000
GROUP  BY year;

-- ---------------------------------------------------------------------------
-- Median wage by (SOC, year) — wage growth lines
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_wage_by_soc_year CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_wage_by_soc_year AS
WITH wages AS (
  SELECT r.data->>'soc_code' AS soc_code, r.filing_year::int AS year,
    CASE upper(coalesce(r.data->>'WAGE_UNIT_OF_PAY', 'Year'))
      WHEN 'YEAR'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric
      WHEN 'HOUR'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 2080
      WHEN 'WEEK'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 52
      WHEN 'MONTH'     THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 12
      WHEN 'BI-WEEKLY' THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 26
      ELSE NULL
    END AS annual_wage
  FROM lca_records r
  WHERE r.data->>'soc_code' IS NOT NULL
)
SELECT soc_code, year,
       count(annual_wage)::bigint                                         AS n,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY annual_wage)::int     AS p25_wage,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY annual_wage)::int     AS median_wage,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY annual_wage)::int     AS p75_wage
FROM   wages
WHERE  annual_wage BETWEEN 20000 AND 1000000
GROUP  BY soc_code, year;

CREATE INDEX IF NOT EXISTS mv_wage_by_soc_year_idx
  ON analytics.mv_wage_by_soc_year (soc_code, year);

-- ---------------------------------------------------------------------------
-- State share by year — depends on mv_filings_by_state
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_state_share_by_year CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_state_share_by_year AS
WITH top_states AS (
  SELECT state FROM analytics.mv_filings_by_state ORDER BY filings DESC LIMIT 6
)
SELECT filing_year::int                                AS year,
       coalesce(ts.state, 'Other')                     AS state,
       count(*)::bigint                                AS filings
FROM   lca_records r
LEFT   JOIN top_states ts ON ts.state = r.data->>'WORKSITE_STATE'
GROUP  BY filing_year, coalesce(ts.state, 'Other');

-- ---------------------------------------------------------------------------
-- Case status breakdown
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_case_status CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_case_status AS
SELECT coalesce(data->>'CASE_STATUS', '(unknown)') AS status,
       count(*)::bigint                            AS filings
FROM   lca_records
GROUP  BY status;

-- ---------------------------------------------------------------------------
-- Classification source mix
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_classification_source_mix CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_classification_source_mix AS
SELECT coalesce(data->>'soc_source', '(unclassified)') AS source,
       count(*)::bigint                                AS records
FROM   lca_records
GROUP  BY source;

-- ---------------------------------------------------------------------------
-- Stage-2 confidence distribution
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_confidence_distribution CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_confidence_distribution AS
SELECT bucket, count(*)::bigint AS records
FROM (
  SELECT CASE
           WHEN (data->>'soc_confidence')::numeric < 0.5  THEN '< 0.5'
           WHEN (data->>'soc_confidence')::numeric < 0.6  THEN '0.5-0.6'
           WHEN (data->>'soc_confidence')::numeric < 0.7  THEN '0.6-0.7'
           WHEN (data->>'soc_confidence')::numeric < 0.8  THEN '0.7-0.8'
           WHEN (data->>'soc_confidence')::numeric < 0.9  THEN '0.8-0.9'
           WHEN (data->>'soc_confidence')::numeric <= 1.0 THEN '0.9-1.0'
           ELSE '(missing)'
         END AS bucket
  FROM   lca_records
  WHERE  data->>'soc_source' = 'stage2'
) b
GROUP BY bucket;

-- ---------------------------------------------------------------------------
-- Coverage counters (one-row matview)
-- Captures expensive existence counts that wouldn't otherwise hit an index.
-- The planner ignores idx_lca_records_canonical_missing for the inverse
-- predicate, falling back to a 37s parallel seq scan — so we cache the result.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_coverage CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_coverage AS
SELECT
  (SELECT count(*) FROM lca_records WHERE NOT (data ? 'canonical_employer_id'))::bigint AS missing_canonical;

-- ---------------------------------------------------------------------------
-- Top employers per SOC
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_top_employers_by_soc CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_top_employers_by_soc AS
SELECT r.data->>'soc_code'                  AS soc_code,
       ce.id                                AS canonical_id,
       ce.canonical_name                    AS canonical_name,
       ce.employer_state                    AS employer_state,
       count(*)::bigint                     AS filings
FROM   lca_records r
JOIN   canonical_employers ce ON ce.id::text = r.data->>'canonical_employer_id'
WHERE  r.data->>'soc_code' IS NOT NULL
GROUP  BY r.data->>'soc_code', ce.id, ce.canonical_name, ce.employer_state;

CREATE INDEX IF NOT EXISTS mv_top_employers_by_soc_idx
  ON analytics.mv_top_employers_by_soc (soc_code, filings DESC);

-- ---------------------------------------------------------------------------
-- Overview KPIs — plain VIEW that composes from the matviews above plus
-- a few small base-table counts. No expensive aggregation here. Auto-fresh
-- as the matviews refresh; no separate refresh required.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS analytics.v_overview_kpis CASCADE;
CREATE VIEW analytics.v_overview_kpis AS
SELECT
  (SELECT sum(filings)::bigint FROM analytics.mv_filings_by_year)                      AS total_records,
  (SELECT sum(records)::bigint FROM analytics.mv_classification_source_mix
     WHERE source <> '(unclassified)')                                                 AS classified_records,
  ((SELECT sum(filings)::bigint FROM analytics.mv_filings_by_year)
    - (SELECT missing_canonical FROM analytics.mv_coverage))                           AS canonicalised_records,
  (SELECT count(*)::bigint FROM canonical_employers)                                   AS canonical_employers,
  (SELECT count(*)::int FROM analytics.mv_soc_summary)                                 AS distinct_socs,
  (SELECT min(year) FROM analytics.mv_filings_by_year)                                 AS first_year,
  (SELECT max(year) FROM analytics.mv_filings_by_year)                                 AS last_year,
  (SELECT count(*)::bigint FROM staging.quarantine_records WHERE reprocessed_at IS NULL) AS quarantine_open,
  (SELECT count(*)::bigint FROM staging.unresolved_employers WHERE resolved_at IS NULL) AS unresolved_open,
  (SELECT count(*)::bigint FROM employer_embeddings)                                   AS employer_embeddings;

-- ===========================================================================
--                       Extended personas — additional matviews
-- ===========================================================================
-- These power the 6 supplementary personas added on 2026-05-13:
--   /attorney      — Immigration Attorney
--   /hr            — HR / Compensation Manager
--   /economist     — Economist / Labor Market Analyst
--   /investor      — Investor / Business Intelligence
--   /worker-rights — Worker Rights / NGO
--   /student       — Student / Career Planner
-- All are appended (not replacing). Build cost is bounded — each is a single
-- pass over lca_records with at most one canonical_employers JOIN.

-- ---------------------------------------------------------------------------
-- mv_case_status_by_year — outcome trend (attorney + policy)
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_case_status_by_year CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_case_status_by_year AS
SELECT filing_year::int                                AS year,
       coalesce(data->>'CASE_STATUS', '(unknown)')     AS status,
       count(*)::bigint                                AS filings
FROM   lca_records
GROUP  BY filing_year, status;

CREATE INDEX IF NOT EXISTS mv_case_status_by_year_idx
  ON analytics.mv_case_status_by_year (year, status);

-- ---------------------------------------------------------------------------
-- mv_employer_outcomes — per canonical_employer outcome breakdown.
-- Drives the attorney "sponsor risk" leaderboard and the NGO concentration
-- view. Includes denial_rate / withdrawal_rate for filterable sorts.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_employer_outcomes CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_employer_outcomes AS
WITH agg AS (
  SELECT ce.id, ce.canonical_name, ce.employer_state, ce.fein,
         count(*)::bigint                                                            AS filings,
         count(*) FILTER (WHERE r.data->>'CASE_STATUS' = 'Certified')::bigint        AS certified,
         count(*) FILTER (WHERE r.data->>'CASE_STATUS' = 'Withdrawn')::bigint        AS withdrawn,
         count(*) FILTER (WHERE r.data->>'CASE_STATUS' = 'Certified - Withdrawn')::bigint AS cert_withdrawn,
         count(*) FILTER (WHERE r.data->>'CASE_STATUS' = 'Denied')::bigint           AS denied
  FROM   lca_records r
  JOIN   canonical_employers ce ON ce.id::text = r.data->>'canonical_employer_id'
  GROUP  BY ce.id, ce.canonical_name, ce.employer_state, ce.fein
)
SELECT id, canonical_name, employer_state, fein, filings,
       certified, withdrawn, cert_withdrawn, denied,
       round(100.0 * denied        / NULLIF(filings,0), 2) AS denied_pct,
       round(100.0 * withdrawn     / NULLIF(filings,0), 2) AS withdrawn_pct,
       round(100.0 * cert_withdrawn/ NULLIF(filings,0), 2) AS cert_withdrawn_pct,
       round(100.0 * certified     / NULLIF(filings,0), 2) AS certified_pct
FROM   agg;

CREATE INDEX IF NOT EXISTS mv_employer_outcomes_filings_idx
  ON analytics.mv_employer_outcomes (filings DESC);
CREATE INDEX IF NOT EXISTS mv_employer_outcomes_denied_idx
  ON analytics.mv_employer_outcomes (denied_pct DESC) WHERE filings >= 50;
CREATE INDEX IF NOT EXISTS mv_employer_outcomes_withdrawn_idx
  ON analytics.mv_employer_outcomes (withdrawn_pct DESC) WHERE filings >= 50;

-- ---------------------------------------------------------------------------
-- mv_naics_sector_summary — top-level NAICS sector aggregate (first 2 digits).
-- Drives Economist + Investor pages.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_naics_sector_summary CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_naics_sector_summary AS
SELECT substr(data->>'NAICS_CODE',1,2)               AS sector,
       count(*)::bigint                              AS filings,
       count(DISTINCT data->>'canonical_employer_id')::bigint AS employers
FROM   lca_records
WHERE  data->>'NAICS_CODE' IS NOT NULL
   AND length(data->>'NAICS_CODE') >= 2
GROUP  BY 1;

CREATE INDEX IF NOT EXISTS mv_naics_sector_summary_idx
  ON analytics.mv_naics_sector_summary (filings DESC);

-- ---------------------------------------------------------------------------
-- mv_naics_sector_by_year — sector trend (economist)
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_naics_sector_by_year CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_naics_sector_by_year AS
SELECT filing_year::int                              AS year,
       substr(data->>'NAICS_CODE',1,2)               AS sector,
       count(*)::bigint                              AS filings
FROM   lca_records
WHERE  data->>'NAICS_CODE' IS NOT NULL
   AND length(data->>'NAICS_CODE') >= 2
GROUP  BY filing_year, sector;

CREATE INDEX IF NOT EXISTS mv_naics_sector_by_year_idx
  ON analytics.mv_naics_sector_by_year (year, sector);

-- ---------------------------------------------------------------------------
-- mv_employer_growth_by_year — per top-300 sponsor, filings per FY.
-- Drives the Investor "hiring signal" view. Limited to top 300 by total
-- volume to keep the matview small (~1.8k rows).
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_employer_growth_by_year CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_employer_growth_by_year AS
WITH top_sponsors AS (
  SELECT id FROM analytics.mv_top_sponsors ORDER BY filings DESC LIMIT 300
)
SELECT ts.id                                AS canonical_id,
       ce.canonical_name                    AS canonical_name,
       r.filing_year::int                   AS year,
       count(*)::bigint                     AS filings,
       count(*) FILTER (WHERE r.data->>'CASE_STATUS' = 'Certified')::bigint            AS certified,
       count(*) FILTER (WHERE r.data->>'CASE_STATUS' = 'Withdrawn')::bigint            AS withdrawn,
       count(*) FILTER (WHERE r.data->>'CASE_STATUS' = 'Certified - Withdrawn')::bigint AS cert_withdrawn,
       count(*) FILTER (WHERE r.data->>'CASE_STATUS' = 'Denied')::bigint               AS denied
FROM   lca_records r
JOIN   canonical_employers ce ON ce.id::text = r.data->>'canonical_employer_id'
JOIN   top_sponsors ts ON ts.id = ce.id
GROUP  BY ts.id, ce.canonical_name, r.filing_year;

CREATE INDEX IF NOT EXISTS mv_employer_growth_by_year_idx
  ON analytics.mv_employer_growth_by_year (canonical_id, year);

-- ---------------------------------------------------------------------------
-- mv_wage_by_soc_level — wage percentiles split by PW_WAGE_LEVEL (I/II/III/IV).
-- Drives the Student "entry vs senior" view.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_wage_by_soc_level CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_wage_by_soc_level AS
WITH wages AS (
  SELECT r.data->>'soc_code'                  AS soc_code,
         coalesce(r.data->>'PW_WAGE_LEVEL','?') AS wage_level,
    CASE upper(coalesce(r.data->>'WAGE_UNIT_OF_PAY', 'Year'))
      WHEN 'YEAR'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric
      WHEN 'HOUR'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 2080
      WHEN 'WEEK'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 52
      WHEN 'MONTH'     THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 12
      WHEN 'BI-WEEKLY' THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 26
      ELSE NULL
    END AS annual_wage
  FROM   lca_records r
  WHERE  r.data->>'soc_code' IS NOT NULL
    AND  r.data->>'PW_WAGE_LEVEL' IN ('I','II','III','IV')
)
SELECT soc_code, wage_level,
       count(annual_wage)::bigint                                          AS n,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY annual_wage)::int      AS p25,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY annual_wage)::int      AS p50,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY annual_wage)::int      AS p75
FROM   wages
WHERE  annual_wage BETWEEN 20000 AND 1000000
GROUP  BY soc_code, wage_level;

CREATE INDEX IF NOT EXISTS mv_wage_by_soc_level_idx
  ON analytics.mv_wage_by_soc_level (soc_code, wage_level);

-- ---------------------------------------------------------------------------
-- mv_wage_by_soc_state — wage percentiles by (SOC, worksite state).
-- Drives the HR Compensation benchmarking page. Filtered to combos with
-- n >= 25 so percentiles are meaningful and the matview stays compact.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_wage_by_soc_state CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_wage_by_soc_state AS
WITH wages AS (
  SELECT r.data->>'soc_code'                            AS soc_code,
         r.data->>'WORKSITE_STATE'                       AS state,
    CASE upper(coalesce(r.data->>'WAGE_UNIT_OF_PAY', 'Year'))
      WHEN 'YEAR'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric
      WHEN 'HOUR'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 2080
      WHEN 'WEEK'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 52
      WHEN 'MONTH'     THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 12
      WHEN 'BI-WEEKLY' THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 26
      ELSE NULL
    END AS annual_wage
  FROM   lca_records r
  WHERE  r.data->>'soc_code'        IS NOT NULL
    AND  r.data->>'WORKSITE_STATE'  IS NOT NULL
    AND  length(r.data->>'WORKSITE_STATE') = 2
)
SELECT soc_code, state,
       count(annual_wage)::bigint                                          AS n,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY annual_wage)::int      AS p25,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY annual_wage)::int      AS p50,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY annual_wage)::int      AS p75
FROM   wages
WHERE  annual_wage BETWEEN 20000 AND 1000000
GROUP  BY soc_code, state
HAVING count(annual_wage) >= 25;

CREATE INDEX IF NOT EXISTS mv_wage_by_soc_state_idx
  ON analytics.mv_wage_by_soc_state (soc_code, state);

-- ---------------------------------------------------------------------------
-- mv_wage_premium_by_soc — how far above prevailing wage the offered wages
-- cluster, by SOC. p50_ratio < 1.02 → near-floor (compliance-only); higher
-- ratios suggest competitive pay above the legal minimum.
-- Drives the NGO worker-rights "wage floor clustering" view.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_wage_premium_by_soc CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_wage_premium_by_soc AS
WITH pairs AS (
  SELECT r.data->>'soc_code'                            AS soc_code,
    CASE upper(coalesce(r.data->>'WAGE_UNIT_OF_PAY', 'Year'))
      WHEN 'YEAR'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric
      WHEN 'HOUR'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 2080
      WHEN 'WEEK'      THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 52
      WHEN 'MONTH'     THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 12
      WHEN 'BI-WEEKLY' THEN nullif(substring(replace(r.data->>'WAGE_RATE_OF_PAY_FROM', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 26
      ELSE NULL
    END AS offered_wage,
    CASE upper(coalesce(r.data->>'PW_UNIT_OF_PAY', 'Year'))
      WHEN 'YEAR'      THEN nullif(substring(replace(r.data->>'PREVAILING_WAGE', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric
      WHEN 'HOUR'      THEN nullif(substring(replace(r.data->>'PREVAILING_WAGE', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 2080
      WHEN 'WEEK'      THEN nullif(substring(replace(r.data->>'PREVAILING_WAGE', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 52
      WHEN 'MONTH'     THEN nullif(substring(replace(r.data->>'PREVAILING_WAGE', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 12
      WHEN 'BI-WEEKLY' THEN nullif(substring(replace(r.data->>'PREVAILING_WAGE', ',', '') from '[0-9]+(?:[.][0-9]+)?'), '')::numeric * 26
      ELSE NULL
    END AS prevailing_wage
  FROM   lca_records r
  WHERE  r.data->>'soc_code' IS NOT NULL
)
SELECT soc_code,
       count(*)::bigint                                                                  AS n,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY offered_wage / prevailing_wage)::numeric(6,3) AS p50_ratio,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY offered_wage / prevailing_wage)::numeric(6,3) AS p25_ratio,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY offered_wage / prevailing_wage)::numeric(6,3) AS p75_ratio,
       (count(*) FILTER (WHERE offered_wage / prevailing_wage BETWEEN 0.98 AND 1.02))::bigint AS near_floor_n
FROM   pairs
WHERE  offered_wage    BETWEEN 20000 AND 1000000
   AND prevailing_wage BETWEEN 20000 AND 1000000
GROUP  BY soc_code;

CREATE INDEX IF NOT EXISTS mv_wage_premium_by_soc_idx
  ON analytics.mv_wage_premium_by_soc (soc_code);

-- ---------------------------------------------------------------------------
-- mv_state_concentration — top employer in each state (NGO concentration risk).
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_state_concentration CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_state_concentration AS
WITH per_state AS (
  SELECT r.data->>'WORKSITE_STATE'                          AS state,
         ce.id                                              AS canonical_id,
         ce.canonical_name,
         count(*)::bigint                                   AS filings
  FROM   lca_records r
  JOIN   canonical_employers ce ON ce.id::text = r.data->>'canonical_employer_id'
  WHERE  r.data->>'WORKSITE_STATE' IS NOT NULL
    AND  length(r.data->>'WORKSITE_STATE') = 2
  GROUP  BY r.data->>'WORKSITE_STATE', ce.id, ce.canonical_name
),
state_totals AS (
  SELECT state, sum(filings) AS state_filings FROM per_state GROUP BY state
),
ranked AS (
  SELECT ps.state, ps.canonical_id, ps.canonical_name, ps.filings,
         st.state_filings,
         row_number() OVER (PARTITION BY ps.state ORDER BY ps.filings DESC) AS rk
  FROM   per_state ps JOIN state_totals st USING (state)
)
SELECT state, canonical_id, canonical_name, filings, state_filings,
       round(100.0 * filings / NULLIF(state_filings,0), 2) AS share_pct
FROM   ranked
WHERE  rk <= 15;

CREATE INDEX IF NOT EXISTS mv_state_concentration_idx
  ON analytics.mv_state_concentration (state, share_pct DESC);

-- ---------------------------------------------------------------------------
-- mv_soc_share_by_year — top-10 SOC share of total filings per year.
-- Drives the Economist "occupation concentration" view.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_soc_share_by_year CASCADE;
CREATE MATERIALIZED VIEW analytics.mv_soc_share_by_year AS
WITH top_socs AS (
  SELECT soc_code FROM analytics.mv_soc_summary ORDER BY filings DESC LIMIT 10
),
year_totals AS (
  SELECT filing_year::int AS year, count(*)::bigint AS total_year FROM lca_records GROUP BY filing_year
)
SELECT r.filing_year::int                              AS year,
       coalesce(ts.soc_code, '(other)')                AS soc_code,
       count(*)::bigint                                AS filings,
       round(100.0 * count(*) / NULLIF(yt.total_year,0), 2) AS share_pct
FROM   lca_records r
LEFT   JOIN top_socs ts  ON ts.soc_code = r.data->>'soc_code'
JOIN   year_totals yt    ON yt.year     = r.filing_year::int
GROUP  BY r.filing_year, coalesce(ts.soc_code, '(other)'), yt.total_year;
