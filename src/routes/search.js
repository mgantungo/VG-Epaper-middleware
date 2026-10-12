import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { searchStories } from '../services/storySearchClient.js';
import { hasAccess } from '../services/access.js';

/**
 * apps/middleware/src/routes/search.js                       NEW FILE
 *
 * POST /api/search/stories — the public entry point to the CMS full-text search.
 * External clients never talk to Strapi; this route validates the request,
 * forwards only whitelisted fields, and shapes the response.
 *
 * Auth:  an access key from SEARCH_ACCESS_KEY (.env), sent as the
 *        `x-access-key` header (preferred) or the `access_key` query parameter.
 * Body: { query (>=5 words), startDate?, endDate?, page?, pageSize? }
 *
 * Paywall: story text is only revealed for editions the caller may read.
 * attachUser (server.js) sets req.userId when a valid token is sent; each
 * result's edition date is checked with hasAccess(), once per distinct date.
 * Results the caller can't read come back with locked: true and snippet: null
 * (headline, teaser, section and page number stay visible).
 */

export const searchRouter = express.Router();

const MIN_WORDS = 5;

// ---- small in-memory per-IP limiter (search is the costliest public route) ----
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const hits = new Map(); // ip -> { count, reset }

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || 'unknown';
  const entry = hits.get(ip);
  if (!entry || entry.reset <= now) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
  } else if (++entry.count > MAX_REQUESTS) {
    res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
    return res.status(429).json({ error: 'Too many searches. Please try again shortly.' });
  }
  if (hits.size > 5000) {
    for (const [key, v] of hits) if (v.reset <= now) hits.delete(key);
  }
  next();
}

// ---- access key (SEARCH_ACCESS_KEY in .env; comma-separated for several keys) ----
const digest = (value) => createHash('sha256').update(String(value)).digest();

function requireAccessKey(req, res, next) {
  if (!config.searchAccessKeys.length) {
    // Fail closed: a missing key must never leave the endpoint open.
    console.error('[search] SEARCH_ACCESS_KEY is not set — refusing all search requests');
    return res.status(503).json({ error: 'Search is not configured' });
  }
  const provided = req.get('x-access-key') || req.query.access_key;
  if (typeof provided !== 'string' || !provided) {
    return res.status(401).json({ error: 'Access key required' });
  }
  // Hash both sides so the buffers are equal length and the comparison is constant-time.
  const given = digest(provided);
  const ok = config.searchAccessKeys.some((key) => timingSafeEqual(given, digest(key)));
  if (!ok) {
    console.warn(`[search] rejected request with an invalid access key from ${req.ip}`);
    return res.status(401).json({ error: 'Invalid access key' });
  }
  next();
}

/** '.../2026/09/14' -> '2026-09-14' (null if the link has no date). */
function dateFromLink(link) {
  const m = /(\d{4})\/(\d{2})\/(\d{2})\/?$/.exec(link || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

searchRouter.post('/stories', rateLimit, requireAccessKey, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Request body must be a JSON object' });

  const { query, startDate, endDate, page, pageSize } = body;
  if (typeof query !== 'string' || query.trim().split(/\s+/).length < MIN_WORDS) {
    return res.status(400).json({ error: `query must contain at least ${MIN_WORDS} words` });
  }

  const result = await searchStories({ query, startDate, endDate, page, pageSize });

  if (!result.ok) {
    if (result.status === 400) {
      const e = result.data?.error;
      return res.status(400).json({ error: (typeof e === 'string' ? e : e?.message) || 'Invalid search request' });
    }
    // 401/403 here means STRAPI_API_TOKEN lacks the Story-search → search permission — our problem, not the caller's.
    return res.status(502).json({ error: 'Search is temporarily unavailable' });
  }

  const results = result.data?.data || [];

  // One hasAccess() per distinct edition date, not per result.
  const accessByDate = new Map();
  if (req.userId) {
    const dates = [...new Set(results.map((r) => dateFromLink(r.epaperLink)).filter(Boolean))];
    await Promise.all(
      dates.map(async (dateIso) => {
        try {
          accessByDate.set(dateIso, await hasAccess({ userId: req.userId, dateIso }));
        } catch (err) {
          console.error('[search] access check failed for', dateIso, err.message);
          accessByDate.set(dateIso, false); // fail closed
        }
      })
    );
  }

  const data = results.map((r) => {
    const dateIso = dateFromLink(r.epaperLink);
    const unlocked = Boolean(dateIso && accessByDate.get(dateIso));
    return { ...r, locked: !unlocked, snippet: unlocked ? r.snippet : null };
  });

  res.json({
    data,
    meta: {
      pagination: result.data?.meta?.pagination,
      search: result.data?.meta?.search
    }
  });
});