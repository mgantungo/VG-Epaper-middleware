import fetch from 'node-fetch';
import { config } from '../config.js';

/**
 * apps/middleware/src/services/access.js              REWRITTEN (Phase 0)
 *
 * Who may read what, decided per PUBLICATION (agreed 23 Oct 2026: every
 * paper is sold separately, to individuals and to organisations).
 *
 * An edition E of publication P covers the days [E.coversFrom, E.coversTo]
 * (a daily covers its date; a weekend edition dated Saturday covers
 * Saturday–Sunday). A reader may open E if EITHER
 *   - they hold a personal entitlement for P whose [start, end] shares a day
 *     with E's cover days (period plans, and single-issue purchases, whose
 *     dates are exactly E's cover days), OR
 *   - they hold an ACTIVE seat in an ACTIVE organisation, the seat reads P
 *     (its publication list includes P; older seats with no list read all),
 *     and on at least one of E's cover days the organisation's contract for
 *     P AND the member's own access window both apply (legacy seats need
 *     only the contract).
 *
 * The facts come from the CMS in ONE call per reader
 * (GET /api/catalogue/access/:userId) and are cached for ACCESS_TTL_MS,
 * because this runs on every page image. Writes made through this process
 * (organisation changes, a confirmed payment) clear the cache straight away;
 * other pm2 instances catch up within the TTL.
 */

const ACCESS_TTL_MS = 15 * 1000;
const KAMPALA_OFFSET_MS = 3 * 60 * 60 * 1000;
const cache = new Map(); // userId -> { value, expires }

/** Today's date in Kampala (UTC+3), the day printed on the paper. */
export function todayIso(now = Date.now()) {
  return new Date(now + KAMPALA_OFFSET_MS).toISOString().slice(0, 10);
}

export function normPub(code) {
  return String(code || '').trim().toUpperCase();
}

/** Clear one reader's cached access, or everyone's. */
export function invalidateAccess(userId) {
  if (userId === undefined || userId === null) cache.clear();
  else cache.delete(String(userId));
}

/** The reader's access facts (see the CMS catalogue-store accessProfile). */
export async function getAccessProfile(userId) {
  if (!userId) return null;
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const res = await fetch(`${config.strapiUrl}/api/catalogue/access/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${config.strapiApiToken}` }
  });
  if (!res.ok) throw new Error(`access profile returned ${res.status}`);
  const value = await res.json();
  cache.set(key, { value, expires: Date.now() + ACCESS_TTL_MS });
  if (cache.size > 20000) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  }
  return value;
}

const overlap = (aStart, aEnd, bStart, bEnd) => aStart <= bEnd && bStart <= aEnd;
const later = (a, b) => (a > b ? a : b);
const earlier = (a, b) => (a < b ? a : b);

function seatReads(org, pub) {
  return org.seatPublications === null || org.seatPublications === undefined || org.seatPublications.includes(pub);
}

/** Ranges of P this organisation access opens: contract ∩ member window. */
function orgRanges(org, pub) {
  if (!org?.usable || !seatReads(org, pub)) return [];
  const contracts = (org.contracts || []).filter((c) => c.publication === pub);
  if (org.legacy || org.memberWindows === null) return contracts.map((c) => ({ start: c.start, end: c.end }));
  const out = [];
  for (const w of org.memberWindows || []) {
    for (const c of contracts) {
      const start = later(w.start, c.start);
      const end = earlier(w.end, c.end);
      if (start <= end) out.push({ start, end });
    }
  }
  return out;
}

/**
 * Every range of `publication` this profile can read, personal and
 * organisation merged into one list. Drives the archive lock badges.
 */
export function readableRanges(profile, publication) {
  if (!profile) return [];
  const pub = normPub(publication);
  const personal = (profile.personal || [])
    .filter((e) => e.publication === pub)
    .map((e) => ({ start: e.start, end: e.end, source: 'personal' }));
  const org = orgRanges(profile.org, pub).map((r) => ({ ...r, source: 'organisation' }));
  return [...personal, ...org];
}

/** Does `profile` open an edition of `publication` covering [from, to]? Pure. */
export function profileCovers(profile, { publication, from, to }) {
  const end = to || from;
  return readableRanges(profile, publication).some((r) => overlap(r.start, r.end, from, end));
}

/**
 * hasAccess({ userId, publication, from, to? })
 *   publication: code (NV, BK, …); from/to: the edition's cover days.
 * Old callers passing { userId, dateIso } are treated as New Vision on that
 * one day, so nothing breaks while the web app moves to publication URLs.
 */
export async function hasAccess({ userId, publication, from, to, dateIso }) {
  if (!userId) return false;
  const profile = await getAccessProfile(userId);
  return profileCovers(profile, {
    publication: publication || 'NV',
    from: from || dateIso,
    to: to || from || dateIso
  });
}

/** Summary of one reader's access to each publication on `day`, for the
 * landing page and /api/account/me. */
export function accessSummary(profile, publications, day = todayIso()) {
  const out = {};
  for (const code of publications) {
    const ranges = readableRanges(profile, code);
    const now = ranges.filter((r) => r.start <= day && day <= r.end);
    out[code] = {
      today: now.length > 0,
      until: now.reduce((m, r) => (r.end > m ? r.end : m), '') || null,
      via: now.some((r) => r.source === 'personal') ? 'personal' : now.length ? 'organisation' : null,
      ranges: ranges.map(({ start, end, source }) => ({ start, end, source }))
    };
  }
  return out;
}
