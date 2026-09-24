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
 */

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${config.strapiApiToken}`, 'content-type': 'application/json', ...extra };
}

export async function registerEpaperUser({ email, password, displayName, phone }) {
  const res = await fetch(`${config.strapiUrl}/api/epaper-users/register`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email, password, displayName, phone })
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

export async function verifyEpaperUserCredentials({ email, password }) {
  const res = await fetch(`${config.strapiUrl}/api/epaper-users/verify-credentials`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

export async function getEpaperUserProfile(userId) {
  const res = await fetch(`${config.strapiUrl}/api/epaper-users/${userId}/profile`, { headers: authHeaders() });
  if (!res.ok) return null;
  return res.json(); // { user, active, tokenVersion }
}

export async function bumpEpaperUserTokenVersion(userId) {
  const res = await fetch(`${config.strapiUrl}/api/epaper-users/${userId}/bump-token-version`, {
    method: 'POST',
    headers: authHeaders()
  });
  return res.ok;
}
