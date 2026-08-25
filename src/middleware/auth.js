import fetch from 'node-fetch';
import { config } from '../config.js';

/**
 * Reads a bearer token (or `token` cookie) and verifies it by asking Strapi
 * itself who it belongs to (GET /api/users/me), rather than re-verifying
 * the JWT locally with jsonwebtoken + a shared secret.
 *
 * This used to do local verification against JWT_SECRET. That broke once
 * this Strapi project's `jwtManagement: 'refresh'` mode came into play:
 * that mode issues tokens via Strapi's newer Session Manager, and separate
 * Strapi bug reports (github.com/strapi/strapi issues #24766, #26365) show
 * Session Manager requiring its OWN secret (`admin.auth.secret`) — not
 * necessarily the plain JWT_SECRET the older long-lived-JWT model used.
 * That distinction isn't documented consistently across Strapi versions,
 * so rather than keep guessing at an internal, version-fragile
 * implementation detail, this asks Strapi to validate the token itself —
 * correct regardless of which auth mode or Strapi version is running
 * underneath, now or after a future upgrade.
 *
 * Trade-off: one extra HTTP call per authenticated request instead of a
 * local, no-network signature check. Acceptable for this app's traffic
 * level in exchange for not being wrong about auth. If that ever needs
 * optimizing, cache the token->user lookup for a few seconds rather than
 * reintroducing local verification.
 *
 * req.userProfile is populated here too (not just req.userId) so routes
 * that need username/email — see routes/account.js — don't need a second,
 * duplicate call to /api/users/me.
 */
export async function attachUser(req, _res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || req.cookies?.token;
  if (!token) return next();

  try {
    const strapiRes = await fetch(`${config.strapiUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (strapiRes.ok) {
      const user = await strapiRes.json();
      req.userId = user.id;
      req.userToken = token;
      req.userProfile = { id: user.id, username: user.username, email: user.email };
    } else {
      // A token WAS provided but Strapi rejected it — unlike "no token at
      // all" (silently anonymous, completely normal for a logged-out
      // visitor), this is always worth knowing about.
      console.warn(`[middleware auth] Strapi rejected token: ${strapiRes.status}`);
    }
  } catch (err) {
    console.error('[middleware auth] could not reach Strapi to verify token:', err.message);
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
  next();
}