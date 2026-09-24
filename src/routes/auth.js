import { Router } from 'express';
import {
  registerEpaperUser, verifyEpaperUserCredentials, getEpaperUserProfile, bumpEpaperUserTokenVersion
} from '../services/epaperUserClient.js';
import {
  signAccessToken, signRefreshToken, verifyRefreshToken, REFRESH_COOKIE_NAME, REFRESH_COOKIE_MAX_AGE_MS
} from '../services/tokens.js';

export const authRouter = Router();

/**
 * Register/login/refresh/logout, now built on our own epaper-user identity
 * store and our own signed JWTs — see services/tokens.js for why this
 * replaces the earlier Strapi-Session-Manager-backed design.
 *
 * The refresh cookie is scoped to path: '/api/auth' — it's only ever
 * needed by /refresh and /logout below, so there's no reason for the
 * browser to attach it to every other request to this server. This is
 * unrelated to the frontend's existing authedFetch retry-on-401 logic
 * (apps/web/composables/useEpaperApi.js) — that code just calls
 * POST /api/auth/refresh with credentials:'include' when anything 401s,
 * which still works unchanged: that request IS to a /api/auth path, so
 * the scoped cookie is still sent on it.
 */

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    path: '/api/auth'
  });
}
function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
}

authRouter.post('/register', async (req, res) => {
  const { email, password, displayName, phone } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const result = await registerEpaperUser({ email, password, displayName, phone });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.data?.error || 'Registration failed' });
  }
  const { user, tokenVersion } = result.data;
  setRefreshCookie(res, signRefreshToken(user.id, tokenVersion));
  res.json({ jwt: signAccessToken(user), user });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const result = await verifyEpaperUserCredentials({ email, password });
  if (!result.ok || !result.data?.success) {
    // Deliberately the same generic message whether the email doesn't
    // exist or the password's wrong — same email-enumeration reasoning as
    // the constant-time compare on the Strapi side.
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const { user, tokenVersion } = result.data;
  setRefreshCookie(res, signRefreshToken(user.id, tokenVersion));
  res.json({ jwt: signAccessToken(user), user });
});

authRouter.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!refreshToken) {
    return res.status(401).json({ error: 'No refresh token — sign in again' });
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    clearRefreshCookie(res);
    return res.status(401).json({ error: 'Session expired — sign in again' });
  }

  const profile = await getEpaperUserProfile(payload.sub);
  // tokenVersion mismatch means this refresh token was already revoked —
  // logout, or a future password-change flow bumping it — a token that's
  // still structurally valid (correct signature, not expired) but has been
  // deliberately invalidated since it was issued.
  if (!profile || !profile.active || profile.tokenVersion !== payload.tokenVersion) {
    clearRefreshCookie(res);
    return res.status(401).json({ error: 'Session no longer valid — sign in again' });
  }

  res.json({ jwt: signAccessToken(profile.user) });
});

authRouter.post('/logout', async (req, res) => {
  // Deliberately NOT gated behind requireUser/a valid access token — a
  // reader should be able to log out even if their short-lived access
  // token has already expired, as long as they still hold a refresh
  // cookie. If there's no valid refresh token either, there's simply
  // nothing server-side to revoke, and that's fine.
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (refreshToken) {
    try {
      const payload = verifyRefreshToken(refreshToken);
      await bumpEpaperUserTokenVersion(payload.sub);
    } catch {
      // already invalid/expired — nothing to revoke, continue clearing the cookie regardless
    }
  }
  clearRefreshCookie(res);
  res.json({ success: true });
});
