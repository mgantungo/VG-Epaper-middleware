import fetch from 'node-fetch';
import { config } from '../config.js';

/**
 * Calls to the new api::epaper-user endpoints — authenticated with
 * STRAPI_API_TOKEN, same as every other Strapi call this middleware makes
 * (see strapiClient.js). These endpoints are NOT auth:false on the Strapi
 * side (unlike epaper-transaction's webhook routes) — only this trusted
 * service is meant to call them, which is exactly what this token proves.
 *
 * None of these functions ever see a password hash — that's the whole
 * point of the split; see apps/cms/src/api/epaper-user/services/epaper-user.js.
 *
 * Every call below is wrapped in try/catch with explicit logging. An
 * earlier version wasn't — if Strapi was unreachable (wrong URL, Strapi
 * down, or the route not actually registered there), the bare fetch()
 * threw a raw, uncaught exception straight up through auth.js's route
 * handlers to Express's default error handler, which returns a generic
 * HTML 500 with nothing useful in it — and nothing was logged anywhere to
 * explain why. That's precisely the kind of failure that looks identical
 * to a dozen other causes from the frontend's side, and was real enough to
 * lose real debugging time to. { ok: false, status: 0, data: { error } }
 * on a network failure keeps every caller's existing `if (!result.ok)`
 * handling working exactly as before — this only makes the failure
 * visible and diagnosable, it doesn't change the shape callers see.
 */

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${config.strapiApiToken}`, 'content-type': 'application/json', ...extra };
}

async function callEpaperUsers(label, path, opts) {
  try {
    const res = await fetch(`${config.strapiUrl}${path}`, opts);
    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      // Strapi responded, but not with JSON — e.g. a 404 HTML page because
      // the route isn't actually registered there. This is the case that
      // used to be completely silent.
      console.error(`[epaperUserClient] ${label}: Strapi returned non-JSON (status ${res.status}) — is /api/epaper-users/* actually registered and Strapi restarted since it was added?`, parseErr.message);
      return { ok: false, status: res.status, data: { error: 'Identity service returned an unexpected response' } };
    }
    if (!res.ok) {
      console.warn(`[epaperUserClient] ${label}: Strapi responded ${res.status} —`, data?.error || data);
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    // The bare-fetch-threw case — wrong STRAPI_URL, Strapi process down,
    // DNS/network failure. Previously uncaught.
    console.error(`[epaperUserClient] ${label}: could not reach Strapi at ${config.strapiUrl} —`, err.message);
    return { ok: false, status: 0, data: { error: 'Could not reach identity service' } };
  }
}

export async function registerEpaperUser({ email, password, displayName, phone }) {
  return callEpaperUsers('registerEpaperUser', '/api/epaper-users/register', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email, password, displayName, phone })
  });
}

export async function verifyEpaperUserCredentials({ email, password }) {
  return callEpaperUsers('verifyEpaperUserCredentials', '/api/epaper-users/verify-credentials', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email, password })
  });
}

export async function getEpaperUserProfile(userId) {
  const result = await callEpaperUsers('getEpaperUserProfile', `/api/epaper-users/${userId}/profile`, {
    headers: authHeaders()
  });
  return result.ok ? result.data : null; // { user, active, tokenVersion } | null — unchanged shape for existing callers
}

export async function bumpEpaperUserTokenVersion(userId) {
  const result = await callEpaperUsers('bumpEpaperUserTokenVersion', `/api/epaper-users/${userId}/bump-token-version`, {
    method: 'POST',
    headers: authHeaders()
  });
  return result.ok; // unchanged boolean shape for existing callers
}