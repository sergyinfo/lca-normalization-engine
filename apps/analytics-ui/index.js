/**
 * LCA Analytics Dashboard — Fastify app.
 *
 * Read-only, public-facing companion to the Operator HITL UI. Surfaces the
 * canonicalised, classified LCA corpus through four persona pages:
 *   - /journalist  — top sponsors, geography, year volume, occupation mix
 *   - /jobseeker   — wage distributions by SOC and city
 *   - /policy      — long-term trends and wage growth
 *   - /academic    — methodology: classification + entity-resolution stats
 *
 * No auth (data is public DOL disclosure). Designed for thesis defence demo.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import view from '@fastify/view';
import formbody from '@fastify/formbody';
import staticPlugin from '@fastify/static';
import ejs from 'ejs';

dotenv.config({ path: new URL('../../.env', import.meta.url).pathname });

import { closePool } from '@lca/db-lib';
import homeRoutes from './routes/home.js';
import journalistRoutes from './routes/journalist.js';
import jobseekerRoutes from './routes/jobseeker.js';
import policyRoutes from './routes/policy.js';
import academicRoutes from './routes/academic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.ANALYTICS_UI_PORT || 8081);
const HOST = process.env.ANALYTICS_UI_HOST || '0.0.0.0';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

await app.register(formbody);
await app.register(view, {
  engine: { ejs },
  root: path.join(__dirname, 'views'),
});
await app.register(staticPlugin, {
  root: path.join(__dirname, 'public'),
  prefix: '/public/',
});

app.get('/healthz', async () => ({ ok: true }));

await app.register(homeRoutes);
await app.register(journalistRoutes);
await app.register(jobseekerRoutes);
await app.register(policyRoutes);
await app.register(academicRoutes);

async function shutdown(signal) {
  app.log.info({ signal }, 'analytics_ui.shutdown');
  try {
    await app.close();
  } finally {
    await closePool();
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

app.listen({ port: PORT, host: HOST }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
