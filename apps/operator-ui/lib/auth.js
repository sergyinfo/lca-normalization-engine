/**
 * Auth: single shared password from OPERATOR_PASSWORD env var.
 * Login posts the password, server verifies (constant-time compare) and sets
 * a signed cookie. A preHandler rejects any request without a valid cookie.
 */

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'operator_sid';
const COOKIE_VALUE = 'authenticated';
const COOKIE_MAX_AGE_SEC = 60 * 60 * 8; // 8 hours

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still run a compare to keep the work even-ish.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function isAuthenticated(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return false;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid && unsigned.value === COOKIE_VALUE;
}

const PUBLIC_PREFIXES = ['/login', '/public', '/healthz'];

export function authPreHandler(req, reply, done) {
  // Allow login + static + health probe without a session.
  if (PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) {
    return done();
  }
  if (isAuthenticated(req)) return done();

  // For HTML navigation, redirect to login. For form posts, also redirect.
  reply.redirect('/login');
}

export function registerAuthRoutes(app, { password }) {
  app.get('/login', async (req, reply) => {
    const error = req.query.error === '1' ? 'Invalid password' : null;
    return reply.view('login.ejs', { error });
  });

  app.post('/login', async (req, reply) => {
    const submitted = (req.body?.password ?? '').toString();
    if (!constantTimeEqual(submitted, password)) {
      return reply.redirect('/login?error=1');
    }
    reply.setCookie(COOKIE_NAME, COOKIE_VALUE, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      maxAge: COOKIE_MAX_AGE_SEC,
    });
    return reply.redirect('/');
  });

  app.post('/logout', async (req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.redirect('/login');
  });
}
