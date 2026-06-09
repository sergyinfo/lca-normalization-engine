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
import { copyFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
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
const ARCHIVES_DIR = path.join(__scriptDir, '..', 'data', 'archives');

/** YYYY-qN label derived from a unix timestamp (calendar quarter). */
function quarterLabel(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-q${q}`;
}

/** Newest-first list of "YYYY-qN" archive labels present on disk. */
function listArchiveLabels(): string[] {
  if (!existsSync(ARCHIVES_DIR)) return [];
  return readdirSync(ARCHIVES_DIR)
    .filter((f) => /^\d{4}-q[1-4]\.lca\.db$/.test(f))
    .map((f) => f.replace(/\.lca\.db$/, ''))
    .sort()
    .reverse();
}

/** Find the newest archive containing the slug, returning its label. */
function findArchiveWithSlug(kind: Kind, slug: string): string | null {
  for (const label of listArchiveLabels()) {
    const archivePath = path.join(ARCHIVES_DIR, `${label}.lca.db`);
    try {
      const db = new DatabaseSync(archivePath, { readOnly: true });
      const row = db.prepare(`SELECT 1 FROM ${kind} WHERE slug = ? LIMIT 1`).get(slug);
      db.close();
      if (row) return label;
    } catch { /* archive may not have this table; skip */ }
  }
  return null;
}

// Top-N caps. Bigger N → less quarter-over-quarter churn at the boundary
// → fewer URLs that go from 200 to 301 (or worse, 404) between rebuilds.
// State and sector are essentially fixed; bumping their caps is free.
const TOP_EMPLOYERS   = Number(process.env.TOP_EMPLOYERS   ?? 200);
const TOP_OCCUPATIONS = Number(process.env.TOP_OCCUPATIONS ?? 100);
const TOP_STATES      = Number(process.env.TOP_STATES      ?? 60);
const TOP_SECTORS     = Number(process.env.TOP_SECTORS     ?? 30);

type Kind = 'employer' | 'occupation' | 'state' | 'sector';
const KINDS: Kind[] = ['employer', 'occupation', 'state', 'sector'];

interface PastState {
  /** Slugs that had a static entity page in the previous build, by kind. */
  slugs: Record<Kind, Set<string>>;
  /** Existing redirect rows from the previous build (source → target). */
  redirects: Map<string, string>;
}

/** Snapshot the previous lca.db before we destroy it, so we can compute
 *  set-difference and persist 301 redirects for any dropped slug. */
function snapshotPastState(dbPath: string): PastState {
  const past: PastState = {
    slugs: { employer: new Set(), occupation: new Set(), state: new Set(), sector: new Set() },
    redirects: new Map(),
  };
  if (!existsSync(dbPath)) return past;
  const old = new DatabaseSync(dbPath, { readOnly: true });
  for (const kind of KINDS) {
    try {
      const rows = old.prepare(`SELECT slug FROM ${kind}`).all() as Array<{ slug: string }>;
      for (const r of rows) past.slugs[kind].add(r.slug);
    } catch { /* table may not exist on very old snapshots */ }
  }
  try {
    const rows = old.prepare(`SELECT source_path, target_path FROM redirects`).all() as Array<{ source_path: string; target_path: string }>;
    for (const r of rows) past.redirects.set(r.source_path, r.target_path);
  } catch { /* redirects table is new; absent on first run */ }
  old.close();
  return past;
}

async function main() {
  console.log(`[build-sqlite] Target: ${DB_PATH}`);
  console.log(`[build-sqlite] Top-N: employers=${TOP_EMPLOYERS}, occupations=${TOP_OCCUPATIONS}, states=${TOP_STATES}, sectors=${TOP_SECTORS}`);

  const past = snapshotPastState(DB_PATH);
  console.log(`[build-sqlite] Past state: ${past.slugs.employer.size}e + ${past.slugs.occupation.size}o + ${past.slugs.state.size}st + ${past.slugs.sector.size}sec slugs, ${past.redirects.size} existing redirects`);

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

  /* -- site_yearly: filings + median wage + sponsors/socs per fiscal year -- */
  const { rows: yearRows } = await pg.query<{ year: string; filings: string;
    median_wage: string | null; sponsors: string | null; socs: string | null }>(`
    SELECT f.year, f.filings::text AS filings, w.median_wage::text AS median_wage,
           d.sponsors::text AS sponsors, d.socs::text AS socs
    FROM   analytics.mv_filings_by_year f
    LEFT JOIN analytics.mv_median_wage_by_year w ON w.year = f.year
    LEFT JOIN analytics.mv_site_dims_by_year   d ON d.year = f.year
    ORDER  BY f.year
  `);
  const insYear = db.prepare(`INSERT INTO site_yearly (year, filings, median_wage, sponsors, socs) VALUES (?, ?, ?, ?, ?)`);
  for (const r of yearRows) {
    insYear.run(Number(r.year), Number(r.filings),
      r.median_wage != null ? Number(r.median_wage) : null,
      r.sponsors != null ? Number(r.sponsors) : null,
      r.socs != null ? Number(r.socs) : null);
  }
  console.log(`[build-sqlite]   site_yearly: ${yearRows.length} rows`);

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

  // Disambiguate canonical_name collisions across the top-N sponsor set.
  // Different legal entities can share a trade name with different FEINs
  // (e.g. two "AMAZON.COM SERVICES LLC" rows — one WA HQ, one VA subsidiary).
  // Append a disambiguator to the *displayed* name when ≥2 rows collide:
  //   1st choice: state (when state is non-null AND unique within the group)
  //   2nd choice: FEIN last-4
  //   3rd choice: short canonical_id prefix
  // Slugs and FEINs stay untouched; only the displayed string changes.
  const idToDisplay = new Map<string, string>();
  {
    const byName = new Map<string, typeof empRows>();
    for (const r of empRows) {
      const arr = byName.get(r.canonical_name) ?? [];
      arr.push(r); byName.set(r.canonical_name, arr);
    }
    for (const [name, rows] of byName) {
      if (rows.length === 1) {
        idToDisplay.set(rows[0]!.id, name);
        continue;
      }
      const states = rows.map((r) => r.employer_state ?? '');
      const statesUnique = new Set(states).size === rows.length && !states.includes('');
      for (const r of rows) {
        if (statesUnique && r.employer_state) {
          idToDisplay.set(r.id, `${name} (${r.employer_state})`);
        } else if (r.fein) {
          const digits = r.fein.replace(/\D/g, '');
          idToDisplay.set(r.id, `${name} (FEIN…${digits.slice(-4)})`);
        } else {
          idToDisplay.set(r.id, `${name} (#${r.id.slice(0, 6)})`);
        }
      }
    }
  }

  const slugsSeen = new Map<string, number>();
  const canonicalToSlug = new Map<string, string>();
  const canonicalToDisplay = new Map<string, string>();
  // Canonical-ids referenced by state/occupation/sector_top_employer that
  // are NOT in the global top-N. We backfill them into `employer` at the
  // end with rank=NULL so the cross-ref links resolve to a real page
  // (otherwise users get 404s when clicking from /state/<x> → /employer/<y>).
  const tailEmployerIds = new Set<string>();
  const noteTail = (id: string) => {
    if (id && !canonicalToSlug.has(id)) tailEmployerIds.add(id);
  };
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
    const displayName = idToDisplay.get(r.id) ?? r.canonical_name;
    canonicalToDisplay.set(r.id, displayName);
    insertEmp.run(
      slug, r.id, displayName, r.employer_state, r.fein,
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

    /* -- employer yearly volume + outcome counts (mv_employer_growth_by_year) - */
    const { rows: empYears } = await pg.query<{ canonical_id: string;
      year: number; filings: string; certified: string; withdrawn: string;
      cert_withdrawn: string; denied: string }>(`
      SELECT canonical_id::text, year, filings::text,
             certified::text, withdrawn::text, cert_withdrawn::text, denied::text
      FROM   analytics.mv_employer_growth_by_year
      WHERE  canonical_id::text = ANY($1::text[])
      ORDER  BY canonical_id, year
    `, [ids]);
    const insEmpYear = db.prepare(`INSERT OR IGNORE INTO employer_yearly
      (employer_slug, year, filings, certified, withdrawn, cert_withdrawn, denied)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    // Manual reduction since SQLite has no MIN()/MAX() in UPDATE SET.
    const empYearRange = new Map<string, { min: number; max: number }>();
    for (const r of empYears) {
      const slug = canonicalToSlug.get(r.canonical_id);
      if (!slug) continue;
      insEmpYear.run(slug, Number(r.year), Number(r.filings),
        Number(r.certified), Number(r.withdrawn), Number(r.cert_withdrawn), Number(r.denied));
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
  // soc_code -> page slug, for the curated (top-N) occupations only; used to
  // link the homepage per-year "top-paying" rows that resolve to a real page.
  const occSlugByCode = new Map<string, string>();
  occRows.forEach((r, i) => {
    const slug = toOccupationSlug(r.soc_code, r.soc_title);
    occSlugByCode.set(r.soc_code, slug);
    insOcc.run(r.soc_code, slug,
      r.soc_title, Number(r.filings),
      r.n != null ? Number(r.n) : null,
      r.p25 ?? null, r.p50 ?? null, r.p75 ?? null, i + 1);
  });
  const occCodes = occRows.map((r) => r.soc_code);
  console.log(`[build-sqlite]   occupation: ${occRows.length} rows`);

  /* -- site_top_paying_occ_yearly: top-8 occupations by median wage / FY ---- */
  // Homepage "highest-paying" chart, per fiscal year. Sourced from the per-year
  // wage matview (not occupation_yearly, which is by filings). Slug links only
  // when the SOC is in the curated occupation set above.
  const { rows: payRows } = await pg.query<{ year: string; soc_code: string;
    soc_title: string | null; p50_wage: string | null; n: string; rk: number }>(`
    WITH ranked AS (
      SELECT w.year, w.soc_code, w.median_wage AS p50_wage, w.n,
             row_number() OVER (PARTITION BY w.year ORDER BY w.median_wage DESC) AS rk
      FROM   analytics.mv_wage_by_soc_year w
      WHERE  w.n >= 50 AND w.median_wage IS NOT NULL
    )
    SELECT r.year, r.soc_code,
           (SELECT s.soc_title FROM analytics.mv_soc_summary s WHERE s.soc_code = r.soc_code LIMIT 1) AS soc_title,
           r.p50_wage::text AS p50_wage, r.n::text AS n, r.rk::int AS rk
    FROM   ranked r WHERE r.rk <= 8 ORDER BY r.year, r.rk
  `);
  const insPay = db.prepare(`INSERT OR IGNORE INTO site_top_paying_occ_yearly
    (year, soc_code, soc_title, slug, p50_wage, n_wages, rank) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const r of payRows) {
    insPay.run(Number(r.year), r.soc_code, r.soc_title, occSlugByCode.get(r.soc_code) ?? null,
      r.p50_wage != null ? Number(r.p50_wage) : null, Number(r.n), Number(r.rk));
  }
  console.log(`[build-sqlite]   site_top_paying_occ_yearly: ${payRows.length} rows`);

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
      noteTail(r.canonical_id);
      const slug = canonicalToSlug.get(r.canonical_id)
        ?? (slugify(r.canonical_name) || `employer-${r.canonical_id}`);
      const name = canonicalToDisplay.get(r.canonical_id) ?? r.canonical_name;
      insOccEmp.run(r.soc_code, slug, name, Number(r.filings), Number(r.rk));
    }
    console.log(`[build-sqlite]   occupation_top_employer: ${occEmps.length} rows`);

    /* -- occupation_yearly ---------------------------------------------- */
    const { rows: occYears } = await pg.query<{ soc_code: string; year: number;
      n: string | null; p25_wage: number | null; median_wage: number | null;
      p75_wage: number | null }>(`
      SELECT soc_code, year, n::text, p25_wage, median_wage, p75_wage
      FROM   analytics.mv_wage_by_soc_year
      WHERE  soc_code = ANY($1::text[]) ORDER BY soc_code, year
    `, [occCodes]);
    const insOccYear = db.prepare(`INSERT INTO occupation_yearly
      (soc_code, year, filings, p25_wage, median_wage, p75_wage) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const r of occYears) {
      insOccYear.run(r.soc_code, Number(r.year),
        r.n != null ? Number(r.n) : null,
        r.p25_wage ?? null, r.median_wage ?? null, r.p75_wage ?? null);
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
      noteTail(r.canonical_id);
      const slug = canonicalToSlug.get(r.canonical_id)
        ?? (slugify(r.canonical_name) || `employer-${r.canonical_id}`);
      const name = canonicalToDisplay.get(r.canonical_id) ?? r.canonical_name;
      insStEmp.run(r.state, slug, name, Number(r.filings),
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
      noteTail(r.canonical_id);
      const slug = canonicalToSlug.get(r.canonical_id)
        ?? (slugify(r.canonical_name) || `employer-${r.canonical_id}`);
      const name = canonicalToDisplay.get(r.canonical_id) ?? r.canonical_name;
      insSecEmp.run(r.sector, slug, name, Number(r.filings), Number(r.rk));
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

  /* -- tail employers (referenced by cross-refs but not in global top-N) -- */
  // Cross-ref tables (state/occupation/sector_top_employer) can link to
  // employers that aren't in the global top-N. Without a row in `employer`
  // those `/employer/<slug>` links 404. Backfill them here with the same
  // outcomes data + rank=NULL so they don't show up in /employer index but
  // do generate static params + render their detail page.
  if (tailEmployerIds.size > 0) {
    const tailIds = Array.from(tailEmployerIds);
    const { rows: tailRows } = await pg.query<{
      id: string; canonical_name: string; employer_state: string | null;
      fein: string | null; filings: string;
      certified_pct: string | null; withdrawn_pct: string | null;
      cert_withdrawn_pct: string | null; denied_pct: string | null;
    }>(`
      SELECT eo.id::text, eo.canonical_name, eo.employer_state, eo.fein,
             eo.filings::text, eo.certified_pct::text, eo.withdrawn_pct::text,
             eo.cert_withdrawn_pct::text, eo.denied_pct::text
      FROM   analytics.mv_employer_outcomes eo
      WHERE  eo.id::text = ANY($1::text[])
    `, [tailIds]);

    // Same disambiguation as top-N, but resolved against the existing
    // top-N display names so a tail "AMAZON" doesn't shadow an already
    // disambiguated top-N "AMAZON.COM SERVICES LLC (WA)" slug.
    const insertTail = db.prepare(`INSERT OR IGNORE INTO employer
      (slug, canonical_id, canonical_name, employer_state, fein, filings,
       certified_pct, withdrawn_pct, cert_withdrawn_pct, denied_pct,
       first_year, last_year, rank)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);

    let tailInserted = 0;
    for (const r of tailRows) {
      let slug = slugify(r.canonical_name) || `employer-${r.id}`;
      const n = (slugsSeen.get(slug) ?? 0) + 1;
      slugsSeen.set(slug, n);
      if (n > 1) slug = `${slug}-${n}`;
      canonicalToSlug.set(r.id, slug);

      // Tail employers rarely collide on canonical_name (top-N pre-claims
      // the common ones), so we use the raw name. If a future build wants
      // FEIN/state disambiguation for tails too, mirror the top-N logic.
      const displayName = r.canonical_name;
      canonicalToDisplay.set(r.id, displayName);

      insertTail.run(
        slug, r.id, displayName, r.employer_state, r.fein,
        Number(r.filings),
        toNumOrNull(r.certified_pct), toNumOrNull(r.withdrawn_pct),
        toNumOrNull(r.cert_withdrawn_pct), toNumOrNull(r.denied_pct),
        null, null,
      );
      tailInserted += 1;
    }
    console.log(`[build-sqlite]   employer (tail): ${tailInserted} rows (referenced by cross-refs, rank=NULL)`);

    /* -- tail employers: top-SOC breakdown ------------------------------- */
    // `mv_top_employers_by_soc` only includes the top-N employers PER SOC,
    // so tail employers usually aren't there. Compute from lca_records
    // directly using the expression index on canonical_employer_id.
    const tailIdList = tailIds;
    const { rows: tailSocs } = await pg.query<{ canonical_id: string;
      soc_code: string; soc_title: string | null;
      filings: string; rk: number }>(`
      WITH ranked AS (
        SELECT r.data->>'canonical_employer_id' AS canonical_id,
               r.data->>'soc_code'              AS soc_code,
               count(*)::text                    AS filings,
               row_number() OVER (
                 PARTITION BY r.data->>'canonical_employer_id'
                 ORDER BY count(*) DESC) AS rk
        FROM   lca_records r
        WHERE  r.data->>'canonical_employer_id' = ANY($1::text[])
          AND  r.data->>'soc_code' IS NOT NULL
        GROUP  BY 1, 2
      )
      SELECT r.canonical_id, r.soc_code,
             (SELECT s.soc_title FROM analytics.mv_soc_summary s WHERE s.soc_code = r.soc_code LIMIT 1) AS soc_title,
             r.filings, r.rk::int
      FROM   ranked r WHERE rk <= 10
      ORDER  BY canonical_id, rk
    `, [tailIdList]);
    const insTailSoc = db.prepare(`INSERT OR IGNORE INTO employer_top_soc
      (employer_slug, soc_code, soc_title, filings, rank) VALUES (?, ?, ?, ?, ?)`);
    let tailSocCount = 0;
    for (const r of tailSocs) {
      const slug = canonicalToSlug.get(r.canonical_id);
      if (!slug) continue;
      insTailSoc.run(slug, r.soc_code, r.soc_title, Number(r.filings), Number(r.rk));
      tailSocCount += 1;
    }
    console.log(`[build-sqlite]   employer_top_soc (tail): ${tailSocCount} rows`);

    /* -- tail employers: yearly trend + outcome counts ------------------- */
    // Mirror the FILTER logic from mv_employer_growth_by_year (which is top-300
    // only) so tail employers also carry per-year outcome counts for the hero.
    const { rows: tailYears } = await pg.query<{ canonical_id: string;
      year: number; filings: string; certified: string; withdrawn: string;
      cert_withdrawn: string; denied: string }>(`
      SELECT r.data->>'canonical_employer_id' AS canonical_id,
             r.filing_year::int               AS year,
             count(*)::text                    AS filings,
             count(*) FILTER (WHERE r.data->>'CASE_STATUS' = 'Certified')::text            AS certified,
             count(*) FILTER (WHERE r.data->>'CASE_STATUS' = 'Withdrawn')::text            AS withdrawn,
             count(*) FILTER (WHERE r.data->>'CASE_STATUS' = 'Certified - Withdrawn')::text AS cert_withdrawn,
             count(*) FILTER (WHERE r.data->>'CASE_STATUS' = 'Denied')::text               AS denied
      FROM   lca_records r
      WHERE  r.data->>'canonical_employer_id' = ANY($1::text[])
        AND  r.filing_year IS NOT NULL
      GROUP  BY 1, 2
      ORDER  BY 1, 2
    `, [tailIdList]);
    const insTailYear = db.prepare(`INSERT OR IGNORE INTO employer_yearly
      (employer_slug, year, filings, certified, withdrawn, cert_withdrawn, denied)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const tailYearRange = new Map<string, { min: number; max: number }>();
    let tailYearCount = 0;
    for (const r of tailYears) {
      const slug = canonicalToSlug.get(r.canonical_id);
      if (!slug) continue;
      insTailYear.run(slug, Number(r.year), Number(r.filings),
        Number(r.certified), Number(r.withdrawn), Number(r.cert_withdrawn), Number(r.denied));
      tailYearCount += 1;
      const ex = tailYearRange.get(slug);
      if (!ex) tailYearRange.set(slug, { min: r.year, max: r.year });
      else { ex.min = Math.min(ex.min, r.year); ex.max = Math.max(ex.max, r.year); }
    }
    const updTailRange = db.prepare(`UPDATE employer SET first_year = ?, last_year = ? WHERE slug = ?`);
    for (const [slug, { min, max }] of tailYearRange) updTailRange.run(min, max, slug);
    console.log(`[build-sqlite]   employer_yearly (tail): ${tailYearCount} rows`);
  }

  /* -- SEO: 301 redirects for slugs that dropped out of the top-N -------- */
  // For each kind, walk the union of (past entity slugs ∪ past redirect
  // sources). If a historical slug is NOT present in the new build, ensure
  // a redirect row exists. If it IS present (rejoined the top-N), no row →
  // the entity page resolves normally again.
  const insRedirect = db.prepare(`INSERT INTO redirects
    (source_path, target_path, reason, added_at) VALUES (?, ?, ?, ?)`);

  let redirectCount = 0;
  for (const kind of KINDS) {
    const newSlugs = new Set(
      (db.prepare(`SELECT slug FROM ${kind}`).all() as Array<{ slug: string }>).map((r) => r.slug),
    );
    const everExisted = new Set(past.slugs[kind]);
    const prefix = `/${kind}/`;
    for (const src of past.redirects.keys()) {
      if (src.startsWith(prefix)) everExisted.add(src.slice(prefix.length));
    }
    for (const slug of everExisted) {
      if (newSlugs.has(slug)) continue;          // slug rejoined → no redirect
      const sourcePath = `${prefix}${slug}`;
      // Prefer redirecting to the most recent archive that still has this
      // slug (an actual page with the entity's data). Fall back to the
      // parent list page if no archive has it.
      const archiveLabel = findArchiveWithSlug(kind, slug);
      const targetPath = archiveLabel
        ? `/archive/${archiveLabel}/${kind}/${slug}`
        : (past.redirects.get(sourcePath) ?? `/${kind}`);
      const reason = archiveLabel ? `archived-in-${archiveLabel}` : 'dropped-from-top-N';
      insRedirect.run(sourcePath, targetPath, reason, now);
      redirectCount++;
    }
  }
  console.log(`[build-sqlite]   redirects: ${redirectCount} rows`);

  /* -- Snapshot: copy the fresh lca.db into data/archives/YYYY-qN ------- */
  // Done LAST so the archive is byte-identical to what we just built.
  // Same-quarter rebuilds overwrite the current quarter's archive.
  const label = quarterLabel(now);
  if (!existsSync(ARCHIVES_DIR)) mkdirSync(ARCHIVES_DIR, { recursive: true });
  const archivePath = path.join(ARCHIVES_DIR, `${label}.lca.db`);
  // db.close() runs in the finalize step below, but the file on disk is
  // already complete at this point because every INSERT has flushed.

  /* -- finalize ---------------------------------------------------------- */
  db.exec('ANALYZE');
  db.close();
  await closePool();

  // Now that the file is closed and flushed, copy to archives/.
  copyFileSync(DB_PATH, archivePath);
  console.log(`[build-sqlite]   archived as: ${label}.lca.db`);

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
