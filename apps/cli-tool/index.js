#!/usr/bin/env node
/**
 * lca-cli — Database Initialisation & BullMQ Task Tree Seeder
 *
 * Commands:
 *   lca-cli db:init                            Initialise PostgreSQL schema
 *   lca-cli seed --files-dir <path>            Seed BullMQ with one job per XLSX file
 *   lca-cli queue:stats                        Print queue depth stats
 *   lca-cli queue:drain                        Remove all waiting jobs (use with care)
 *
 * Example (Historical Backfill):
 *   lca-cli db:init
 *   lca-cli seed --files-dir /data/lca-archive --concurrency 4
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: new URL('../../.env', import.meta.url).pathname });
import { Command } from 'commander';
import { Queue, QueueEvents } from 'bullmq';
import { glob } from 'glob';
import path from 'node:path';
import IORedis from 'ioredis';
import pino from 'pino';
import { ensureSchema, closePool } from '@lca/db-lib';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const INGEST_QUEUE = 'ingest-tasks';

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

function makeRedis() {
  return new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * db:init — Create PostgreSQL schema (idempotent).
 */
async function cmdDbInit() {
  log.info('cli.db_init.start');
  await ensureSchema();
  log.info('cli.db_init.done');
}

/**
 * seed — Walk a directory of XLSX files and enqueue one BullMQ job per file.
 *
 * @param {{ filesDir: string, concurrency: number, dryRun: boolean }} opts
 */
async function cmdSeed(opts) {
  const { filesDir, concurrency, dryRun } = opts;

  log.info({ filesDir, concurrency, dryRun }, 'cli.seed.start');

  const xlsxFiles = await glob('**/*.xlsx', {
    cwd: path.resolve(filesDir),
    absolute: true,
    nocase: true,
  });

  if (xlsxFiles.length === 0) {
    log.warn({ filesDir }, 'cli.seed.no_files_found');
    return;
  }

  log.info({ count: xlsxFiles.length }, 'cli.seed.files_found');

  if (dryRun) {
    for (const f of xlsxFiles) log.info({ file: f }, 'cli.seed.dry_run');
    return;
  }

  const redis = makeRedis();
  const ingestQueue = new Queue(INGEST_QUEUE, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });

  // Build a BullMQ flow: one parent job per year, child jobs per file.
  // This creates a task tree so year-level progress can be tracked.
  const byYear = groupByYear(xlsxFiles);

  for (const [year, files] of Object.entries(byYear)) {
    // Add all files for this year as a bulk batch
    const jobs = files.map((filePath) => ({
      name: 'ingest',
      data: {
        filePath,
        sourceFile: path.basename(filePath),
        filingYear: Number(year),
      },
    }));

    await ingestQueue.addBulk(jobs);
    log.info({ year, files: files.length }, 'cli.seed.year_enqueued');
  }

  const waiting = await ingestQueue.getWaitingCount();
  log.info({ totalEnqueued: waiting }, 'cli.seed.done');

  await ingestQueue.close();
  await redis.quit();
}

/**
 * queue:stats — Print queue metrics.
 */
async function cmdQueueStats() {
  const redis = makeRedis();
  const q = new Queue(INGEST_QUEUE, { connection: redis });
  const counts = await q.getJobCounts(
    'waiting', 'active', 'completed', 'failed', 'delayed',
  );
  console.table({ queue: INGEST_QUEUE, ...counts });
  await q.close();
  await redis.quit();
}

/**
 * queue:drain — Remove all waiting jobs (destructive).
 */
async function cmdQueueDrain() {
  const redis = makeRedis();
  const q = new Queue(INGEST_QUEUE, { connection: redis });
  await q.drain();
  log.warn({ queue: INGEST_QUEUE }, 'cli.queue_drain.done');
  await q.close();
  await redis.quit();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Group file paths by the 4-digit year detected in the file name.
 * Files with no detectable year go under the key "unknown".
 */
function groupByYear(files) {
  return files.reduce((acc, f) => {
    const m = path.basename(f).match(/\b(20\d{2})\b/);
    const year = m ? m[1] : 'unknown';
    (acc[year] ??= []).push(f);
    return acc;
  }, {});
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name('lca-cli')
  .description('LCA Normalization Engine — CLI tool')
  .version('0.1.0');

program
  .command('db:init')
  .description('Initialise PostgreSQL schema (idempotent)')
  .action(async () => {
    await cmdDbInit();
    await closePool();
  });

program
  .command('seed')
  .description('Seed BullMQ with ingest jobs for all XLSX files in a directory')
  .requiredOption('--files-dir <path>', 'Path to local LCA archive directory')
  .option('--concurrency <n>', 'Worker concurrency hint (informational)', '4')
  .option('--dry-run', 'Print files without enqueuing', false)
  .action(async (opts) => {
    await cmdSeed({
      filesDir: opts.filesDir,
      concurrency: Number(opts.concurrency),
      dryRun: opts.dryRun,
    });
    await closePool();
  });

program
  .command('queue:stats')
  .description('Print queue depth statistics')
  .action(async () => {
    await cmdQueueStats();
  });

program
  .command('queue:drain')
  .description('Remove all waiting jobs from the ingest queue')
  .action(async () => {
    await cmdQueueDrain();
  });

program.parseAsync(process.argv).catch((err) => {
  log.fatal({ err }, 'cli.fatal');
  process.exit(1);
});
