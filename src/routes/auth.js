import { Router } from 'express';
import fetch from 'node-fetch';
import { config } from '../config.js';

export const authRouter = Router();

/**
 * These are deliberately thin proxies to Strapi's built-in Users &
 * Permissions plugin (`/api/auth/local`, `/api/auth/local/register`) —
 * consistent with the rest of this app's rule that Nuxt never talks to
 * Strapi directly. This is NOT the ingest/CMS service-to-service auth
 * (STRAPI_API_TOKEN) — this is real reader accounts, authenticated with
 * their own email+password, issuing them their own per-user JWT (the same
 * JWT_SECRET-signed token `middleware/src/middleware/auth.js` verifies on
 * every other route).
 *
 * Before this works, confirm in Strapi admin:
 *   Settings -> Users & Permissions -> Roles -> Public
 *   -> Permissions -> Users-permissions -> Auth -> `connect` (login),
 *      Users-permissions -> Auth -> `register` are BOTH checked.
 * These are enabled by default on a fresh Strapi install, but worth a
 * direct look if login/register 403 instead of the expected 400 on bad
 * credentials.
 */

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
      // Strapi's shape: { error: { message, ... } } — flatten it so the
      // frontend doesn't need to know Strapi's specific error envelope.
      return res.status(strapiRes.status).json({ error: data?.error?.message || 'Login failed' });
    }
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
    // Strapi's register endpoint already returns a usable jwt — no separate
    // login step needed, the new account is signed in immediately unless
    // you've turned on email confirmation (Settings -> Users & Permissions
    // -> Advanced Settings), in which case data.jwt will still be present
    // but the account may be restricted until confirmed, depending on your
    // Strapi version/config.
    res.json({ jwt: data.jwt, user: { id: data.user.id, username: data.user.username, email: data.user.email } });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Strapi' });
  }
});