/**
 * Quarterly SEO-content generator.
 *
 * Opens lca.db (read-write), iterates every entity row, computes a
 * deterministic data_hash from the data payload (+ PROMPT_VERSION), and — only
 * for rows whose hash changed since the last run — asks Claude to write the
 * page summary AND the SEO meta (title + description + keywords) in one
 * structured call. Skip-if-unchanged means a re-run with no data change costs
 * zero API calls.
 *
 * Run after `build-sqlite.ts`. Results land in `entity_summary`; pages render
 * the summary via `getEntitySummary()` and use the meta in `generateMetadata`.
 *
 * Modes (LLM_MODE):
 *   batch (default) — Message Batches API, 50% off; ideal for the whole-site
 *                     quarterly rebuild. Submits all changed rows, polls, upserts.
 *   sync            — one request at a time (LLM_CONCURRENCY workers); for small
 *                     incremental runs / on-publish.
 * With LLM_PROVIDER != anthropic (or no key) it writes deterministic stubs.
 */

import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROMPT_VERSION, isAnthropicConfigured, generateOne, generateBatch, stubContent,
  type SeoJob, type SeoResult,
} from '../lib/llm/seo-content.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'lca.db');
const CONCURRENCY = Number(process.env.LLM_CONCURRENCY ?? 6);
const MODE = (process.env.LLM_MODE ?? 'batch').toLowerCase(); // batch | sync

async function main() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = MEMORY');
  db.exec('PRAGMA synchronous = OFF');
  ensureSchema(db);

  const useApi = isAnthropicConfigured();
  console.log(`[seo] provider=${useApi ? 'anthropic' : 'stub'} mode=${useApi ? MODE : 'stub'} prompt=${PROMPT_VERSION}`);

  const jobs = [...collectJobs(db), ...collectPageJobs(db)];
  const existing = db.prepare('SELECT data_hash FROM entity_summary WHERE kind = ? AND slug = ?');

  // Partition into changed (need generation) vs unchanged (skip — zero cost).
  let changed: Array<{ job: SeoJob; hash: string }> = [];
  let skipped = 0;
  for (const job of jobs) {
    const hash = hashPayload(job.payload);
    const prev = existing.get(job.kind, job.slug) as { data_hash: string } | undefined;
    if (prev && prev.data_hash === hash) { skipped++; continue; }
    changed.push({ job, hash });
  }
  console.log(`[seo] ${jobs.length} entities — ${changed.length} changed, ${skipped} unchanged (skipped).`);
  const limit = Number(process.env.LLM_LIMIT ?? 0);
  if (limit > 0 && changed.length > limit) {
    changed = changed.slice(0, limit);
    console.log(`[seo] LLM_LIMIT=${limit} — capping to ${changed.length} this run.`);
  }
  if (changed.length === 0) { db.close(); console.log('[seo] nothing to do.'); return; }

  const upsert = db.prepare(`
    INSERT INTO entity_summary (kind, slug, summary_md, meta_title, meta_description, keywords, data_hash, generated_at, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, slug) DO UPDATE SET
      summary_md       = excluded.summary_md,
      meta_title       = excluded.meta_title,
      meta_description = excluded.meta_description,
      keywords         = excluded.keywords,
      data_hash        = excluded.data_hash,
      generated_at     = excluded.generated_at,
      model            = excluded.model
  `);
  const write = (job: SeoJob, hash: string, r: SeoResult) => {
    upsert.run(
      job.kind, job.slug,
      r.content.summary_md, r.content.meta_title, r.content.meta_description,
      JSON.stringify(r.content.keywords), hash,
      Math.floor(Date.now() / 1000), r.model,
    );
  };

  let written = 0, failed = 0;

  if (!useApi) {
    for (const { job, hash } of changed) { write(job, hash, stubContent(job)); written++; }
  } else if (MODE === 'sync') {
    const queue = [...changed];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) break;
        try { write(item.job, item.hash, await generateOne(item.job)); written++; }
        catch (err) { failed++; console.error(`[seo] FAIL ${item.job.kind}/${item.job.slug}:`, (err as Error).message); }
        if ((written + failed) % 25 === 0) console.log(`[seo]   ${written} written, ${failed} failed`);
      }
    }));
  } else {
    // batch
    const results = await generateBatch(
      changed.map((c) => c.job),
      (status, ok, total) => console.log(`[seo]   batch ${status}: ${ok}/${total} succeeded`),
    );
    changed.forEach(({ job, hash }, i) => {
      const r = results.get(i);
      if (r) { write(job, hash, r); written++; } else { failed++; console.error(`[seo] no result for ${job.kind}/${job.slug}`); }
    });
  }

  db.exec('ANALYZE');
  db.close();
  console.log(`[seo] Done. written=${written}, skipped=${skipped}, failed=${failed}`);
  // A handful of entities can come back empty from the batch (odd legal names,
  // content filters) — that's cosmetic: the page falls back to default meta. Only
  // treat it as a build failure if a large fraction failed (systemic: bad key / API
  // down), not on sparse misses that would needlessly abort the candidate deploy.
  const failRate = changed.length ? failed / changed.length : 0;
  if (failed > 0) console.warn(`[seo] ${failed}/${changed.length} had no result (non-fatal; pages fall back to default meta).`);
  if (failRate > 0.05) {
    console.error(`[seo] ${(failRate * 100).toFixed(1)}% of summaries failed — treating as systemic.`);
    process.exitCode = 1;
  }
}

