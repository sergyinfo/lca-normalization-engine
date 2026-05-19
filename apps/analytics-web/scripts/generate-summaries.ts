/**
 * Quarterly LLM summary generator.
 *
 * Opens lca.db (read-write this time), iterates every entity row, computes
 * a deterministic data_hash from the data payload, and asks the configured
 * LLM provider to write a short markdown summary IF the hash has changed
 * since the last run (skip-if-unchanged).
 *
 * Run after `build-sqlite.ts`. The generated summaries land in the
 * `entity_summary` table; pages render them through `getEntitySummary()`.
 *
 * Provider is whatever `LLM_PROVIDER` env points at. Default `stub` means
 * "no network calls, deterministic placeholder" — safe for first scaffold.
 *
 * Concurrency: a small in-process semaphore (default 4) keeps API rate
 * limits in check. With Claude Sonnet 4.6, 4 concurrent ~600-token requests
 * sits comfortably under tier-1 rate limits.
 */

import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProvider } from '../lib/llm/provider.ts';
import type { LlmProvider } from '../lib/llm/provider.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'lca.db');
const CONCURRENCY = Number(process.env.LLM_CONCURRENCY ?? 4);

const SYSTEM_PROMPT = `You are a concise data journalist writing short factual summaries for an
H-1B / LCA analytics website. Voice: neutral, informative, never speculative.
Length: 2-3 short paragraphs. Format: plain markdown. Lead with the most
search-relevant fact (the entity name and what it does). Avoid filler like
"in conclusion" or "this analysis shows". Do not invent numbers — only
reference figures present in the structured data payload.`;

interface SummaryJob {
  kind: 'employer' | 'occupation' | 'state' | 'sector' | 'site';
  slug: string;
  payload: Record<string, unknown>;
}

async function main() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = MEMORY');
  db.exec('PRAGMA synchronous = OFF');

  const provider = await getProvider();
  console.log(`[summaries] Provider: ${provider.name}, concurrency=${CONCURRENCY}`);

  const jobs = collectJobs(db);
  console.log(`[summaries] ${jobs.length} entity rows to consider.`);

  const upsert = db.prepare(`
    INSERT INTO entity_summary (kind, slug, summary_md, data_hash, generated_at, model)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, slug) DO UPDATE SET
      summary_md   = excluded.summary_md,
      data_hash    = excluded.data_hash,
      generated_at = excluded.generated_at,
      model        = excluded.model
  `);
  const existing = db.prepare(`SELECT data_hash FROM entity_summary WHERE kind = ? AND slug = ?`);

  let written = 0, skipped = 0, failed = 0;
  const queue = [...jobs];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      const hash = hashPayload(job.payload);
      const prev = existing.get(job.kind, job.slug) as { data_hash: string } | undefined;
      if (prev && prev.data_hash === hash) { skipped++; continue; }
      try {
        const out = await generate(provider, job);
        upsert.run(
          job.kind, job.slug,
          out.text, hash,
          Math.floor(Date.now() / 1000),
          out.model,
        );
        written++;
        if (written % 10 === 0) {
          console.log(`[summaries]   progress: ${written} written, ${skipped} skipped, ${failed} failed`);
        }
      } catch (err) {
        failed++;
        console.error(`[summaries] FAIL ${job.kind}/${job.slug}:`, err);
      }
    }
  });
  await Promise.all(workers);

  db.exec('ANALYZE');
  db.close();
  console.log(`[summaries] Done. written=${written}, skipped=${skipped}, failed=${failed}`);
}

function collectJobs(db: DatabaseSync): SummaryJob[] {
  const jobs: SummaryJob[] = [];

  // Site-level summary keyed by ("site", "home").
  const kpi = db.prepare(`SELECT total_records, canonical_employers, distinct_socs,
                                  first_year, last_year, median_wage FROM site_kpis`).get();
  if (kpi) jobs.push({ kind: 'site', slug: 'home', payload: kpi as Record<string, unknown> });

  // Employer summaries.
  const emps = db.prepare(`SELECT slug, canonical_name, employer_state, filings,
                                  certified_pct, withdrawn_pct, denied_pct,
                                  first_year, last_year FROM employer`).all();
  for (const r of emps as Array<Record<string, unknown>>) {
    const slug = String(r.slug);
    const topSocs = db.prepare(`SELECT soc_code, soc_title, filings FROM employer_top_soc
                                  WHERE employer_slug = ? ORDER BY rank LIMIT 5`).all(slug);
    const yearly  = db.prepare(`SELECT year, filings FROM employer_yearly
                                  WHERE employer_slug = ? ORDER BY year`).all(slug);
    jobs.push({
      kind: 'employer', slug,
      payload: { ...r, top_socs: topSocs, yearly_volume: yearly },
    });
  }

  // Occupation summaries (keyed by SEO slug).
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
    jobs.push({
      kind: 'occupation', slug,
      payload: { ...r, wage_levels: levels, top_states: topStates, top_employers: topEmps },
    });
  }

  // State summaries (keyed by SEO slug).
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
    jobs.push({
      kind: 'state', slug,
      payload: { ...r, top_employers: topEmps, top_occupations: topSocs },
    });
  }

  // Sector summaries (keyed by SEO slug).
  const secs = db.prepare(`SELECT naics2, slug, label, filings, employers FROM sector`).all();
  for (const r of secs as Array<Record<string, unknown>>) {
    jobs.push({ kind: 'sector', slug: String(r.slug), payload: r });
  }

  return jobs;
}

function hashPayload(payload: unknown): string {
  const canonical = JSON.stringify(payload, Object.keys(payload as object).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

async function generate(provider: LlmProvider, job: SummaryJob) {
  const userPrompt = renderPrompt(job);
  return provider.generate({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 600,
    temperature: 0.3,
  });
}

function renderPrompt(job: SummaryJob): string {
  switch (job.kind) {
    case 'employer':
      return `Write a 2-3 paragraph profile of this H-1B sponsor based on the data below.
Open with what the company appears to be and how active it is in the H-1B program.
End with one paragraph on the role mix and certification record.

Data:
${JSON.stringify(job.payload, null, 2)}`;

    case 'occupation':
      return `Write a 2-3 paragraph salary guide for this SOC occupation in the US H-1B program.
Cover: typical wage range (P25–P75), wage progression across DOL levels I→IV,
top hiring states, top employers. Keep it factual and useful for someone
researching the role.

Data:
${JSON.stringify(job.payload, null, 2)}`;

    case 'state':
      return `Write a 2-3 paragraph overview of H-1B sponsorship activity in this US state.
Cover: total filing volume, top sponsoring employers (and any concentration),
top occupations sponsored.

Data:
${JSON.stringify(job.payload, null, 2)}`;

    case 'sector':
      return `Write a 2-3 paragraph overview of H-1B sponsorship in this NAICS sector.
Cover: what the sector is, total filings, how many distinct employers
participate, what that implies about labour demand.

Data:
${JSON.stringify(job.payload, null, 2)}`;

    case 'site':
      return `Write a 2-3 paragraph "what this site covers" summary suitable for the
homepage of an H-1B / LCA analytics site. Cover: years of data, total
disclosures, distinct sponsors and occupations, what kinds of questions
the site helps answer.

Data:
${JSON.stringify(job.payload, null, 2)}`;
  }
}

main().catch((err) => {
  console.error('[summaries] FAILED:', err);
  process.exit(1);
});
