/**
 * Operator HITL UI — Fastify app
 *
 * Walks three review queues:
 *   1. lca_records.requires_review = true
 *   2. staging.quarantine_records
 *   3. staging.unresolved_employers
 *
 * Auth: single shared password from OPERATOR_PASSWORD env var, signed cookie.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import view from '@fastify/view';
import formbody from '@fastify/formbody';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import ejs from 'ejs';

dotenv.config({ path: new URL('../../.env', import.meta.url).pathname });

import { closePool } from '@lca/db-lib';
import { authPreHandler, registerAuthRoutes } from './lib/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import reviewRoutes from './routes/reviews.js';
import quarantineRoutes from './routes/quarantine.js';
import unresolvedRoutes from './routes/unresolved.js';
import releaseRoutes from './routes/release.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.OPERATOR_UI_PORT || 8080);
const HOST = process.env.OPERATOR_UI_HOST || '0.0.0.0';
const OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!OPERATOR_PASSWORD) {
  console.error('FATAL: OPERATOR_PASSWORD is not set in the environment.');
  process.exit(1);
}
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('FATAL: SESSION_SECRET must be set and at least 32 characters.');
  process.exit(1);
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

await app.register(formbody);
await app.register(cookie, { secret: SESSION_SECRET });
await app.register(view, {
  engine: { ejs },
  root: path.join(__dirname, 'views'),
});
await app.register(staticPlugin, {
  root: path.join(__dirname, 'public'),
  prefix: '/public/',
});

// Login routes (public).
registerAuthRoutes(app, { password: OPERATOR_PASSWORD });

// Health endpoint (open — no domain data leaks).
app.get('/healthz', async () => ({ ok: true }));

// Auth wall for everything else (the preHandler whitelists /login, /public, /healthz).
app.addHook('preHandler', authPreHandler);

// Protected routes.
await app.register(dashboardRoutes);
await app.register(reviewRoutes);
await app.register(quarantineRoutes);
await app.register(unresolvedRoutes);
await app.register(releaseRoutes);

// Graceful shutdown.
async function shutdown(signal) {
  app.log.info({ signal }, 'operator_ui.shutdown');
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
