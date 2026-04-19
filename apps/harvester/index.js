#!/usr/bin/env node
/**
 * harvester — DOL Website Monitor
 *
 * Periodically scrapes the Department of Labor LCA disclosure data page,
 * detects new XLSX files, and enqueues download + ingest tasks in BullMQ.
 *
 * In the "Historical Backfill" stage this service is bypassed — the cli-tool
 * seeds tasks directly from a local archive. The harvester is designed for the
 * ongoing production monitoring stage.
 *
 * Flow:
 *   1. Fetch DOL disclosure page HTML
 *   2. Parse all .xlsx links and their last-modified hints
 *   3. Compare against `harvested_files` DB table to find new/changed files
 *   4. Enqueue an "ingest" BullMQ job for each new file
 *   5. Sleep for HARVESTER_POLL_INTERVAL_MS then repeat
 */

import 'dotenv/config';
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
      enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function isAlreadyHarvested(url) {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM harvested_files WHERE url = $1',
    [url],
  );
  return rowCount > 0;
}

async function markHarvested(url, fileName, filingYear) {
  await pool.query(
    `INSERT INTO harvested_files (url, file_name, filing_year)
     VALUES ($1, $2, $3) ON CONFLICT (url) DO NOTHING`,
    [url, fileName, filingYear ?? null],
  );
}

// ---------------------------------------------------------------------------
// Scraping
// ---------------------------------------------------------------------------

/**
 * Fetches the DOL performance data page and returns all .xlsx links.
 *
 * @returns {Promise<Array<{ url: string, fileName: string, filingYear: number|null }>>}
 */
async function scrapeDisclosureLinks() {
  log.info({ url: DOL_BASE_URL }, 'harvester.scrape.start');
  const response = await fetch(DOL_BASE_URL);
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
    const yearMatch = fileName.match(/\b(20\d{2})\b/);
    const filingYear = yearMatch ? Number(yearMatch[1]) : null;

    links.push({ url, fileName, filingYear });
  }

  log.info({ count: links.length }, 'harvester.scrape.done');
  return links;
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function poll() {
  log.info('harvester.poll.start');
  let newFiles = 0;

  try {
    const links = await scrapeDisclosureLinks();
    for (const { url, fileName, filingYear } of links) {
      if (await isAlreadyHarvested(url)) continue;

      await ingestQueue.add(
        'ingest',
        { fileUrl: url, sourceFile: fileName, filingYear },
        { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
      );
      await markHarvested(url, fileName, filingYear);
      newFiles++;
      log.info({ url, filingYear }, 'harvester.enqueued');
    }
  } catch (err) {
    log.error({ err: err.message }, 'harvester.poll.error');
  }

  log.info({ newFiles }, 'harvester.poll.done');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  log.info('harvester.bootstrap');
  await ensureHarvestedFilesTable();

  // Run immediately, then on interval
  await poll();
  const timer = setInterval(poll, POLL_INTERVAL_MS);

  process.on('SIGTERM', async () => {
    log.info('harvester.shutdown');
    clearInterval(timer);
    await ingestQueue.close();
    await redis.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  log.fatal({ err }, 'harvester.fatal');
  process.exit(1);
});
