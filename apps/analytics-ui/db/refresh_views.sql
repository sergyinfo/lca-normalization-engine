-- Refresh every materialized view in the analytics schema.
-- Run via: PGPASSWORD=... psql -h ... -d ... -f db/refresh_views.sql
-- Or:      pnpm analytics:refresh-views
--
-- Order matters: mv_state_share_by_year depends on mv_filings_by_state.

REFRESH MATERIALIZED VIEW analytics.mv_filings_by_year;
REFRESH MATERIALIZED VIEW analytics.mv_filings_by_state;
REFRESH MATERIALIZED VIEW analytics.mv_top_sponsors;
REFRESH MATERIALIZED VIEW analytics.mv_soc_summary;
REFRESH MATERIALIZED VIEW analytics.mv_wage_by_soc;
REFRESH MATERIALIZED VIEW analytics.mv_median_wage_by_year;
REFRESH MATERIALIZED VIEW analytics.mv_wage_by_soc_year;
REFRESH MATERIALIZED VIEW analytics.mv_state_share_by_year;
REFRESH MATERIALIZED VIEW analytics.mv_case_status;
REFRESH MATERIALIZED VIEW analytics.mv_classification_source_mix;
REFRESH MATERIALIZED VIEW analytics.mv_confidence_distribution;
REFRESH MATERIALIZED VIEW analytics.mv_top_employers_by_soc;
REFRESH MATERIALIZED VIEW analytics.mv_coverage;

-- Extended-personas matviews (added 2026-05-13)
REFRESH MATERIALIZED VIEW analytics.mv_case_status_by_year;
REFRESH MATERIALIZED VIEW analytics.mv_employer_outcomes;
REFRESH MATERIALIZED VIEW analytics.mv_naics_sector_summary;
REFRESH MATERIALIZED VIEW analytics.mv_naics_sector_by_year;
REFRESH MATERIALIZED VIEW analytics.mv_employer_growth_by_year;
REFRESH MATERIALIZED VIEW analytics.mv_wage_by_soc_level;
REFRESH MATERIALIZED VIEW analytics.mv_wage_by_soc_state;
REFRESH MATERIALIZED VIEW analytics.mv_wage_premium_by_soc;
REFRESH MATERIALIZED VIEW analytics.mv_state_concentration;
REFRESH MATERIALIZED VIEW analytics.mv_soc_share_by_year;

-- Year-view dashboard (added 2026-06; reads lca_records directly, no deps).
-- ⚠️ This list MUST cover every matview in analytics_views.sql. A missing entry
-- silently ships STALE data on the quarterly burst — mv_site_dims_by_year was
-- missing here, so the homepage Sponsors/SOCs KPIs went blank for the new year.
-- The CI guard scripts/check-matview-refresh-coverage.mjs now enforces parity.
REFRESH MATERIALIZED VIEW analytics.mv_site_dims_by_year;

SELECT relname,
       pg_size_pretty(pg_relation_size(oid)) AS size,
       (SELECT reltuples::bigint FROM pg_class c2 WHERE c2.oid = c.oid) AS approx_rows
FROM   pg_class c
WHERE  relkind = 'm'
  AND  relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'analytics')
ORDER  BY relname;
