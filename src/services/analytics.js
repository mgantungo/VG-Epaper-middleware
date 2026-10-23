/**
 * File:      /var/www/VGEpaper/middleware/src/services/analytics.js
 * Repo path: apps/middleware/src/services/analytics.js
 * System:    apps/middleware (Express, port 4161)          NEW FILE (Phases 1–4)
 *
 * Records what readers do, for the analytics dashboards.
 *
 *   record(req, event)   adds one event; never throws, never slows a request
 *
 * Each event is enriched here — reader (signed-in user or anonymous visitor
 * id), session, how they get access to the publication (personal,
 * organisation, none), their organisation and seat, device, browser, OS and
 * a hashed IP — then buffered and sent to the CMS in batches
 * (POST /api/analytics/ingest) every 2 seconds or 200 events. If the CMS is
 * down, the batch is kept and retried (up to 20,000 events, then the oldest
 * are dropped) so reading never depends on analytics.
 *
 * Event types:
 *   auth.login, auth.refresh       sign-ins (refresh: once per reader per day)
 *   edition.open                   an edition loaded (locked = preview only)
 *   page.view                      a page on screen, with time on page (dwellMs)
 *   story.open                     a story opened, with reading time
 *   search.query                   a reader search
 *   paywall.view, checkout.start   paywall shown, payment started
 *
 * ANALYTICS_ENABLED=false turns recording off (nothing is buffered or sent).
 * ANALYTICS_IP_SALT salts the IP hash (set it; any random string).
 */
import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { config } from '../config.js';
import { getAccessProfile, readableRanges, normPub } from './access.js';

const ENABLED = String(process.env.ANALYTICS_ENABLED ?? 'true').toLowerCase() !== 'false';
const SALT = process.env.ANALYTICS_IP_SALT || config.jwtAccessSecret || 'epaper';
const FLUSH_MS = 2000;
const BATCH = 200;
const MAX_BUFFER = 20000;

const buffer = [];
let flushing = false;
let timer = null;
let warnedAt = 0;

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const cleanId = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);

export function analyticsEnabled() {
  return ENABLED;
}

/** Device class, browser and OS from a user-agent string. */
export function parseAgent(ua = '') {
  const s = String(ua);
  const os = /Android/i.test(s) ? 'Android'
    : /iPhone|iPad|iPod/i.test(s) ? 'iOS'
      : /Windows/i.test(s) ? 'Windows'
        : /Mac OS X|Macintosh/i.test(s) ? 'macOS'
          : /Linux/i.test(s) ? 'Linux' : null;
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
      : /SamsungBrowser/.test(s) ? 'Samsung'
        : /Firefox\//.test(s) ? 'Firefox'
          : /Chrome\//.test(s) ? 'Chrome'
            : /Safari\//.test(s) ? 'Safari' : null;
  const device = /iPad|Tablet/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s)) ? 'tablet'
    : /Mobi|iPhone|Android/i.test(s) ? 'phone'
      : s ? 'desktop' : null;
  return { device, browser, os };
}

function ipOf(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || req.socket?.remoteAddress || '';
}

/** The reader's access to `publication` for days [from, to]: personal | organisation | none. */
export function accessVia(profile, publication, from, to) {
  if (!profile || !publication) return 'none';
  const end = to || from;
  const ranges = readableRanges(profile, publication).filter((r) => !from || (r.start <= end && from <= r.end));
  if (ranges.some((r) => r.source === 'personal')) return 'personal';
  if (ranges.length) return 'organisation';
  return 'none';
}

/**
 * Builds the stored event. `ctx` carries what the request knows:
 *   { userId, visitorId, sessionId, userAgent, ip }
 */
async function enrich(ctx, ev) {
  const userId = ctx.userId ? Number(ctx.userId) : null;
  let profile = null;
  if (userId) {
    try {
      profile = await getAccessProfile(userId);
    } catch {
      profile = null; // analytics never fails because access could not be loaded
    }
  }
  const publication = ev.publication ? normPub(ev.publication) : null;
  const from = ev.coversFrom || ev.editionDate || null;
  const to = ev.coversTo || from;
  const agent = parseAgent(ctx.userAgent);
  const ip = ctx.ip || '';
  return {
    type: ev.type,
    occurredAt: Number(ev.occurredAt) || Date.now(),
    userId,
    visitorId: cleanId(ctx.visitorId),
    sessionId: cleanId(ctx.sessionId),
    orgId: profile?.org?.orgId || null,
    seatId: profile?.org?.seatId || null,
    accessVia: ev.accessVia || (publication ? accessVia(profile, publication, from, to) : null),
    publication,
    editionDate: ev.editionDate || null,
    pageNumber: ev.pageNumber ?? null,
    section: ev.section || null,
    storyId: ev.storyId || null,
    dwellMs: ev.dwellMs ?? null,
    locked: ev.locked ?? null,
    device: agent.device,
    browser: agent.browser,
    os: agent.os,
    ipHash: ip ? crypto.createHash('sha256').update(`${SALT}|${ip}`).digest('hex').slice(0, 32) : null,
    meta: ev.meta || null
  };
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_MS);
  timer.unref?.();
}

export async function flush() {
  if (flushing || !buffer.length) return;
  flushing = true;
  try {
    while (buffer.length) {
      const batch = buffer.slice(0, BATCH);
      const res = await fetch(`${config.strapiUrl}/api/analytics/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.strapiApiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch })
      });
      if (!res.ok) throw new Error(`CMS answered ${res.status}`);
      buffer.splice(0, batch.length);
    }
  } catch (err) {
    if (Date.now() - warnedAt > 60000) {
      console.warn(`[analytics] could not send ${buffer.length} events, will retry: ${err.message}`);
      warnedAt = Date.now();
    }
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
    setTimeout(schedule, 10000).unref?.();
  } finally {
    flushing = false;
  }
  if (buffer.length >= BATCH) schedule();
}

/** Request context for record(): reader, visitor/session ids from headers, agent, ip. */
export function contextOf(req, extra = {}) {
  return {
    userId: req.userId || null,
    visitorId: req.get?.('x-visitor-id') || null,
    sessionId: req.get?.('x-session-id') || null,
    userAgent: req.get?.('user-agent') || '',
    ip: ipOf(req),
    ...extra
  };
}

/** Record events with an explicit context. Fire-and-forget. */
export function recordWith(ctx, events) {
  if (!ENABLED) return;
  const list = Array.isArray(events) ? events : [events];
  Promise.all(list.map((ev) => enrich(ctx, ev)))
    .then((rows) => {
      buffer.push(...rows);
      if (buffer.length >= BATCH) flush();
      else schedule();
    })
    .catch((err) => console.warn('[analytics] dropped an event:', err.message));
}

/** Record one event for this request. Fire-and-forget. */
export function record(req, event, extraCtx = {}) {
  recordWith(contextOf(req, extraCtx), event);
}

// auth.refresh happens every few minutes; one per reader per Kampala day is enough to mark the day.
const refreshSeen = new Map();
export function recordRefresh(req, userId) {
  const day = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const key = String(userId);
  if (refreshSeen.get(key) === day) return;
  refreshSeen.set(key, day);
  if (refreshSeen.size > 50000) refreshSeen.clear();
  record(req, { type: 'auth.refresh' }, { userId });
}

// Send what is buffered when pm2 stops or restarts the process.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    flush().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
