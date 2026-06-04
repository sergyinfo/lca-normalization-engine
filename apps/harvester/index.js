#!/usr/bin/env node
/**
 * harvester — DOL Website Monitor
 *
 * Periodically scrapes the Department of Labor OFLC performance page, finds new
 * LCA disclosure files, DOWNLOADS them, and enqueues ingest tasks in BullMQ.
 *
 * SCOPING (important — the page links many programs/years):
 *   - Only files whose name matches HARVEST_FILE_PATTERN are considered. The
 *     default matches H-1B LCA *Disclosure* files (FLAG era), e.g.
 *     `LCA_Disclosure_Data_FY2024_Q4.xlsx`. The capture group is the year.
 *   - Only files with filing_year >= HARVEST_START_YEAR (default 2020) are taken.
 *     Lower the floor to pull older years — but note pre-2020 files use a
 *     different (pre-FLAG) layout that the ingestor does not yet map correctly.
 *
 * Flow per poll:
 *   1. Fetch the DOL page (with a browser User-Agent — the page is bot-gated).
 *   2. Parse every .xlsx link; THROW if zero links (blocked/changed page) so the
 *      failure is loud, not a silent count=0.
 *   3. Keep only in-scope links not already in `harvested_files`.
 *   4. Download each to LOCAL_FILES_DIR and enqueue an `ingest` job pointing at
 *      the CONTAINER path the ingestor mounts.
 *   5. Emit a structured summary. With HARVEST_ONCE=1, exit after one poll.
 *
 * The long-running poller is for production. HARVEST_ONCE=1 (`harvest:once`) is
 * what the ephemeral burst EC2 runs for a single release.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Queue } from 'bullmq';
import { fetch } from 'undici';
import { parse as parseHtml } from 'node-html-parser';
import IORedis from 'ioredis';
import pino from 'pino';
import { pool } from '@lca/db-lib';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DOL_BASE_URL =
  process.env.DOL_BASE_URL ??
  'https://www.dol.gov/agencies/eta/foreign-labor/performance';
const POLL_INTERVAL_MS = Number(process.env.HARVESTER_POLL_INTERVAL_MS ?? 3_600_000);
const INGEST_QUEUE = 'ingest-tasks';

// ----- Scoping -------------------------------------------------------------
const START_YEAR = Number(process.env.HARVEST_START_YEAR ?? 2020);
// Default: H-1B LCA Disclosure files (FLAG era). Capture group 1 = filing year.
const FILE_PATTERN = new RegExp(
  process.env.HARVEST_FILE_PATTERN ?? 'LCA_Disclosure_Data_FY(20\\d{2})',
  'i',
);
const RUN_ONCE = /^(1|true|yes)$/i.test(process.env.HARVEST_ONCE ?? '');
// Re-ingest (supersede) a year that already has data but was never recorded in
// harvested_files (e.g. the historical 2020-2025 backfill done via cli-tool).
// OFF by default so the first production harvest never clobbers historical data.
const SUPERSEDE_UNTRACKED = /^(1|true|yes)$/i.test(process.env.HARVEST_SUPERSEDE_UNTRACKED ?? '');
const LOCAL_FILES_DIR = process.env.LOCAL_FILES_DIR ?? './data';
const CONTAINER_MOUNT_DIR = process.env.CONTAINER_MOUNT_DIR ?? '/data';
// The DOL page rejects non-browser agents (returns a tiny stub), so present one.
const USER_AGENT =
  process.env.HARVEST_USER_AGENT ??
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const ingestQueue = new Queue(INGEST_QUEUE, { connection: redis });

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function ensureHarvestedFilesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS harvested_files (
      url         TEXT PRIMARY KEY,
      file_name   TEXT NOT NULL,
      filing_year SMALLINT,
      quarter     SMALLINT,
      enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Backfill the column on pre-existing tables.
  await pool.query('ALTER TABLE harvested_files ADD COLUMN IF NOT EXISTS quarter SMALLINT;');
}

async function isAlreadyHarvested(url) {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM harvested_files WHERE url = $1',
    [url],
  );
  return rowCount > 0;
}

async function markHarvested(url, fileName, filingYear, quarter) {
  await pool.query(
    `INSERT INTO harvested_files (url, file_name, filing_year, quarter)
     VALUES ($1, $2, $3, $4) ON CONFLICT (url) DO NOTHING`,
    [url, fileName, filingYear ?? null, quarter ?? null],
  );
}

/** Does lca_records already hold any rows for this fiscal year? */
async function yearHasData(year) {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM lca_records WHERE filing_year = $1 LIMIT 1',
    [year],
  );
  return rowCount > 0;
}

/** Highest quarter this harvester has already ingested for a year (or null). */
async function lastHarvestedQuarter(year) {
  const { rows } = await pool.query(
    'SELECT max(quarter) AS q FROM harvested_files WHERE filing_year = $1',
    [year],
  );
  return rows[0]?.q ?? null;
}

// ---------------------------------------------------------------------------
// Scraping + scoping
// ---------------------------------------------------------------------------

/**
 * Fetches the DOL page and returns ALL .xlsx links. Throws on a non-OK
 * response or when zero links are found (a strong signal the page is bot-gated
 * or its structure changed — we want that to fail loudly, not no-op).
 *
 * @returns {Promise<Array<{ url: string, fileName: string }>>}
 */
