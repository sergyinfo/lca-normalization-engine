#!/usr/bin/env node
/**
 * queue-depth.mjs QUEUE [QUEUE...] — print the combined waiting+active+delayed+paused
 * job count across the named BullMQ queues. The burst barrier uses it to know when the
 * ingest / NLP work has drained.
 *
 * MUST be run from this package directory (apps/harvester) so its bullmq/ioredis
 * imports resolve — pnpm installs them into apps/harvester/node_modules. Running it
 * from /tmp fails to resolve and used to make the barrier loop forever.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const queues = process.argv.slice(2);
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });

let total = 0;
for (const name of queues) {
  const q = new Queue(name, { connection });
  const c = await q.getJobCounts('waiting', 'active', 'delayed', 'paused');
  total += (c.waiting || 0) + (c.active || 0) + (c.delayed || 0) + (c.paused || 0);
  await q.close();
}
console.log(total);
await connection.quit();
