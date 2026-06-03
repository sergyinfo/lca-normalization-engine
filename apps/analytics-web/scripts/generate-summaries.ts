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

  const jobs = collectJobs(db);
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
  if (failed > 0) process.exitCode = 1;
}

/** Idempotently add the meta columns (no-op if build-sqlite already created them). */
function ensureSchema(db: DatabaseSync) {
  for (const col of ['meta_title TEXT', 'meta_description TEXT', 'keywords TEXT']) {
    try { db.exec(`ALTER TABLE entity_summary ADD COLUMN ${col}`); } catch { /* already exists */ }
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
    const yearly  = db.prepare(`SELECT year, filings FROM employer_yearly
                                  WHERE employer_slug = ? ORDER BY year`).all(slug);
    jobs.push({ kind: 'employer', slug, payload: { ...r, top_socs: topSocs, yearly_volume: yearly } });
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
    jobs.push({ kind: 'occupation', slug, payload: { ...r, wage_levels: levels, top_states: topStates, top_employers: topEmps } });
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
    jobs.push({ kind: 'state', slug, payload: { ...r, top_employers: topEmps, top_occupations: topSocs } });
  }

  const secs = db.prepare(`SELECT naics2, slug, label, filings, employers FROM sector`).all();
  for (const r of secs as Array<Record<string, unknown>>) {
    jobs.push({ kind: 'sector', slug: String(r.slug), payload: r });
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