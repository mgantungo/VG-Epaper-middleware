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

export class StrapiError extends Error {
  constructor(status, body) { super(`Strapi ${status}: ${body}`); this.status = status; }
}

/**
 * Entitlement-related queries, rebuilt around the unified epaper-entitlement
 * model (see apps/cms/src/api/epaper-entitlement) — replaces the old
 * separate Subscription/Purchase content types entirely. `req.userId` here
 * is an api::epaper-user.epaper-user id (our own identity store, not
 * plugin::users-permissions), matching what attachUser now sets it to.
 */

/** A personal (non-org) entitlement covering this date, if any. */
export async function getPersonalEntitlement(userId, dateIso) {
  const json = await strapiGet(
    `/api/epaper-entitlements?filters[user][id][$eq]=${userId}` +
    `&filters[coverageStart][$lte]=${dateIso}` +
    `&filters[coverageEnd][$gte]=${dateIso}`
  );
  return json.data?.[0] || null;
}

/** This user's currently-active org seat, if they're a member of one — at
 * most one active seat per user by convention, so the first match is fine. */
export async function getActiveOrgSeat(userId) {
  const json = await strapiGet(
    `/api/epaper-org-seats?filters[user][id][$eq]=${userId}&filters[active][$eq]=true&populate=organization`
  );
  return json.data?.[0] || null;
}

/** The organization's own entitlement covering this date, if any — what a
 * seat-holder's access actually resolves through. */
export async function getOrgEntitlement(organizationId, dateIso) {
  const json = await strapiGet(
    `/api/epaper-entitlements?filters[organization][id][$eq]=${organizationId}` +
    `&filters[coverageStart][$lte]=${dateIso}` +
    `&filters[coverageEnd][$gte]=${dateIso}`
  );
  return json.data?.[0] || null;
}

/**
 * Every date RANGE this user can read from — their own personal
 * entitlements, plus their org's if they're an active seat-holder. This is
 * the replacement for the old getPurchasedDates() flat-array-of-dates —
 * that shape doesn't work anymore now that one entitlement can span a
 * whole subscription period instead of always being exactly one day.
 * Callers (the archive UI's lock badges) check "is this date within ANY of
 * these ranges" per date shown, rather than a flat Set membership check.
 */
export async function getEntitlementRanges(userId) {
  const personal = await strapiGet(`/api/epaper-entitlements?filters[user][id][$eq]=${userId}`);
  const ranges = (personal.data || []).map(e => ({ start: e.coverageStart, end: e.coverageEnd }));

  const seat = await getActiveOrgSeat(userId);
  if (seat?.organization?.id) {
    const org = await strapiGet(`/api/epaper-entitlements?filters[organization][id][$eq]=${seat.organization.id}`);
    ranges.push(...(org.data || []).map(e => ({ start: e.coverageStart, end: e.coverageEnd })));
  }
  return ranges;
}

/** A single active plan's real data by key — replaces the static
 * config.pricing values editions.js's priceFor() used to read, so a price
 * change in Strapi admin actually reaches the locked-preview response
 * without a code change. Returns null on any failure (not found, Strapi
 * unreachable) — priceFor() falls back to the old static value in that
 * case rather than breaking the edition response over a pricing lookup. */
export async function getPlanByKey(key) {
  try {
    const json = await strapiGet(`/api/epaper-plans?filters[key][$eq]=${key}&filters[active][$eq]=true`);
    return json.data?.[0] || null;
  } catch {
    return null;
  }
}

/** Fetch a published edition by ISO date, with pages -> image and each page's published stories. */
export async function getEditionByDate(dateIso) {
  const query =
    `/api/editions?filters[date][$eq]=${dateIso}` +
    `&filters[pipelineStatus][$eq]=published` +
    `&populate[pages][populate][image]=true` +
    `&populate[pages][populate][stories]=true`;
  const json = await strapiGet(query);
  return json.data?.[0] || null;
}

/** Fetch just enough to stream one page's image bytes. */
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