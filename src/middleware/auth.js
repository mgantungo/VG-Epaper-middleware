import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * Reads a bearer token (or `token` cookie, if you prefer httpOnly cookies over
 * an Authorization header from Nuxt) and verifies it as a Strapi
 * users-permissions JWT. On success, req.userId is set; on failure, it's left
 * undefined and req.user stays anonymous — routes decide whether that's
 * acceptable (e.g. edition *metadata* might be visible to anonymous users so
 * the paywall can show a locked preview, but the actual page image never is).
 */
export function attachUser(req, _res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || req.cookies?.token;
  if (!token) return next();

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.userId = payload.id; // Strapi's users-permissions JWT payload shape: { id, iat, exp }
    req.userToken = token; // raw token, so routes can forward it to Strapi's own /api/users/me if needed
  } catch (err) {
    // A token WAS provided but failed verification — unlike "no token at
    // all" (silently anonymous, completely normal for a logged-out
    // visitor), this is always worth knowing about: almost always means
    // JWT_SECRET here doesn't match Strapi's, or the token's genuinely
    // expired/tampered. Logging it is what turns "user says they're stuck
    // signed out" into an instant answer instead of a guessing game.
    console.warn(`[middleware auth] rejected token: ${err.message}`);
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
  next();
}