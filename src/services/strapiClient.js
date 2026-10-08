import fetch from 'node-fetch';
import { config } from '../config.js';

/**
 * apps/middleware/src/services/strapiClient.js            MODIFIED (Phase 2)
 *
 * Change: entitlement lookups are now scope-aware.
 *   - getPersonalEntitlement only matches personal rows. It used to match on
 *     `user` alone, which would also have caught access an Org Admin grants
 *     a member, letting a suspended member keep reading.
 *   - getOrgEntitlement only matches the org's CONTRACT rows. It used to
 *     match on `organization` alone, so one member's window would have
 *     unlocked the paper for every seat in the org.
 *   - Revoked rows (revokedAt set) never grant anything.
 *   - New: getOrgAccess(userId), cached for 30s per user, which
 *     access.js/account.js use for the org branch, and
 *     invalidateOrgAccessCache() for writes made through this process.
 * Rows from before the scope field existed (scope null) are classified the
 * same way the CMS lifecycle/backfill would, so behaviour doesn't depend on
 * whether the backfill has run yet.
 */

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

// ---- scope classification (mirrors the CMS entitlement lifecycle) ---------

function isPersonal(e) {
  if (e.scope) return e.scope === 'personal';
  return !e.organization;
}
function isOrgContract(e) {
  if (e.scope) return e.scope === 'org_contract';
  return Boolean(e.organization) && (Boolean(e.transaction) || !e.user);
}
function isOrgMember(e) {
  if (e.scope) return e.scope === 'org_member';
  return Boolean(e.organization) && Boolean(e.user) && !e.transaction;
}
const NOT_REVOKED = '&filters[revokedAt][$null]=true';
const SCOPE_POPULATE =
  '&populate[organization][fields][0]=id&populate[user][fields][0]=id&populate[transaction][fields][0]=id';

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
    `&filters[coverageEnd][$gte]=${dateIso}` +
    `&filters[$or][0][scope][$eq]=personal&filters[$or][1][scope][$null]=true` +
    NOT_REVOKED + SCOPE_POPULATE +
    `&pagination[pageSize]=50`
  );
  return (json.data || []).find(isPersonal) || null;
}

/** This user's currently-active org seat, if they're a member of one — at
 * most one active seat per user by convention, so the first match is fine. */
export async function getActiveOrgSeat(userId) {
  const json = await strapiGet(
    `/api/epaper-org-seats?filters[user][id][$eq]=${userId}&filters[active][$eq]=true&populate=organization`
  );
  return json.data?.[0] || null;
}

/** The organization's own CONTRACT entitlement covering this date, if any.
 * Kept for compatibility. Member access now goes through getOrgAccess(). */
export async function getOrgEntitlement(organizationId, dateIso) {
  const json = await strapiGet(
    `/api/epaper-entitlements?filters[organization][id][$eq]=${organizationId}` +
    `&filters[coverageStart][$lte]=${dateIso}` +
    `&filters[coverageEnd][$gte]=${dateIso}` +
    `&filters[$or][0][scope][$eq]=org_contract&filters[$or][1][scope][$null]=true` +
    NOT_REVOKED + SCOPE_POPULATE +
    `&pagination[pageSize]=50`
  );
  return (json.data || []).find(isOrgContract) || null;
}

// ---- organisation access ---------------------------------------------------

const ORG_ACCESS_TTL_MS = 30 * 1000;
const orgAccessCache = new Map(); // userId -> { value, expires }

/** Call after any write that changes org/seat/window state (the org routes
 * in this process do). If pm2 runs more than one instance, the other
 * instances catch up within ORG_ACCESS_TTL_MS. */
export function invalidateOrgAccessCache(userId) {
  if (userId === undefined) orgAccessCache.clear();
  else orgAccessCache.delete(String(userId));
}

/**
 * Everything needed to decide org-based access for a user, fetched once and
 * cached briefly, because hasAccess() runs on every page-image request.
 *
 * Returns null when the user has no active seat. Otherwise:
 *   { orgId, orgName, orgStatus, usable, role, seatId, legacy,
 *     contracts: [{start,end}], memberWindows: [{start,end}] | null }
 *
 * usable = org is active. legacy = the seat predates member windows
 * (backfilled source 'legacy'); those read on the contract alone, exactly as
 * before Phase 2. Every other seat needs a member window inside a contract.
 */
