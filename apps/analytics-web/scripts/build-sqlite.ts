/**
 * Quarterly Postgres → SQLite export.
 *
 * Reads from the existing `analytics.*` matviews (built and refreshed by
 * `pnpm analytics:bootstrap-views` / `analytics:refresh-views`), picks the
 * top-N entities per kind, and writes a fresh `data/lca.db`.
 *
 * Idempotent: drops the file first, recreates from scratch. Safe to re-run.
 *
 * Top-N caps (overridable via env):
 *   TOP_EMPLOYERS=50    TOP_OCCUPATIONS=30   TOP_STATES=30   TOP_SECTORS=30
 *
 * Slug strategy:
 *   - Employer: slugify(canonical_name). Collisions get a numeric suffix.
 *   - Occupation: the raw SOC code ("15-1252").
 *   - State: lower-case state code ("ca").
 *   - Sector: raw 2-digit NAICS code ("54").
 */

import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Load the monorepo root .env (where DATABASE_URL lives) before any
// imports that read it (notably @lca/db-lib).
const __scriptDir = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.join(__scriptDir, '..', '..', '..', '.env') });

import { getPool, closePool } from '@lca/db-lib';
import { SCHEMA_SQL } from '../lib/schema.ts';
import { slugify, stateNameFromCode, NAICS_LABELS,
  toOccupationSlug, toStateSlug, toSectorSlug } from '../lib/slugify.ts';

const DB_PATH = path.join(__scriptDir, '..', 'data', 'lca.db');

const TOP_EMPLOYERS   = Number(process.env.TOP_EMPLOYERS   ?? 50);
const TOP_OCCUPATIONS = Number(process.env.TOP_OCCUPATIONS ?? 30);
const TOP_STATES      = Number(process.env.TOP_STATES      ?? 30);
const TOP_SECTORS     = Number(process.env.TOP_SECTORS     ?? 30);

