import fetch from 'node-fetch';
import { config } from '../config.js';

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${config.strapiApiToken}`, ...extra };
}

async function strapiGet(pathAndQuery) {
  const res = await fetch(`${config.strapiUrl}${pathAndQuery}`, { headers: authHeaders() });
  if (!res.ok) throw new StrapiError(res.status, await res.text());
  return res.json();
}
async function strapiPost(path, body) {
  const res = await fetch(`${config.strapiUrl}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new StrapiError(res.status, await res.text());
  return res.json();
}
async function strapiPut(path, body) {
  const res = await fetch(`${config.strapiUrl}${path}`, {
    method: 'PUT',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new StrapiError(res.status, await res.text());
  return res.json();
}

export class StrapiError extends Error {
  constructor(status, body) { super(`Strapi ${status}: ${body}`); this.status = status; }
}

/**
 * Strapi 5's REST API is flattened — no more `.attributes` wrapper, fields
 * are directly on the object — and mutations (PUT/DELETE) address a document
 * by its `documentId` (string), not the legacy numeric `id`.
 * Relation FILTERS are the one exception: `filters[user][id][$eq]=...` below
 * intentionally filters by the related user's numeric `id`, because that's
 * what a users-permissions JWT payload actually contains (`{ id: <number> }`)
 * — users-permissions auth wasn't changed to documentId. See:
 * https://docs.strapi.io/cms/api/rest, https://docs.strapi.io/cms/features/users-permissions
 */

/** Fetch a published edition by ISO date (YYYY-MM-DD), with its pages -> image, and each page's published stories. */
export async function getEditionByDate(dateIso) {
  const query =
    `/api/editions?filters[date][$eq]=${dateIso}` +
    `&filters[pipelineStatus][$eq]=published` +
    `&populate[pages][populate][image]=true` +
    `&populate[pages][populate][stories]=true`;
  const json = await strapiGet(query);
  return json.data?.[0] || null; // flattened — e.g. edition.date, edition.pages[i].image.url
}

/** Fetch just enough to stream one page's image bytes, without pulling the whole edition graph. */
export async function getPageImageUrl(dateIso, pageNumber) {
  const query =
    `/api/pages?filters[edition][date][$eq]=${dateIso}` +
    `&filters[pageNumber][$eq]=${pageNumber}` +
    `&populate=image`;
  const json = await strapiGet(query);
  const page = json.data?.[0];
  const url = page?.image?.url;
  if (!url) return null;
  return url.startsWith('http') ? url : `${config.strapiUrl}${url}`;
}

/** Active-subscription check for a user, evaluated against currentPeriodEnd (not just the status flag — see schema comment). */
export async function getActiveSubscription(userId) {
  const json = await strapiGet(
    `/api/subscriptions?filters[user][id][$eq]=${userId}&populate=user`
  );
  const sub = json.data?.[0];
  if (!sub) return null;
  const notExpired = !sub.currentPeriodEnd || new Date(sub.currentPeriodEnd) > new Date();
  return sub.status === 'active' && notExpired ? sub : null;
}

/** Has this user completed a purchase for this specific archive date? */
export async function getCompletedPurchase(userId, dateIso) {
  const json = await strapiGet(
    `/api/purchases?filters[user][id][$eq]=${userId}` +
    `&filters[edition][date][$eq]=${dateIso}` +
    `&filters[status][$eq]=completed`
  );
  return json.data?.[0] || null;
}

/** All dateIsos this user has purchased — used to render lock badges in the archive UI. */
export async function getPurchasedDates(userId) {
  const json = await strapiGet(
    `/api/purchases?filters[user][id][$eq]=${userId}&filters[status][$eq]=completed&populate[edition][fields][0]=date`
  );
  return (json.data || []).map(p => p.edition?.date).filter(Boolean);
}

export async function createPurchase({ userId, editionDocumentId, amount, currency, provider, providerReference, status }) {
  return strapiPost('/api/purchases', {
    data: { user: userId, edition: editionDocumentId, amount, currency, provider, providerReference, status }
  });
}
export async function markPurchaseCompleted(purchaseDocumentId) {
  return strapiPut(`/api/purchases/${purchaseDocumentId}`, {
    data: { status: 'completed', completedAt: new Date().toISOString() }
  });
}
export async function upsertActiveSubscription({ userId, provider, providerSubscriptionId, currentPeriodEnd }) {
  const existing = await strapiGet(`/api/subscriptions?filters[user][id][$eq]=${userId}`);
  const data = { status: 'active', provider, providerSubscriptionId, currentPeriodEnd };
  if (existing.data?.[0]) {
    return strapiPut(`/api/subscriptions/${existing.data[0].documentId}`, { data });
  }
  return strapiPost('/api/subscriptions', { data: { user: userId, ...data } });
}

/** documentId of the edition on this date — the identifier createPurchase() expects for its `edition` relation. */
export async function getEditionDocumentIdByDate(dateIso) {
  const json = await strapiGet(`/api/editions?filters[date][$eq]=${dateIso}&fields[0]=date`);
  return json.data?.[0]?.documentId || null;
}