/** Idempotently add meta columns + drop the legacy kind CHECK (so page-level
 *  kinds like 'index'/'ranking'/'compare-*' can be inserted into an old db). */
function ensureSchema(db: DatabaseSync) {
  for (const col of ['meta_title TEXT', 'meta_description TEXT', 'keywords TEXT']) {
    try { db.exec(`ALTER TABLE entity_summary ADD COLUMN ${col}`); } catch { /* already exists */ }
  }
  // SQLite can't ALTER a CHECK constraint — recreate the table, preserving rows.
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entity_summary'").get() as { sql?: string } | undefined;
  if (row?.sql && /CHECK\s*\(\s*kind/i.test(row.sql)) {
    db.exec('BEGIN');
    db.exec(`CREATE TABLE entity_summary__new (
      kind TEXT NOT NULL, slug TEXT NOT NULL, summary_md TEXT NOT NULL,
      meta_title TEXT, meta_description TEXT, keywords TEXT,
      data_hash TEXT NOT NULL, generated_at INTEGER NOT NULL, model TEXT,
      PRIMARY KEY (kind, slug))`);
    db.exec(`INSERT INTO entity_summary__new
      SELECT kind, slug, summary_md, meta_title, meta_description, keywords, data_hash, generated_at, model
      FROM entity_summary`);
    db.exec('DROP TABLE entity_summary');
    db.exec('ALTER TABLE entity_summary__new RENAME TO entity_summary');
    db.exec('COMMIT');
    console.log('[seo] migrated entity_summary — dropped legacy kind CHECK.');
  }
}

function collectJobs(db: DatabaseSync): SeoJob[] {
  const jobs: SeoJob[] = [];

  const kpi = db.prepare(`SELECT total_records, canonical_employers, distinct_socs,
                                  first_year, last_year, median_wage FROM site_kpis`).get();
  if (kpi) jobs.push({ kind: 'site', slug: 'home', payload: kpi as Record<string, unknown> });

  const emps = db.prepare(`SELECT slug, canonical_name, employer_state, filings,
                                  certified_pct, withdrawn_pct, denied_pct,
                                  first_year, last_year FROM employer`).all();
  for (const r of emps as Array<Record<string, unknown>>) {
    const slug = String(r.slug);
    const topSocs = db.prepare(`SELECT soc_code, soc_title, filings FROM employer_top_soc
                                  WHERE employer_slug = ? ORDER BY rank LIMIT 5`).all(slug);
    const yearly  = db.prepare(`SELECT year, filings, certified, withdrawn, cert_withdrawn, denied
                                  FROM employer_yearly WHERE employer_slug = ? ORDER BY year`)
                      .all(slug) as Array<Record<string, number>>;
    const ly = yearly.at(-1);
    const latest_year = ly ? {
      year: ly.year, filings: ly.filings,
      certified_pct: pct(ly.certified, ly.filings),
      withdrawn_pct: pct(ly.withdrawn, ly.filings),
      denied_pct: pct(ly.denied, ly.filings),
    } : null;
    jobs.push({ kind: 'employer', slug, payload: {
      ...r, top_socs: topSocs,
      yearly_volume: yearly.map((y) => ({ year: y.year, filings: y.filings })),
      latest_year,
    } });
  }

  const occs = db.prepare(`SELECT soc_code, slug, soc_title, filings, n_wages,
                                   p25_wage, p50_wage, p75_wage FROM occupation`).all();
  for (const r of occs as Array<Record<string, unknown>>) {
    const code = String(r.soc_code);
    const slug = String(r.slug);
    const levels = db.prepare(`SELECT wage_level, p25_wage, p50_wage, p75_wage
                                 FROM occupation_level WHERE soc_code = ? ORDER BY wage_level`).all(code);
    const topStates = db.prepare(`SELECT state, filings, p50_wage FROM occupation_top_state
                                     WHERE soc_code = ? ORDER BY rank LIMIT 5`).all(code);
    const topEmps  = db.prepare(`SELECT canonical_name, filings FROM occupation_top_employer
                                    WHERE soc_code = ? ORDER BY rank LIMIT 5`).all(code);
    const oy = db.prepare(`SELECT year, filings, p25_wage, median_wage, p75_wage
                             FROM occupation_yearly WHERE soc_code = ? ORDER BY year`)
                 .all(code) as Array<Record<string, number>>;
    const oly = oy.at(-1);
    const latest_year = oly ? {
      year: oly.year, filings: oly.filings,
      p25_wage: oly.p25_wage, median_wage: oly.median_wage, p75_wage: oly.p75_wage,
    } : null;
    jobs.push({ kind: 'occupation', slug, payload: { ...r, wage_levels: levels, top_states: topStates, top_employers: topEmps, latest_year } });
  }

  const states = db.prepare(`SELECT code, slug, name, filings FROM state`).all();
  for (const r of states as Array<Record<string, unknown>>) {
    const code = String(r.code);
    const slug = String(r.slug);
    const topEmps = db.prepare(`SELECT canonical_name, filings, share_pct
                                  FROM state_top_employer WHERE state_code = ?
                                  ORDER BY rank LIMIT 5`).all(code);
    const topSocs = db.prepare(`SELECT soc_code, soc_title, filings
                                  FROM state_top_occupation WHERE state_code = ?
                                  ORDER BY rank LIMIT 5`).all(code);
    const sy = db.prepare(`SELECT year, filings FROM state_yearly WHERE state_code = ? ORDER BY year`)
                 .all(code) as Array<Record<string, number>>;
    const sly = sy.at(-1);
    const latest_year = sly ? { year: sly.year, filings: sly.filings } : null;
    jobs.push({ kind: 'state', slug, payload: { ...r, top_employers: topEmps, top_occupations: topSocs, latest_year } });
  }

  const secs = db.prepare(`SELECT naics2, slug, label, filings, employers FROM sector`).all();
  for (const r of secs as Array<Record<string, unknown>>) {
    const cy = db.prepare(`SELECT year, filings FROM sector_yearly WHERE naics2 = ? ORDER BY year`)
                 .all(String(r.naics2)) as Array<Record<string, number>>;
    const cly = cy.at(-1);
    const latest_year = cly ? { year: cly.year, filings: cly.filings } : null;
    jobs.push({ kind: 'sector', slug: String(r.slug), payload: { ...r, latest_year } });
  }

  return jobs;
}

/** Percentage (0–100, one decimal) of n over d; null when d is 0. */
function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((1000 * n) / d) / 10 : null;
}

