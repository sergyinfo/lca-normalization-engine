#!/usr/bin/env node
/**
 * ingestor — BullMQ Worker
 *
 * Consumes "ingest" jobs from the BullMQ queue.
 * Each job carries a path (or URL) to a single XLSX file.
 * The worker:
 *   1. Opens the XLSX file as a read stream via `xlstream`
 *   2. Buffers rows into batches of BATCH_SIZE
 *   3. Bulk-inserts each batch into PostgreSQL using `pg-copy-streams` (via @lca/db-lib)
 *   4. Optionally enqueues an NLP classification job for the batch
 */

import 'dotenv/config';
import { Worker, Queue } from 'bullmq';
import { getXlsxStream } from 'xlstream';
import IORedis from 'ioredis';
import pino from 'pino';
import { bulkCopyJsonb, ensureSchema, closePool } from '@lca/db-lib';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const BATCH_SIZE = Number(process.env.INGESTOR_BATCH_SIZE ?? 5_000);
const CONCURRENCY = Number(process.env.INGESTOR_CONCURRENCY ?? 4);
const INGEST_QUEUE = 'ingest-tasks';
const NLP_QUEUE = 'nlp-tasks';

// ---------------------------------------------------------------------------
// Redis connection (shared between Worker and Queue)
// ---------------------------------------------------------------------------
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const nlpQueue = new Queue(NLP_QUEUE, { connection: redis });

// ---------------------------------------------------------------------------
// Core job handler
// ---------------------------------------------------------------------------

/**
 * Process a single ingest job.
 *
 * @param {{ filePath: string, sourceFile: string, filingYear: number }} data
 */
async function processIngestJob(data) {
  const { filePath, sourceFile, filingYear } = data;
  log.info({ filePath, filingYear }, 'ingestor.job.start');

  let totalRows = 0;
  let batch = [];
  let batchIndex = 0;

  const xlsxStream = await getXlsxStream({
    filePath,
    sheet: 0,                // first sheet
    withHeader: true,        // use first row as column names
    ignoreEmpty: true,
  });

  // Collect header row then stream data rows
  for await (const row of xlsxStream) {
    // xlstream emits { header: [...], obj: {...} } per row when withHeader=true
    const record = row.obj ?? row;
    record._source_file = sourceFile;
    record._filing_year = filingYear;

    batch.push(record);
    totalRows++;

    if (batch.length >= BATCH_SIZE) {
      await flushBatch(batch, batchIndex, sourceFile, filingYear);
      batchIndex++;
      batch = [];
    }
  }

  // Flush remaining rows
  if (batch.length > 0) {
    await flushBatch(batch, batchIndex, sourceFile, filingYear);
  }

  log.info({ filePath, totalRows }, 'ingestor.job.done');
  return { totalRows };
}

/**
 * Writes a batch to PostgreSQL and enqueues an NLP classification job.
 */
async function flushBatch(rows, batchIndex, sourceFile, filingYear) {
  const batchId = `${sourceFile}:${batchIndex}`;

  await bulkCopyJsonb({
    table: 'lca_records',
    column: 'data',
    rows,
  });

  log.info({ batchId, rows: rows.length }, 'ingestor.batch.flushed');

  // Enqueue NLP classification for this batch
  await nlpQueue.add('nlp:classify', {
    batch_id: batchId,
    filing_year: filingYear,
    records: rows.map((r, i) => ({
      id: i,   // temp ID; real ID is assigned by PostgreSQL BIGSERIAL
      job_title: r['JOB_TITLE'] ?? r['job_title'] ?? '',
      employer_name: r['EMPLOYER_NAME'] ?? r['employer_name'] ?? '',
    })),
  }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
  });
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

async function main() {
  log.info('ingestor.bootstrap');
  await ensureSchema();

  const worker = new Worker(
    INGEST_QUEUE,
    async (job) => processIngestJob(job.data),
    {
      connection: redis,
      concurrency: CONCURRENCY,
    },
  );

  worker.on('completed', (job, result) => {
    log.info({ jobId: job.id, ...result }, 'ingestor.worker.completed');
  });

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'ingestor.worker.failed');
  });

  log.info({ queue: INGEST_QUEUE, concurrency: CONCURRENCY }, 'ingestor.worker.listening');

  process.on('SIGTERM', async () => {
    log.info('ingestor.shutdown');
    await worker.close();
    await nlpQueue.close();
    await redis.quit();
    await closePool();
    process.exit(0);
  });
}

main().catch((err) => {
  log.fatal({ err }, 'ingestor.fatal');
  process.exit(1);
});
