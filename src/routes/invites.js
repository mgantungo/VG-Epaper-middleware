/**
 * File:      /var/www/VGEpaper/middleware/src/routes/invites.js
 * Repo path: apps/middleware/src/routes/invites.js
 * System:    apps/middleware (Express, port 4161)          NEW FILE (Phase 3)
 *
 * Accepting an Organisation invite. A reader added by their Org Admin gets
 * an email linking to the web app's /invite?token=... page, which calls:
 *
 *   POST /api/auth/invite/inspect   { token }                          -> { email, displayName, organisation }
 *   POST /api/auth/invite/accept    { token, password, displayName? }  -> { jwt, user }  (+ refresh cookie)
 *
 * accept signs the reader in exactly like /api/auth/login does. It is
 * mounted under /api/auth on purpose: the refresh cookie is scoped to the
 * /api/auth path (see routes/auth.js). routes/auth.js itself is unchanged.
 *
 * Mount in src/server.js:  app.use('/api/auth/invite', invitesRouter);
 */
import { Router } from 'express';
import fetch from 'node-fetch';
import { config } from '../config.js';
import {
  signAccessToken, signRefreshToken, REFRESH_COOKIE_NAME, REFRESH_COOKIE_MAX_AGE_MS
} from '../services/tokens.js';

export const invitesRouter = Router();

// Small per-IP limiter: invite tokens are 192-bit random, so this is
// defence in depth against hammering, not the main protection.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_HITS = 30;
const hits = new Map();
function rateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.reset < now) {
    hits.set(key, { count: 1, reset: now + WINDOW_MS });
    if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return next();
  }
  entry.count += 1;
  if (entry.count > MAX_HITS) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  next();
}

async function callStrapi(path, body) {
  const upstream = await fetch(`${config.strapiUrl}/api/org-management/invites${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.strapiApiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await upstream.json().catch(() => null);
  return { status: upstream.status, ok: upstream.ok, data };
}

invitesRouter.post('/inspect', rateLimit, async (req, res) => {
  const token = req.body?.token;
  if (!token) return res.status(400).json({ error: 'Missing invite token' });
  try {
    const r = await callStrapi('/inspect', { token });
    if (!r.data) return res.status(502).json({ error: 'Unexpected response' });
    res.status(r.status).json(r.data);
  } catch (err) {
    console.error('[invites] inspect: could not reach Strapi:', err.message);
    res.status(502).json({ error: 'Could not reach the account service' });
  }
});

invitesRouter.post('/accept', rateLimit, async (req, res) => {
  const { token, password, displayName } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'token and password are required' });
  try {
    const r = await callStrapi('/accept', { token, password, displayName });
    if (!r.ok || !r.data?.success) {
      return res.status(r.status >= 400 ? r.status : 400).json({ error: r.data?.error || 'Could not activate your account' });
    }
    const { user, tokenVersion } = r.data;
    res.cookie(REFRESH_COOKIE_NAME, signRefreshToken(user.id, tokenVersion), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
      path: '/api/auth'
    });
    res.json({ jwt: signAccessToken(user), user });
  } catch (err) {
    console.error('[invites] accept: could not reach Strapi:', err.message);
    res.status(502).json({ error: 'Could not reach the account service' });
  }
});
