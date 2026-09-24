import { verifyAccessToken } from '../services/tokens.js';

/**
 * Reads a bearer token (or `token` cookie) and verifies it LOCALLY — no
 * network call to Strapi per request. This used to require asking Strapi
 * to validate every token itself (GET /api/users/me on every authenticated
 * request), specifically because Strapi's jwtManagement:'refresh' Session
 * Manager signs tokens with an internal secret that isn't consistently
 * documented across versions — see the git history on this file for that
 * whole saga. Now that we sign our own tokens with our own
 * JWT_ACCESS_SECRET (services/tokens.js), that ambiguity is gone entirely,
 * and local verification — the normal, fast way JWTs are supposed to work
 * — is correct again.
 *
 * req.userProfile comes directly out of the token payload (email/
 * displayName were embedded at sign time) — no second lookup needed for
 * the common case. Routes that need a guaranteed-current profile (e.g.
 * after a display-name change) should still re-fetch explicitly.
 */
export function attachUser(req, _res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || req.cookies?.token;
  if (!token) return next();

  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.sub;
    req.userToken = token;
    req.userProfile = { id: payload.sub, email: payload.email, displayName: payload.displayName };
  } catch (err) {
    // A token WAS provided but failed verification — unlike "no token at
    // all" (silently anonymous, completely normal for a logged-out
    // visitor), this is always worth knowing about: expired access token
    // (expected regularly, the frontend's authedFetch retries via
    // /api/auth/refresh automatically — see useEpaperApi.js), or something
    // genuinely wrong (bad signature, tampered token).
    console.warn(`[middleware auth] rejected token: ${err.message}`);
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
  next();
}
