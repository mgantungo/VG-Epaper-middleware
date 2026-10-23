/**
 * File:      /var/www/VGEpaper/middleware/src/routes/track.js
 * Repo path: apps/middleware/src/routes/track.js
 * System:    apps/middleware (Express, port 4161)          NEW FILE (Phases 1–4)
 *
 * POST /api/track — reading events from the web reader.
 *
 * Sent with navigator.sendBeacon (so it survives closing the tab), which
 * can't set headers: the body is a JSON string (text/plain) carrying the
 * reader's access token, if signed in, and the visitor and session ids:
 *
 *   { token?, vid, sid, events: [
 *       { type: 'page.view',   publication, editionDate, pageNumber, dwellMs, at },
 *       { type: 'story.open',  publication, editionDate, pageNumber, storyId, dwellMs, at },
 *       { type: 'paywall.view', publication, editionDate, at },
 *       { type: 'search.query', publication?, q, results, at }
 *   ] }
 *
 * Nothing from the browser is trusted beyond "this happened": the reader
 * comes from the verified token, the section and the locked flag are looked
 * up here from the edition, a story must belong to that edition, time on a
 * page is capped at 10 minutes, and an event more than a day old is dropped.
 * Answers 204 whatever happens, so the reader never waits on analytics.
 */
import express, { Router } from 'express';
import { verifyAccessToken } from '../services/tokens.js';
import { getEditionFor, editionCover } from '../services/strapiClient.js';
import { hasAccess, normPub } from '../services/access.js';
import { recordWith, contextOf, analyticsEnabled } from '../services/analytics.js';

export const trackRouter = Router();
trackRouter.use(express.text({ type: () => true, limit: '64kb' }));

const TYPES = new Set(['page.view', 'story.open', 'paywall.view', 'search.query']);
const PUB_RE = /^[A-Z0-9]{1,12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DWELL = 10 * 60 * 1000;
const DAY = 24 * 3600 * 1000;

// 600 events a minute per IP is far above any real reader.
const hits = new Map();
function allowed(ip, n) {
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || e.reset < now) {
    hits.set(ip, { count: n, reset: now + 60000 });
    if (hits.size > 50000) hits.clear();
    return true;
  }
  e.count += n;
  return e.count <= 600;
}

function parse(body) {
  if (body && typeof body === 'object') return body;
  try {
    return JSON.parse(String(body || ''));
  } catch {
    return null;
  }
}

async function editionFacts(cache, userId, pub, date) {
  const key = `${pub}:${date}`;
  if (cache.has(key)) return cache.get(key);
  let facts = null;
  try {
    const edition = await getEditionFor(pub, date);
    if (edition && edition.date === date) {
      const cover = editionCover(edition);
      const granted = await hasAccess({ userId, publication: pub, from: cover.from, to: cover.to });
      const pages = new Map((edition.pages || []).map((p) => [p.pageNumber, p]));
      facts = { cover, granted, pages };
    }
  } catch {
    facts = null;
  }
  cache.set(key, facts);
  return facts;
}

trackRouter.post('/', async (req, res) => {
  res.status(204).end();
  if (!analyticsEnabled()) return;
  const body = parse(req.body);
  if (!body || !Array.isArray(body.events) || !body.events.length) return;

  let userId = req.userId || null;
  if (!userId && typeof body.token === 'string' && body.token.length < 4000) {
    try {
      userId = verifyAccessToken(body.token).sub;
    } catch {
      userId = null; // expired token: still counted, as the visitor
    }
  }
  const ctx = contextOf(req, { userId, visitorId: body.vid, sessionId: body.sid });
  const list = body.events.slice(0, 100);
  if (!allowed(ctx.ip || 'unknown', list.length)) return;

  const now = Date.now();
  const editions = new Map();
  const out = [];
  for (const raw of list) {
    if (!raw || !TYPES.has(raw.type)) continue;
    const at = Number(raw.at) || now;
    if (at > now + 60000 || at < now - DAY) continue;

    if (raw.type === 'search.query') {
      const q = String(raw.q || '').trim().slice(0, 120);
      if (!q) continue;
      const pub = raw.publication ? normPub(raw.publication) : null;
      out.push({ type: 'search.query', occurredAt: at, publication: pub && PUB_RE.test(pub) ? pub : null, meta: { q, results: Number(raw.results) || 0 } });
      continue;
    }

    const pub = normPub(raw.publication);
    const date = String(raw.editionDate || '');
    if (!PUB_RE.test(pub) || !DATE_RE.test(date)) continue;
    const facts = await editionFacts(editions, userId, pub, date);
    if (!facts) continue;
    const base = { occurredAt: at, publication: pub, editionDate: date, coversFrom: facts.cover.from, coversTo: facts.cover.to };

    if (raw.type === 'paywall.view') {
      out.push({ ...base, type: 'paywall.view', locked: !facts.granted });
      continue;
    }
    const pageNumber = Number(raw.pageNumber);
    const page = facts.pages.get(pageNumber);
    if (!page) continue;
    const dwellMs = Math.max(0, Math.min(MAX_DWELL, Math.round(Number(raw.dwellMs) || 0)));

    if (raw.type === 'page.view') {
      // A locked reader only ever sees the front page.
      if (!facts.granted && pageNumber !== 1) continue;
      out.push({ ...base, type: 'page.view', pageNumber, section: page.section || null, dwellMs, locked: !facts.granted });
    } else if (raw.type === 'story.open') {
      if (!facts.granted) continue;
      const storyId = String(raw.storyId || '');
      if (!(page.stories || []).some((s) => s.documentId === storyId)) continue;
      out.push({ ...base, type: 'story.open', pageNumber, section: page.section || null, storyId, dwellMs, locked: false });
    }
  }
  if (out.length) recordWith(ctx, out);
});
