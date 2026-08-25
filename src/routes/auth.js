import { Router } from 'express';
import fetch from 'node-fetch';
import { config } from '../config.js';

export const authRouter = Router();

/**
 * These are thin proxies to Strapi's built-in Users & Permissions plugin —
 * consistent with the rest of this app's rule that Nuxt never talks to
 * Strapi directly. This is NOT the ingest/CMS service-to-service auth
 * (STRAPI_API_TOKEN) — this is real reader accounts.
 *
 * IMPORTANT — this Strapi project is scaffolded with
 * `jwtManagement: 'refresh'` in config/plugins.js (the current
 * create-strapi-app default), NOT the older long-lived-JWT ("legacy")
 * model. That means:
 *   - The `jwt` returned from login/register is a SHORT-LIVED access token
 *     (minutes, not the 30-day default of legacy mode) — it's *expected*
 *     to expire during normal use, not a bug.
 *   - Renewing it requires a separate refresh token, which Strapi sets as
 *     an httpOnly cookie on ITS OWN response (since config/plugins.js has
 *     `sessions.httpOnly: true`) — invisible to JS, by design.
 *   - Because Nuxt never talks to Strapi directly, that httpOnly cookie
 *     arrives on OUR server-to-server fetch() call to Strapi, not on the
 *     browser's request to us. relayStrapiCookies() below re-sets it on
 *     THIS response instead, so the browser ends up holding a refresh
 *     cookie scoped to the middleware's own domain — which is exactly
 *     where /refresh (below) expects to find it again later.
 *
 * Before this works, confirm in Strapi admin:
 *   Settings -> Users & Permissions -> Roles -> Public
 *   -> Permissions -> Users-permissions -> Auth -> `connect` (login),
 *      Users-permissions -> Auth -> `register` are BOTH checked.
 */

/** Copy every Set-Cookie header from a node-fetch Response onto our own
 * Express response. Using `.raw()['set-cookie']` (a node-fetch-specific
 * extension, not standard Fetch) rather than `.get('set-cookie')` matters
 * here — .get() would silently comma-join multiple Set-Cookie headers into
 * one unparseable string, corrupting the cookie. */
function relayStrapiCookies(strapiRes, res) {
  const raw = strapiRes.headers.raw?.()['set-cookie'];
  if (raw?.length) res.setHeader('Set-Cookie', raw);
}

authRouter.post('/login', async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ error: 'identifier and password are required' });
  }
  try {
    const strapiRes = await fetch(`${config.strapiUrl}/api/auth/local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password })
    });
    const data = await strapiRes.json();
    if (!strapiRes.ok) {
      return res.status(strapiRes.status).json({ error: data?.error?.message || 'Login failed' });
    }
    relayStrapiCookies(strapiRes, res);
    res.json({ jwt: data.jwt, user: { id: data.user.id, username: data.user.username, email: data.user.email } });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Strapi' });
  }
});

authRouter.post('/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email and password are required' });
  }
  try {
    const strapiRes = await fetch(`${config.strapiUrl}/api/auth/local/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });
    const data = await strapiRes.json();
    if (!strapiRes.ok) {
      return res.status(strapiRes.status).json({ error: data?.error?.message || 'Registration failed' });
    }
    relayStrapiCookies(strapiRes, res);
    res.json({ jwt: data.jwt, user: { id: data.user.id, username: data.user.username, email: data.user.email } });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Strapi' });
  }
});

/**
 * Exchanges the httpOnly refresh cookie (set on /login or /register above)
 * for a new short-lived access token, without the reader needing to log in
 * again. The frontend calls this automatically when a request 401s — see
 * `authedFetch` in apps/web/composables/useEpaperApi.js.
 */
authRouter.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.strapi_up_refresh;
  if (!refreshToken) {
    return res.status(401).json({ error: 'No refresh token — sign in again' });
  }
  try {
    const strapiRes = await fetch(`${config.strapiUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
    const data = await strapiRes.json();
    if (!strapiRes.ok) {
      return res.status(strapiRes.status).json({ error: data?.error?.message || 'Session expired — sign in again' });
    }
    relayStrapiCookies(strapiRes, res); // Strapi rotates the refresh token on every use — the new one replaces the old
    res.json({ jwt: data.jwt });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Strapi' });
  }
});