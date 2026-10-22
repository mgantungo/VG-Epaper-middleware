import fetch from 'node-fetch';
import { config } from '../config.js';
import { invalidateAccess, normPub } from './access.js';

/**
 * apps/middleware/src/services/strapiClient.js         REWRITTEN (Phase 0)
 *
 * Reads from the CMS for the reader-facing routes.
 *
 * What changed in Phase 0 (publications, plans and paper-aware access):
 *   - editions are looked up by PUBLICATION and the day they cover, not by
 *     date alone (New Vision and Bukedde both publish every day; a weekend
 *     edition dated Saturday is also Sunday's paper)
 *   - entitlement checks moved to services/access.js, which asks the CMS
 *     for one access profile per reader; the per-query helpers that used to
 *     live here (getPersonalEntitlement, getOrgAccess, …) are gone
 *   - plans and the landing page come from the CMS catalogue API
 *
 * invalidateOrgAccessCache() keeps its name because the organisation
 * routers import it; it now clears the unified access cache.
 */

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${config.strapiApiToken}`, ...extra };
}

export class StrapiError extends Error {
  constructor(status, body) { super(`Strapi ${status}: ${body}`); this.status = status; }
}

export async function strapiGet(pathAndQuery) {
  const res = await fetch(`${config.strapiUrl}${pathAndQuery}`, { headers: authHeaders() });
  if (!res.ok) throw new StrapiError(res.status, await res.text());
  return res.json();
}

export async function strapiPost(path, body) {
  const res = await fetch(`${config.strapiUrl}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new StrapiError(res.status, await res.text());
  return res.json();
}

/** Kept for the organisation routers: any org write may change access. */
export function invalidateOrgAccessCache(userId) {
  invalidateAccess(userId);
}

// ---- editions ----------------------------------------------------------------

const EDITION_TTL_MS = 60 * 1000;
const editionCache = new Map(); // `${pub}|${date}` -> { value, expires }

/**
 * The published edition of `publication` that covers `dateIso`: the one
 * dated that day, or (for weekend/weekly papers) the one whose cover days
 * include it. Pages, page images and stories populated. null if none.
 */
export async function getEditionFor(publication, dateIso) {
  const pub = normPub(publication);
  const key = `${pub}|${dateIso}`;
  const hit = editionCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const query =
    `/api/editions?filters[publication][code][$eq]=${encodeURIComponent(pub)}` +
    `&filters[pipelineStatus][$eq]=published` +
    `&filters[$or][0][date][$eq]=${dateIso}` +
    `&filters[$or][1][$and][0][coversFrom][$lte]=${dateIso}` +
    `&filters[$or][1][$and][1][coversTo][$gte]=${dateIso}` +
    `&sort=date:desc&pagination[pageSize]=1` +
    `&populate[publication][fields][0]=code&populate[publication][fields][1]=name` +
    `&populate[publication][fields][2]=title&populate[publication][fields][3]=colour` +
    `&populate[publication][fields][4]=editionLabel` +
    `&populate[pages][populate][image]=true` +
    `&populate[pages][populate][stories]=true`;
  const json = await strapiGet(query);
  const value = json.data?.[0] || null;
  editionCache.set(key, { value, expires: Date.now() + EDITION_TTL_MS });
  if (editionCache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of editionCache) if (v.expires <= now) editionCache.delete(k);
  }
  return value;
}

/** Call when an edition is (re)published from handle, so readers see it at once. */
export function invalidateEditionCache() {
  editionCache.clear();
}

/** Absolute URL of one page's image in an edition from getEditionFor(). */
export function pageImageUrl(edition, pageNumber) {
  const page = (edition?.pages || []).find((p) => Number(p.pageNumber) === Number(pageNumber));
  const url = page?.image?.url;
  if (!url) return null;
  return url.startsWith('http') ? url : `${config.strapiUrl}${url}`;
}

/** The days an edition covers (older rows without cover dates: just its date). */
export function editionCover(edition) {
  return { from: edition.coversFrom || edition.date, to: edition.coversTo || edition.date };
}

// ---- catalogue -----------------------------------------------------------------

const STOREFRONT_TTL_MS = 30 * 1000;
let storefrontCache = null;

/** Landing page data: active publications, latest editions, featured plans. */
export async function getStorefront() {
  if (storefrontCache && storefrontCache.expires > Date.now()) return storefrontCache.value;
  const value = await strapiGet('/api/catalogue/storefront');
  storefrontCache = { value, expires: Date.now() + STOREFRONT_TTL_MS };
  return value;
}

export function invalidateStorefront() {
  storefrontCache = null;
}

/** Plans on sale today; only those including `publication` when given. */
export async function getCurrentPlans(publication) {
  const qs = publication ? `?publication=${encodeURIComponent(normPub(publication))}` : '';
  return strapiGet(`/api/catalogue/plans${qs}`);
}
