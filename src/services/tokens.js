import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * Our own JWT issuance and verification — replaces the earlier design that
 * asked Strapi to verify tokens itself (see the old middleware/auth.js
 * comment history: that existed specifically because Strapi's
 * jwtManagement:'refresh' Session Manager signs tokens with an internal
 * secret that isn't consistently documented across versions). Now that
 * epaper-user is our own identity store, we're the ones issuing tokens, so
 * that whole category of ambiguity is gone — attachUser goes back to fast
 * local verification instead of a network call to Strapi on every request.
 *
 * Two separate secrets for access vs refresh tokens (JWT_ACCESS_SECRET /
 * JWT_REFRESH_SECRET) — standard practice: a leaked access-token-verifying
 * secret shouldn't also let someone forge long-lived refresh tokens.
 *
 * tokenVersion is embedded in refresh tokens (not access tokens — they're
 * short-lived enough that checking on every single request would just be
 * the extra network call we're trying to avoid) and checked against the
 * epaper-user record's current value on every /refresh call — that's what
 * lets bumpTokenVersion (real logout) actually invalidate a refresh token
 * that's already been issued, not just stop issuing new ones.
 */

const ACCESS_TOKEN_TTL = '20m';
const REFRESH_TOKEN_TTL = '30d';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, displayName: user.displayName, type: 'access' },
    config.jwtAccessSecret,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

export function signRefreshToken(userId, tokenVersion) {
  return jwt.sign({ sub: userId, tokenVersion, type: 'refresh' }, config.jwtRefreshSecret, { expiresIn: REFRESH_TOKEN_TTL });
}

/** Throws on an invalid/expired/wrong-type token — callers catch, don't check a boolean. */
export function verifyAccessToken(token) {
  const payload = jwt.verify(token, config.jwtAccessSecret);
  if (payload.type !== 'access') throw new Error('Not an access token');
  return payload; // { sub, type, iat, exp }
}

export function verifyRefreshToken(token) {
  const payload = jwt.verify(token, config.jwtRefreshSecret);
  if (payload.type !== 'refresh') throw new Error('Not a refresh token');
  return payload; // { sub, tokenVersion, type, iat, exp }
}

export const REFRESH_COOKIE_NAME = 'epaper_refresh';
export const REFRESH_COOKIE_MAX_AGE_MS = REFRESH_TOKEN_TTL_MS;