export async function getOrgAccess(userId) {
  const key = String(userId);
  const hit = orgAccessCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const value = await loadOrgAccess(userId);
  orgAccessCache.set(key, { value, expires: Date.now() + ORG_ACCESS_TTL_MS });
  return value;
}

async function loadOrgAccess(userId) {
  const seat = await getActiveOrgSeat(userId);
  const org = seat?.organization;
  if (!org?.id) return null;

  const orgStatus = org.status || (org.active === false ? 'suspended' : 'active');
  const legacy = seat.source === 'legacy';
  const base = {
    orgId: org.id,
    orgName: org.name,
    orgStatus,
    usable: orgStatus === 'active',
    role: seat.role || 'member',
    seatId: seat.id,
    legacy,
    contracts: [],
    memberWindows: legacy ? null : []
  };
  if (!base.usable) return base;

  const contractsJson = await strapiGet(
    `/api/epaper-entitlements?filters[organization][id][$eq]=${org.id}` +
    `&filters[$or][0][scope][$eq]=org_contract&filters[$or][1][scope][$null]=true` +
    NOT_REVOKED + SCOPE_POPULATE +
    `&pagination[pageSize]=100`
  );
  base.contracts = (contractsJson.data || [])
    .filter(isOrgContract)
    .map(e => ({ start: e.coverageStart, end: e.coverageEnd }));

  if (!legacy) {
    const windowsJson = await strapiGet(
      `/api/epaper-entitlements?filters[organization][id][$eq]=${org.id}` +
      `&filters[user][id][$eq]=${userId}` +
      `&filters[scope][$eq]=org_member` +
      NOT_REVOKED + SCOPE_POPULATE +
      `&pagination[pageSize]=100`
    );
    base.memberWindows = (windowsJson.data || [])
      .filter(isOrgMember)
      .map(e => ({ start: e.coverageStart, end: e.coverageEnd }));
  }
  return base;
}

const covers = (r, d) => r.start <= d && d <= r.end;

/** Does this org access (from getOrgAccess) cover dateIso? The contract must
 * cover the date, and, unless the seat is legacy, so must a member window. */
export function orgAccessCovers(access, dateIso) {
  if (!access?.usable) return false;
  if (!access.contracts.some(r => covers(r, dateIso))) return false;
  if (access.legacy) return true;
  return access.memberWindows.some(r => covers(r, dateIso));
}

/** The readable ranges this org access grants: contracts for legacy seats,
 * otherwise each member window clipped to the contracts. */
export function orgAccessRanges(access) {
  if (!access?.usable) return [];
  if (access.legacy) return access.contracts.map(r => ({ ...r }));
  const out = [];
  for (const w of access.memberWindows) {
    for (const c of access.contracts) {
      const start = w.start > c.start ? w.start : c.start;
      const end = w.end < c.end ? w.end : c.end;
      if (start <= end) out.push({ start, end });
    }
  }
  return out;
}

/**
 * Every date RANGE this user can read from — their own personal
 * entitlements, plus what their org seat grants. This is
 * the replacement for the old getPurchasedDates() flat-array-of-dates —
 * that shape doesn't work anymore now that one entitlement can span a
 * whole subscription period instead of always being exactly one day.
 * Callers (the archive UI's lock badges) check "is this date within ANY of
 * these ranges" per date shown, rather than a flat Set membership check.
 */
export async function getEntitlementRanges(userId) {
  const personal = await strapiGet(
    `/api/epaper-entitlements?filters[user][id][$eq]=${userId}` +
    `&filters[$or][0][scope][$eq]=personal&filters[$or][1][scope][$null]=true` +
    NOT_REVOKED + SCOPE_POPULATE +
    `&pagination[pageSize]=200`
  );
  const ranges = (personal.data || [])
    .filter(isPersonal)
    .map(e => ({ start: e.coverageStart, end: e.coverageEnd }));

  const orgAccess = await getOrgAccess(userId);
  ranges.push(...orgAccessRanges(orgAccess));
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