/** Page-level summaries: index pages, ranking pages, and featured comparisons. */
function collectPageJobs(db: DatabaseSync): SeoJob[] {
  const jobs: SeoJob[] = [];
  const all = (sql: string) => db.prepare(sql).all();
  const count = (t: string) => (db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;
  const kpis = db.prepare(`SELECT total_records, canonical_employers, distinct_socs, first_year, last_year, median_wage FROM site_kpis`).get() ?? {};

  // ---- Index / directory pages ------------------------------------------
  jobs.push({ kind: 'index', slug: 'employer',
    instruction: 'Page: the H-1B sponsors directory (a searchable, sortable table of every sponsoring employer). Summarize the sponsor landscape — how many sponsors are tracked and who the largest are. Title like "H-1B Sponsors — Employer Directory".',
    payload: { page: 'sponsors index', total_sponsors: count('employer'), top_by_filings: all(`SELECT canonical_name, employer_state, filings, certified_pct FROM employer ORDER BY filings DESC LIMIT 12`) } });
  jobs.push({ kind: 'index', slug: 'occupation',
    instruction: 'Page: the H-1B occupations directory (all SOC occupations, sortable by filings and median wage). Summarize the most common roles and the wage spread. Title like "H-1B Occupations & Salary Guides".',
    payload: { page: 'occupations index', total_occupations: count('occupation'), top_by_filings: all(`SELECT soc_code, soc_title, filings, p50_wage FROM occupation ORDER BY filings DESC LIMIT 12`) } });
  jobs.push({ kind: 'index', slug: 'state',
    instruction: 'Page: the H-1B states directory (all US states by worksite filings). Summarize the geographic concentration of H-1B work. Title like "H-1B Filings by State".',
    payload: { page: 'states index', total_states: count('state'), top_by_filings: all(`SELECT code, name, filings FROM state ORDER BY filings DESC LIMIT 12`) } });
  jobs.push({ kind: 'index', slug: 'sector',
    instruction: 'Page: the H-1B sectors directory (NAICS industry breakdown). Summarize which industries dominate H-1B sponsorship. Title like "H-1B Sponsorship by Industry".',
    payload: { page: 'sectors index', total_sectors: count('sector'), top_by_filings: all(`SELECT naics2, label, filings, employers FROM sector ORDER BY filings DESC LIMIT 12`) } });

  // ---- Ranking / leaderboard pages --------------------------------------
  jobs.push({ kind: 'ranking', slug: 'highest-paying-h1b-jobs',
    instruction: 'Page: leaderboard of the highest-paying H-1B occupations by median prevailing wage. Summarize which roles top the list and the wage range. Title like "Highest-Paying H-1B Jobs".',
    payload: { ranking: 'highest-paying occupations', top: all(`SELECT soc_code, soc_title, p50_wage, filings FROM occupation WHERE p50_wage IS NOT NULL AND filings >= 50 ORDER BY p50_wage DESC LIMIT 15`) } });
  jobs.push({ kind: 'ranking', slug: 'top-h1b-sponsors',
    instruction: 'Page: leaderboard of the largest H-1B sponsoring employers by filings. Summarize who leads and the scale. Title like "Top H-1B Sponsors".',
    payload: { ranking: 'top sponsors', top: all(`SELECT canonical_name, employer_state, filings, certified_pct FROM employer ORDER BY filings DESC LIMIT 15`) } });
  jobs.push({ kind: 'ranking', slug: 'top-h1b-states',
    instruction: 'Page: leaderboard of US states by H-1B worksite filings. Summarize the leading states. Title like "Top H-1B States".',
    payload: { ranking: 'top states', top: all(`SELECT code, name, filings FROM state ORDER BY filings DESC LIMIT 15`) } });
  jobs.push({ kind: 'ranking', slug: 'top-h1b-occupations',
    instruction: 'Page: leaderboard of the most common H-1B occupations by filings. Summarize the dominant roles. Title like "Top H-1B Occupations".',
    payload: { ranking: 'top occupations', top: all(`SELECT soc_code, soc_title, filings, p50_wage FROM occupation ORDER BY filings DESC LIMIT 15`) } });
  jobs.push({ kind: 'ranking', slug: 'cleanest-h1b-sponsors',
    instruction: 'Page: leaderboard of "cleanest" H-1B sponsors — employers with the highest certification rate among those with meaningful volume (at least 500 filings). Summarize what stands out. Title like "Cleanest H-1B Sponsors".',
    payload: { ranking: 'highest certification rate (min 500 filings)', top: all(`SELECT canonical_name, filings, certified_pct, denied_pct FROM employer WHERE filings >= 500 ORDER BY certified_pct DESC LIMIT 15`) } });
  jobs.push({ kind: 'ranking', slug: 'h1b-by-industry',
    instruction: 'Page: H-1B sponsorship broken down by NAICS industry sector. Summarize which industries dominate and the spread. Title like "H-1B by Industry".',
    payload: { ranking: 'by industry', top: all(`SELECT naics2, label, filings, employers FROM sector ORDER BY filings DESC LIMIT 15`) } });
  jobs.push({ kind: 'ranking', slug: 'rankings',
    instruction: 'Page: the rankings hub linking to all the "best of" H-1B leaderboards (top sponsors, top occupations, top states, highest-paying jobs, cleanest sponsors, by industry). Write a short overview of the rankings the site offers. Title like "H-1B Rankings & Leaderboards".',
    payload: { page: 'rankings hub', kpis, leaderboards: ['top sponsors', 'top occupations', 'top states', 'highest-paying jobs', 'cleanest sponsors', 'by industry'] } });

  // ---- Featured comparisons (top-10 x top-10 per kind; sorted-pair key) --
  const COMPARE: Array<{ kind: string; table: string; label: string; cols: string }> = [
    { kind: 'compare-employer',   table: 'employer',   label: 'sponsors',    cols: 'slug, canonical_name, employer_state, filings, certified_pct, denied_pct, first_year, last_year' },
    { kind: 'compare-occupation', table: 'occupation', label: 'occupations', cols: 'slug, soc_code, soc_title, filings, p25_wage, p50_wage, p75_wage' },
    { kind: 'compare-state',      table: 'state',      label: 'states',      cols: 'slug, code, name, filings' },
    { kind: 'compare-sector',     table: 'sector',     label: 'sectors',     cols: 'slug, naics2, label, filings, employers' },
  ];
  for (const c of COMPARE) {
    const top = db.prepare(`SELECT ${c.cols} FROM ${c.table} ORDER BY filings DESC LIMIT 10`).all() as Array<Record<string, unknown>>;
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const x = top[i]!, y = top[j]!;
        const [s0, s1] = [String(x.slug), String(y.slug)].sort() as [string, string];
        const A = String(x.slug) === s0 ? x : y;
        const B = String(x.slug) === s0 ? y : x;
        jobs.push({
          kind: c.kind, slug: `${s0}__${s1}`,
          instruction: `Page: a side-by-side comparison of two H-1B ${c.label}. Write a short, balanced comparison contrasting the two on filings and the other figures, noting which leads on what. Title like "<A> vs <B> — H-1B Comparison".`,
          payload: { a: A, b: B },
        });
      }
    }
  }

  return jobs;
}

/** sha256 of canonical-JSON payload + PROMPT_VERSION (so prompt edits force regen). */
function hashPayload(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(`${canonical} ${PROMPT_VERSION}`).digest('hex').slice(0, 16);
}

main().catch((err) => {
  console.error('[seo] FAILED:', err);
  process.exit(1);
});