async function scrapeAllXlsxLinks() {
  log.info({ url: DOL_BASE_URL }, 'harvester.scrape.start');
  const response = await fetch(DOL_BASE_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  });
  if (!response.ok) {
    throw new Error(`DOL page returned HTTP ${response.status}`);
  }
  const html = await response.text();
  const root = parseHtml(html);

  const links = [];
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? '';
    if (!href.toLowerCase().endsWith('.xlsx')) continue;
    const url = href.startsWith('http') ? href : `https://www.dol.gov${href}`;
    const fileName = url.split('/').pop() ?? url;
    links.push({ url, fileName });
  }

  if (links.length === 0) {
    throw new Error(
      `DOL page yielded 0 .xlsx links (${html.length} bytes) — likely blocked or restructured.`,
    );
  }
  log.info({ count: links.length }, 'harvester.scrape.done');
  return links;
}

/** Quarter from a disclosure filename; annual files (no _Q) = 4 (full year). */
function parseQuarter(fileName) {
  const qm = fileName.match(/_Q([1-4])/i);
  return qm ? Number(qm[1]) : 4;
}

/** Keep only LCA Disclosure files at/above the year floor. */
function scopeLinks(links) {
  const inScope = [];
  for (const { url, fileName } of links) {
    const m = fileName.match(FILE_PATTERN);
    if (!m) continue;                       // wrong program / not a disclosure file
    const filingYear = m[1] ? Number(m[1]) : null;
    if (filingYear == null || filingYear < START_YEAR) continue;
    inScope.push({ url, fileName, filingYear, quarter: parseQuarter(fileName) });
  }
  return inScope;
}

/**
 * The DOL quarterly files are CUMULATIVE within a fiscal year (Q4 ⊃ Q3 ⊃ … ⊃ Q1;
 * an annual file = the full year). Within one poll, keep only the most-complete
 * file per fiscal year so we never ingest two overlapping quarters of the same FY.
 */
function dedupePerYear(inScope) {
  const best = new Map();
  for (const f of inScope) {
    const cur = best.get(f.filingYear);
    if (!cur || f.quarter > cur.quarter) best.set(f.filingYear, f);
  }
  return [...best.values()];
}

/** Stream a remote file to LOCAL_FILES_DIR. Returns the local path. */
async function downloadFile(url, fileName) {
  fs.mkdirSync(LOCAL_FILES_DIR, { recursive: true });
  const localPath = path.join(LOCAL_FILES_DIR, fileName);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) {
    throw new Error(`download failed HTTP ${res.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(localPath));
  return localPath;
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

/** @returns {Promise<{linksTotal:number, inScope:number, downloaded:number, enqueued:number, skippedExisting:number, errors:number}>} */
async function poll() {
  log.info({ startYear: START_YEAR, pattern: FILE_PATTERN.source }, 'harvester.poll.start');
  const summary = {
    linksTotal: 0, inScope: 0, candidates: 0, downloaded: 0, enqueued: 0,
    skippedExisting: 0, skippedOlder: 0, skippedUntracked: 0, errors: 0,
  };

  const all = await scrapeAllXlsxLinks();   // throws on blocked/empty page
  summary.linksTotal = all.length;
  const inScope = scopeLinks(all);
  summary.inScope = inScope.length;
  const candidates = dedupePerYear(inScope);   // one (most-complete) file per FY
  summary.candidates = candidates.length;

  for (const { url, fileName, filingYear, quarter } of candidates) {
    if (await isAlreadyHarvested(url)) { summary.skippedExisting++; continue; }

    const existing = await yearHasData(filingYear);
    const lastQ = await lastHarvestedQuarter(filingYear);

    // Year already has data but was never recorded here (historical cli-tool
    // backfill) — don't clobber it unless explicitly told to.
    if (existing && lastQ == null && !SUPERSEDE_UNTRACKED) {
      summary.skippedUntracked++;
      log.warn({ filingYear, fileName }, 'harvester.skip.untracked_existing');
      continue;
    }
    // Already have this quarter or a newer one for this year.
    if (lastQ != null && quarter <= lastQ) { summary.skippedOlder++; continue; }

    const supersede = existing;   // replace the year if it already holds data
    try {
      const localPath = await downloadFile(url, fileName);
      summary.downloaded++;
      const containerPath = path.posix.join(CONTAINER_MOUNT_DIR, fileName);
      await ingestQueue.add(
        'ingest',
        { filePath: containerPath, localPath, sourceFile: fileName, filingYear, supersede },
        { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
      );
      await markHarvested(url, fileName, filingYear, quarter);
      summary.enqueued++;
      log.info({ url, filingYear, quarter, supersede, containerPath }, 'harvester.enqueued');
    } catch (err) {
      summary.errors++;
      log.error({ url, err: err.message }, 'harvester.file.error');
    }
  }

  log.info(summary, 'harvester.poll.done');
  // Machine-readable marker the burst greps for.
  console.log(`HARVEST_SUMMARY ${JSON.stringify(summary)}`);
  return summary;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  log.info({ runOnce: RUN_ONCE }, 'harvester.bootstrap');
  await ensureHarvestedFilesTable();

  if (RUN_ONCE) {
    const summary = await poll();           // throws bubble up to fatal handler
    await ingestQueue.close();
    await redis.quit();
    // Exit non-zero only if every in-scope file errored (a real problem);
    // "no new files" is a normal, successful outcome (exit 0).
    process.exit(summary.inScope > 0 && summary.enqueued === 0 && summary.errors > 0 ? 1 : 0);
  }

  // Long-running poller (production). A poll error is logged, not fatal.
  const safePoll = async () => { try { await poll(); } catch (err) { log.error({ err: err.message }, 'harvester.poll.error'); } };
  await safePoll();
  const timer = setInterval(safePoll, POLL_INTERVAL_MS);

  process.on('SIGTERM', async () => {
    log.info('harvester.shutdown');
    clearInterval(timer);
    await ingestQueue.close();
    await redis.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  log.fatal({ err: err.message }, 'harvester.fatal');
  process.exit(1);
});