async function main() {
  console.log(`[build-sqlite] Target: ${DB_PATH}`);
  console.log(`[build-sqlite] Top-N: employers=${TOP_EMPLOYERS}, occupations=${TOP_OCCUPATIONS}, states=${TOP_STATES}, sectors=${TOP_SECTORS}`);

  if (existsSync(DB_PATH)) {
    rmSync(DB_PATH);
    console.log('[build-sqlite] Removed existing lca.db');
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = MEMORY');
  db.exec('PRAGMA synchronous = OFF');
  db.exec(SCHEMA_SQL);

  const pg = getPool();
  const now = Math.floor(Date.now() / 1000);

  /* -- site KPIs ---------------------------------------------------------- */
  const { rows: kpiRows } = await pg.query(`
    SELECT total_records, canonical_employers, distinct_socs, first_year, last_year
    FROM   analytics.v_overview_kpis LIMIT 1
  `);
  const { rows: medianRows } = await pg.query(`
    SELECT round(avg(median_wage))::int AS median_wage FROM analytics.mv_median_wage_by_year
  `);
  const kpi = kpiRows[0];
  db.prepare(`INSERT INTO site_kpis VALUES (1, ?, ?, ?, ?, ?, ?, ?)`).run(
    Number(kpi.total_records),
    Number(kpi.canonical_employers),
    Number(kpi.distinct_socs),
    Number(kpi.first_year),
    Number(kpi.last_year),
    Number(medianRows[0]?.median_wage ?? 0),
    now,
  );
  console.log(`[build-sqlite]   site_kpis: 1 row`);

  /* -- employers: top-N sponsors with outcome stats ----------------------- */
  const { rows: empRows } = await pg.query<{ id: string; canonical_name: string;
    employer_state: string | null; fein: string | null; filings: string;
    certified_pct: string | null; withdrawn_pct: string | null;
    cert_withdrawn_pct: string | null; denied_pct: string | null;
  }>(`
    SELECT eo.id::text, eo.canonical_name, eo.employer_state, eo.fein,
           eo.filings::text, eo.certified_pct::text, eo.withdrawn_pct::text,
           eo.cert_withdrawn_pct::text, eo.denied_pct::text
    FROM   analytics.mv_employer_outcomes eo
    ORDER  BY eo.filings DESC
    LIMIT  $1
  `, [TOP_EMPLOYERS]);

  const slugsSeen = new Map<string, number>();
  const canonicalToSlug = new Map<string, string>();
  const insertEmp = db.prepare(`INSERT INTO employer
    (slug, canonical_id, canonical_name, employer_state, fein, filings,
     certified_pct, withdrawn_pct, cert_withdrawn_pct, denied_pct,
     first_year, last_year, rank)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  empRows.forEach((r, i) => {
    let slug = slugify(r.canonical_name) || `employer-${r.id}`;
    const n = (slugsSeen.get(slug) ?? 0) + 1;
    slugsSeen.set(slug, n);
    if (n > 1) slug = `${slug}-${n}`;
    canonicalToSlug.set(r.id, slug);
    insertEmp.run(
      slug, r.id, r.canonical_name, r.employer_state, r.fein,
      Number(r.filings),
      toNumOrNull(r.certified_pct), toNumOrNull(r.withdrawn_pct),
      toNumOrNull(r.cert_withdrawn_pct), toNumOrNull(r.denied_pct),
      null, null, i + 1,
    );
  });
  console.log(`[build-sqlite]   employer: ${empRows.length} rows`);

  /* -- employer top occupations ------------------------------------------ */
  if (canonicalToSlug.size > 0) {
    const ids = Array.from(canonicalToSlug.keys());
    const { rows: empSocs } = await pg.query<{ canonical_id: string; soc_code: string;
      soc_title: string | null; filings: string; rk: number }>(`
      WITH ranked AS (
        SELECT te.canonical_id::text, te.soc_code,
               (SELECT soc_title FROM analytics.mv_soc_summary s WHERE s.soc_code = te.soc_code LIMIT 1) AS soc_title,
               te.filings::text,
               row_number() OVER (PARTITION BY te.canonical_id ORDER BY te.filings DESC) AS rk
        FROM   analytics.mv_top_employers_by_soc te
        WHERE  te.canonical_id::text = ANY($1::text[])
      )
      SELECT canonical_id, soc_code, soc_title, filings, rk::int
      FROM   ranked WHERE rk <= 10 ORDER BY canonical_id, rk
    `, [ids]);
    const insEmpSoc = db.prepare(`INSERT OR IGNORE INTO employer_top_soc
      (employer_slug, soc_code, soc_title, filings, rank) VALUES (?, ?, ?, ?, ?)`);
    for (const r of empSocs) {
      const slug = canonicalToSlug.get(r.canonical_id);
      if (!slug) continue;
      insEmpSoc.run(slug, r.soc_code, r.soc_title, Number(r.filings), Number(r.rk));
    }
    console.log(`[build-sqlite]   employer_top_soc: ${empSocs.length} rows`);

    /* -- employer yearly volume (from mv_employer_growth_by_year) ------- */
    const { rows: empYears } = await pg.query<{ canonical_id: string;
      year: number; filings: string }>(`
      SELECT canonical_id::text, year, filings::text
      FROM   analytics.mv_employer_growth_by_year
      WHERE  canonical_id::text = ANY($1::text[])
      ORDER  BY canonical_id, year
    `, [ids]);
    const insEmpYear = db.prepare(`INSERT OR IGNORE INTO employer_yearly
      (employer_slug, year, filings) VALUES (?, ?, ?)`);
    // Manual reduction since SQLite has no MIN()/MAX() in UPDATE SET.
    const empYearRange = new Map<string, { min: number; max: number }>();
    for (const r of empYears) {
      const slug = canonicalToSlug.get(r.canonical_id);
      if (!slug) continue;
      insEmpYear.run(slug, Number(r.year), Number(r.filings));
      const ex = empYearRange.get(slug);
      if (!ex) empYearRange.set(slug, { min: r.year, max: r.year });
      else { ex.min = Math.min(ex.min, r.year); ex.max = Math.max(ex.max, r.year); }
    }
    const updRange = db.prepare(`UPDATE employer SET first_year = ?, last_year = ? WHERE slug = ?`);
    for (const [slug, { min, max }] of empYearRange) updRange.run(min, max, slug);
    console.log(`[build-sqlite]   employer_yearly: ${empYears.length} rows`);
  }

  /* -- occupations: top-N -------------------------------------------------- */
  const { rows: occRows } = await pg.query<{ soc_code: string; soc_title: string | null;
    filings: string; n: string | null; p25: number | null; p50: number | null; p75: number | null }>(`
    SELECT s.soc_code, s.soc_title, s.filings::text,
           w.n::text, w.p25, w.p50, w.p75
    FROM   analytics.mv_soc_summary s
    LEFT   JOIN analytics.mv_wage_by_soc w USING (soc_code)
    ORDER  BY s.filings DESC
    LIMIT  $1
  `, [TOP_OCCUPATIONS]);
  const insOcc = db.prepare(`INSERT INTO occupation
    (soc_code, slug, soc_title, filings, n_wages, p25_wage, p50_wage, p75_wage, rank)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  occRows.forEach((r, i) => {
    insOcc.run(r.soc_code, toOccupationSlug(r.soc_code, r.soc_title),
      r.soc_title, Number(r.filings),
      r.n != null ? Number(r.n) : null,
      r.p25 ?? null, r.p50 ?? null, r.p75 ?? null, i + 1);
  });
  const occCodes = occRows.map((r) => r.soc_code);
  console.log(`[build-sqlite]   occupation: ${occRows.length} rows`);

  if (occCodes.length > 0) {
    /* -- occupation_level ------------------------------------------------ */
    const { rows: lvls } = await pg.query<{ soc_code: string; wage_level: string;
      n: string | null; p25: number | null; p50: number | null; p75: number | null }>(`
      SELECT soc_code, wage_level, n::text, p25, p50, p75
      FROM   analytics.mv_wage_by_soc_level
      WHERE  soc_code = ANY($1::text[]) ORDER BY soc_code, wage_level
    `, [occCodes]);
    const insLvl = db.prepare(`INSERT INTO occupation_level
      (soc_code, wage_level, n_wages, p25_wage, p50_wage, p75_wage) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const r of lvls) {
      insLvl.run(r.soc_code, r.wage_level,
        r.n != null ? Number(r.n) : null,
        r.p25 ?? null, r.p50 ?? null, r.p75 ?? null);
    }
    console.log(`[build-sqlite]   occupation_level: ${lvls.length} rows`);

    /* -- occupation_top_state ------------------------------------------- */
    const { rows: occStates } = await pg.query<{ soc_code: string; state: string;
      n: string; p50: number | null; rk: number }>(`
      WITH ranked AS (
        SELECT soc_code, state, n::text, p50,
               row_number() OVER (PARTITION BY soc_code ORDER BY n DESC) AS rk
        FROM   analytics.mv_wage_by_soc_state
        WHERE  soc_code = ANY($1::text[])
      )
      SELECT soc_code, state, n, p50, rk::int FROM ranked WHERE rk <= 10
      ORDER BY soc_code, rk
    `, [occCodes]);
    const insOccState = db.prepare(`INSERT INTO occupation_top_state
      (soc_code, state, filings, p50_wage, rank) VALUES (?, ?, ?, ?, ?)`);
    for (const r of occStates) {
      insOccState.run(r.soc_code, r.state, Number(r.n), r.p50 ?? null, Number(r.rk));
    }
    console.log(`[build-sqlite]   occupation_top_state: ${occStates.length} rows`);

    /* -- occupation_top_employer ---------------------------------------- */
    const { rows: occEmps } = await pg.query<{ soc_code: string; canonical_id: string;
      canonical_name: string; filings: string; rk: number }>(`
      WITH ranked AS (
        SELECT te.soc_code, te.canonical_id::text, te.canonical_name, te.filings::text,
               row_number() OVER (PARTITION BY te.soc_code ORDER BY te.filings DESC) AS rk
        FROM   analytics.mv_top_employers_by_soc te
        WHERE  te.soc_code = ANY($1::text[])
      )
      SELECT soc_code, canonical_id, canonical_name, filings, rk::int
      FROM   ranked WHERE rk <= 10 ORDER BY soc_code, rk
    `, [occCodes]);
    const insOccEmp = db.prepare(`INSERT OR IGNORE INTO occupation_top_employer
      (soc_code, employer_slug, canonical_name, filings, rank) VALUES (?, ?, ?, ?, ?)`);
    for (const r of occEmps) {
      const slug = canonicalToSlug.get(r.canonical_id)
        ?? (slugify(r.canonical_name) || `employer-${r.canonical_id}`);
      insOccEmp.run(r.soc_code, slug, r.canonical_name, Number(r.filings), Number(r.rk));
    }
    console.log(`[build-sqlite]   occupation_top_employer: ${occEmps.length} rows`);

    /* -- occupation_yearly ---------------------------------------------- */
    const { rows: occYears } = await pg.query<{ soc_code: string; year: number;
      n: string | null; median_wage: number | null }>(`
      SELECT soc_code, year, n::text, median_wage
      FROM   analytics.mv_wage_by_soc_year
      WHERE  soc_code = ANY($1::text[]) ORDER BY soc_code, year
    `, [occCodes]);
    const insOccYear = db.prepare(`INSERT INTO occupation_yearly
      (soc_code, year, filings, median_wage) VALUES (?, ?, ?, ?)`);
    for (const r of occYears) {
      insOccYear.run(r.soc_code, Number(r.year),
        r.n != null ? Number(r.n) : null, r.median_wage ?? null);
    }
    console.log(`[build-sqlite]   occupation_yearly: ${occYears.length} rows`);
  }

  /* -- states ------------------------------------------------------------ */
  // NOTE: pg returns bigint as string by default, so no ::text cast needed.
  // Avoid casting in SELECT to keep the column name unambiguous for ORDER BY.
  const { rows: stateRows } = await pg.query<{ state: string; filings: string }>(`
    SELECT state, filings FROM analytics.mv_filings_by_state
    ORDER BY filings DESC LIMIT $1
  `, [TOP_STATES]);
  const insState = db.prepare(`INSERT INTO state (code, slug, name, filings, rank) VALUES (?, ?, ?, ?, ?)`);
  stateRows.forEach((r, i) => {
    const code = r.state.toUpperCase();
    const name = stateNameFromCode(code);
    insState.run(code, toStateSlug(code, name), name, Number(r.filings), i + 1);
  });
  const stateCodes = stateRows.map((r) => r.state.toUpperCase());
  console.log(`[build-sqlite]   state: ${stateRows.length} rows`);

  if (stateCodes.length > 0) {
    /* -- state_top_employer --------------------------------------------- */
    const { rows: stEmps } = await pg.query<{ state: string; canonical_id: string;
      canonical_name: string; filings: string; share_pct: number | null; rk: number }>(`
      SELECT sc.state, sc.canonical_id::text, sc.canonical_name, sc.filings::text, sc.share_pct,
             row_number() OVER (PARTITION BY sc.state ORDER BY sc.filings DESC) AS rk
      FROM   analytics.mv_state_concentration sc
      WHERE  sc.state = ANY($1::text[]) ORDER BY sc.state, sc.filings DESC
    `, [stateCodes]);
    const insStEmp = db.prepare(`INSERT OR IGNORE INTO state_top_employer
      (state_code, employer_slug, canonical_name, filings, share_pct, rank) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const r of stEmps) {
      const slug = canonicalToSlug.get(r.canonical_id)
        ?? (slugify(r.canonical_name) || `employer-${r.canonical_id}`);
      insStEmp.run(r.state, slug, r.canonical_name, Number(r.filings),
        r.share_pct ?? null, Number(r.rk));
    }
    console.log(`[build-sqlite]   state_top_employer: ${stEmps.length} rows`);

    /* -- state_top_occupation ------------------------------------------- */
    // Computed live since we don't have a matview for it; cheap on 30 states.
    const { rows: stSocs } = await pg.query<{ state: string; soc_code: string;
      soc_title: string | null; filings: string; rk: number }>(`
      WITH ranked AS (
        SELECT data->>'WORKSITE_STATE' AS state,
               data->>'soc_code' AS soc_code,
               count(*)::text AS filings,
               row_number() OVER (PARTITION BY data->>'WORKSITE_STATE'
                                   ORDER BY count(*) DESC) AS rk
        FROM   lca_records
        WHERE  data->>'WORKSITE_STATE' = ANY($1::text[])
          AND  data->>'soc_code' IS NOT NULL
        GROUP  BY data->>'WORKSITE_STATE', data->>'soc_code'
      )
      SELECT r.state, r.soc_code,
             (SELECT soc_title FROM analytics.mv_soc_summary s WHERE s.soc_code = r.soc_code LIMIT 1) AS soc_title,
             r.filings, r.rk::int
      FROM   ranked r WHERE rk <= 10 ORDER BY state, rk
    `, [stateCodes]);
    const insStSoc = db.prepare(`INSERT OR IGNORE INTO state_top_occupation
      (state_code, soc_code, soc_title, filings, rank) VALUES (?, ?, ?, ?, ?)`);
    for (const r of stSocs) {
      insStSoc.run(r.state, r.soc_code, r.soc_title, Number(r.filings), Number(r.rk));
    }
    console.log(`[build-sqlite]   state_top_occupation: ${stSocs.length} rows`);
  }

  /* -- sectors ----------------------------------------------------------- */
  // Same gotcha as states: don't ::text-cast in SELECT, or the unqualified
  // ORDER BY hits the text alias and sorts lexicographically.
  const { rows: secRows } = await pg.query<{ sector: string; filings: string;
    employers: string }>(`
    SELECT sector, filings, employers
    FROM   analytics.mv_naics_sector_summary
    ORDER  BY filings DESC LIMIT $1
  `, [TOP_SECTORS]);
  const insSec = db.prepare(`INSERT INTO sector
    (naics2, slug, label, filings, employers, rank) VALUES (?, ?, ?, ?, ?, ?)`);
  secRows.forEach((r, i) => {
    const label = NAICS_LABELS[r.sector] ?? `Sector ${r.sector}`;
    insSec.run(r.sector, toSectorSlug(r.sector, label), label,
      Number(r.filings), Number(r.employers), i + 1);
  });
  const sectorCodes = secRows.map((r) => r.sector);
  console.log(`[build-sqlite]   sector: ${secRows.length} rows`);

  if (sectorCodes.length > 0) {
    /* -- sector_yearly (direct pull from mv_naics_sector_by_year) -------- */
    const { rows: secYears } = await pg.query<{ sector: string; year: number;
      filings: string }>(`
      SELECT sector, year, filings
      FROM   analytics.mv_naics_sector_by_year
      WHERE  sector = ANY($1::text[]) ORDER BY sector, year
    `, [sectorCodes]);
    const insSecYear = db.prepare(`INSERT INTO sector_yearly
      (naics2, year, filings) VALUES (?, ?, ?)`);
    for (const r of secYears) {
      insSecYear.run(r.sector, Number(r.year), Number(r.filings));
    }
    console.log(`[build-sqlite]   sector_yearly: ${secYears.length} rows`);

    /* -- sector_top_employer (live; cheap on 30 sectors) ----------------- */
    const { rows: secEmps } = await pg.query<{ sector: string; canonical_id: string;
      canonical_name: string; filings: string; rk: number }>(`
      WITH ranked AS (
        SELECT substr(r.data->>'NAICS_CODE',1,2) AS sector,
               r.data->>'canonical_employer_id'  AS canonical_id,
               count(*)::text                    AS filings,
               row_number() OVER (
                 PARTITION BY substr(r.data->>'NAICS_CODE',1,2)
                 ORDER BY count(*) DESC) AS rk
        FROM   lca_records r
        WHERE  substr(r.data->>'NAICS_CODE',1,2) = ANY($1::text[])
          AND  r.data->>'canonical_employer_id' IS NOT NULL
        GROUP  BY 1, 2
      )
      SELECT r.sector, r.canonical_id,
             (SELECT canonical_name FROM canonical_employers c WHERE c.id::text = r.canonical_id) AS canonical_name,
             r.filings, r.rk::int
      FROM   ranked r WHERE rk <= 10 ORDER BY sector, rk
    `, [sectorCodes]);
    const insSecEmp = db.prepare(`INSERT OR IGNORE INTO sector_top_employer
      (naics2, employer_slug, canonical_name, filings, rank) VALUES (?, ?, ?, ?, ?)`);
    for (const r of secEmps) {
      if (!r.canonical_name) continue;
      const slug = canonicalToSlug.get(r.canonical_id)
        ?? (slugify(r.canonical_name) || `employer-${r.canonical_id}`);
      insSecEmp.run(r.sector, slug, r.canonical_name, Number(r.filings), Number(r.rk));
    }
    console.log(`[build-sqlite]   sector_top_employer: ${secEmps.length} rows`);

    /* -- sector_top_occupation (live) ----------------------------------- */
    const { rows: secSocs } = await pg.query<{ sector: string; soc_code: string;
      soc_title: string | null; filings: string; rk: number }>(`
      WITH ranked AS (
        SELECT substr(r.data->>'NAICS_CODE',1,2) AS sector,
               r.data->>'soc_code'              AS soc_code,
               count(*)::text                    AS filings,
               row_number() OVER (
                 PARTITION BY substr(r.data->>'NAICS_CODE',1,2)
                 ORDER BY count(*) DESC) AS rk
        FROM   lca_records r
        WHERE  substr(r.data->>'NAICS_CODE',1,2) = ANY($1::text[])
          AND  r.data->>'soc_code' IS NOT NULL
        GROUP  BY 1, 2
      )
      SELECT r.sector, r.soc_code,
             (SELECT soc_title FROM analytics.mv_soc_summary s WHERE s.soc_code = r.soc_code LIMIT 1) AS soc_title,
             r.filings, r.rk::int
      FROM   ranked r WHERE rk <= 10 ORDER BY sector, rk
    `, [sectorCodes]);
    const insSecSoc = db.prepare(`INSERT OR IGNORE INTO sector_top_occupation
      (naics2, soc_code, soc_title, filings, rank) VALUES (?, ?, ?, ?, ?)`);
    for (const r of secSocs) {
      insSecSoc.run(r.sector, r.soc_code, r.soc_title, Number(r.filings), Number(r.rk));
    }
    console.log(`[build-sqlite]   sector_top_occupation: ${secSocs.length} rows`);

    /* -- sector_top_state (live) ---------------------------------------- */
    const { rows: secStates } = await pg.query<{ sector: string; state: string;
      filings: string; rk: number }>(`
      WITH ranked AS (
        SELECT substr(r.data->>'NAICS_CODE',1,2) AS sector,
               r.data->>'WORKSITE_STATE'        AS state,
               count(*)::text                    AS filings,
               row_number() OVER (
                 PARTITION BY substr(r.data->>'NAICS_CODE',1,2)
                 ORDER BY count(*) DESC) AS rk
        FROM   lca_records r
        WHERE  substr(r.data->>'NAICS_CODE',1,2) = ANY($1::text[])
          AND  r.data->>'WORKSITE_STATE' IS NOT NULL
        GROUP  BY 1, 2
      )
      SELECT sector, state, filings, rk::int FROM ranked WHERE rk <= 10
      ORDER BY sector, rk
    `, [sectorCodes]);
    const insSecState = db.prepare(`INSERT OR IGNORE INTO sector_top_state
      (naics2, state, filings, rank) VALUES (?, ?, ?, ?)`);
    for (const r of secStates) {
      insSecState.run(r.sector, r.state.toUpperCase(), Number(r.filings), Number(r.rk));
    }
    console.log(`[build-sqlite]   sector_top_state: ${secStates.length} rows`);
  }

  /* -- state_yearly (drives sparklines + state entity yearly trend) ------ */
  if (stateCodes.length > 0) {
    const { rows: stYears } = await pg.query<{ state: string; year: number;
      filings: string }>(`
      SELECT data->>'WORKSITE_STATE' AS state,
             filing_year::int        AS year,
             count(*)::text          AS filings
      FROM   lca_records
      WHERE  data->>'WORKSITE_STATE' = ANY($1::text[])
        AND  filing_year IS NOT NULL
      GROUP  BY 1, 2
      ORDER  BY 1, 2
    `, [stateCodes]);
    const insStYear = db.prepare(`INSERT INTO state_yearly
      (state_code, year, filings) VALUES (?, ?, ?)`);
    for (const r of stYears) {
      insStYear.run(r.state.toUpperCase(), Number(r.year), Number(r.filings));
    }
    console.log(`[build-sqlite]   state_yearly: ${stYears.length} rows`);
  }

  /* -- finalize ---------------------------------------------------------- */
  db.exec('ANALYZE');
  db.close();
  await closePool();

  const stat = await import('node:fs').then((m) => m.statSync(DB_PATH));
  console.log(`[build-sqlite] Done. ${(stat.size / 1024 / 1024).toFixed(1)} MB → ${DB_PATH}`);
}

function toNumOrNull(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

main().catch((err) => {
  console.error('[build-sqlite] FAILED:', err);
  process.exit(1);
});
