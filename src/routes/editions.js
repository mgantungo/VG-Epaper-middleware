/**
 * File:      /var/www/VGEpaper/middleware/src/routes/editions.js
 * Repo path: apps/middleware/src/routes/editions.js
 * System:    apps/middleware (Express, port 4161)      REWRITTEN (Phase 0)
 *
 * Editions are addressed by PUBLICATION and date:
 *   GET /api/editions/:pub/:date                 :date = YYYY-MM-DD | today | latest
 *   GET /api/editions/:pub/:date/pages/:num.jpg  page image, access re-checked
 *   GET /api/editions/:pub/:date/cover.jpg       front page, free to preview
 *   GET /api/editions/me/ranges?publication=NV   what this reader can open (archive badges)
 *
 * A date finds the edition that COVERS it: /nvw/2026-10-25 (a Sunday) opens
 * the weekend edition dated Saturday 24th.
 *
 * Old date-only URLs (/api/editions/2026-10-22, /api/editions/today and
 * their page images) still work and mean New Vision daily, so bookmarks and
 * shared links from before Phase 0 keep opening.
 *
 * Readers only receive active stories (reviewState empty or 'active');
 * stories dropped or awaiting drop in the handle editor are hidden.
 */
import { Router } from 'express';
import fetch from 'node-fetch';
import {
  getEditionFor, pageImageUrl, editionCover, getStorefront, getCurrentPlans
} from '../services/strapiClient.js';
import { hasAccess, todayIso, getAccessProfile, readableRanges, normPub } from '../services/access.js';
import { record } from '../services/analytics.js';

export const editionsRouter = Router();

const LEGACY_PUB = 'NV';
const PUB_RE = /^[A-Za-z0-9]{1,12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Stories created before reviewState existed have it empty: those count as active.
const isReaderVisible = s => !s.reviewState || s.reviewState === 'active';

/** :date -> YYYY-MM-DD, resolving 'today' and 'latest'; null if invalid. */
async function resolveDate(pub, raw) {
  if (raw === 'today') return todayIso();
  if (raw === 'latest') {
    const store = await getStorefront();
    const p = (store.publications || []).find(x => x.code === pub);
    return p?.latestEdition?.date || null;
  }
  return DATE_RE.test(raw) ? raw : null;
}

function publicationInfo(edition, pub) {
  const p = edition.publication || {};
  return {
    code: p.code || pub,
    name: p.name || pub,
    title: p.title || p.name || pub,
    editionLabel: p.editionLabel || null,
    colour: p.colour || null
  };
}

/** Single-issue price for the locked preview ("buy this edition"), from the plans on sale. */
async function singleIssuePrice(pub, edition) {
  try {
    const { plans } = await getCurrentPlans(pub);
    const single = (plans || []).find(p => p.kind === 'single_issue' && p.publications.length === 1);
    if (!single) return null;
    const override = edition?.archivePriceOverride;
    const isArchive = (edition.coversTo || edition.date) < todayIso();
    return {
      planKey: single.key,
      amount: isArchive && override ? Number(override) : single.price,
      currency: single.currency || 'UGX',
      kind: 'single_issue'
    };
  } catch (err) {
    console.error('[editions] could not load plans for the paywall:', err.message);
    return null;
  }
}

async function sendEdition(req, res, pub, rawDate) {
  if (!PUB_RE.test(pub)) return res.status(400).json({ error: 'Unknown publication' });
  const dateIso = await resolveDate(pub, rawDate);
  if (!dateIso) {
    return res.status(rawDate === 'latest' ? 404 : 400)
      .json({ error: rawDate === 'latest' ? 'Nothing published yet for this publication' : 'date must be YYYY-MM-DD, "today" or "latest"' });
  }

  const edition = await getEditionFor(pub, dateIso);
  if (!edition) return res.status(404).json({ error: `No published ${pub} edition for this date`, publicationCode: pub, date: dateIso });

  const cover = editionCover(edition);
  const granted = await hasAccess({ userId: req.userId, publication: pub, from: cover.from, to: cover.to });

  // Analytics: ?via= says where the reader came from (landing, archive, search, link).
  const via = ['landing', 'archive', 'search', 'link', 'paper'].includes(req.query.via) ? req.query.via : 'link';
  record(req, {
    type: 'edition.open',
    publication: pub,
    editionDate: edition.date,
    coversFrom: cover.from,
    coversTo: cover.to,
    locked: !granted,
    meta: { via }
  });

  const sortedPages = [...(edition.pages || [])].sort((a, b) => a.pageNumber - b.pageNumber);
  const basePages = sortedPages.map(p => ({ pageNumber: p.pageNumber, section: p.section }));
  const base = {
    date: edition.date,
    requestedDate: dateIso,
    coversFrom: cover.from,
    coversTo: cover.to,
    editionId: edition.documentId,
    sku: edition.sku,
    publicationCode: pub,
    publication: publicationInfo(edition, pub),
    pageCount: edition.pageCount,
    coverUrl: `/api/editions/${pub.toLowerCase()}/${edition.date}/cover.jpg`
  };

  if (!granted) {
    return res.json({
      ...base,
      locked: true,
      price: await singleIssuePrice(pub, edition),
      pages: basePages // page numbers/sections only — no image URLs, no story text
    });
  }

  const pages = sortedPages.map(p => ({
    pageNumber: p.pageNumber,
    section: p.section,
    editionSku: p.editionSku,
    imageUrl: `/api/editions/${pub.toLowerCase()}/${edition.date}/pages/${p.pageNumber}.jpg`,
    stories: (p.stories || []).filter(isReaderVisible).map(s => ({
      id: s.documentId,
      editionSku: s.editionSku,
      top: s.top, left: s.left, width: s.width, height: s.height,
      kicker: s.kicker,
      headline: s.headline,
      byline: s.byline,
      teaser: s.teaser,
      body: s.body,
      // Only set when ingest found an explicit jump-line marker ("Turned to
      // Page N" / "Continued from Page N") — never guessed from layout.
      continuesToPage: s.continuesToPage ?? null,
      continuesFromPage: s.continuesFromPage ?? null
    }))
  }));

  res.json({
    ...base,
    locked: false,
    volume: edition.volume,
    issueNumber: edition.issueNumber,
    coverPrice: edition.coverPrice,
    currency: edition.currency,
    pages
  });
}

async function streamImage(res, url, cacheControl) {
  const upstream = await fetch(url);
  if (!upstream.ok) return res.status(502).end();
  res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
  res.set('Cache-Control', cacheControl);
  upstream.body.pipe(res);
}

/**
 * Page image, re-checking access on THIS request — not just relying on the
 * caller having seen a granted edition response — so a bookmarked or shared
 * image URL never opens a paid page.
 */
async function sendPage(req, res, pub, rawDate, num) {
  if (!PUB_RE.test(pub)) return res.status(400).end();
  const dateIso = await resolveDate(pub, rawDate);
  if (!dateIso) return res.status(400).end();
  const edition = await getEditionFor(pub, dateIso);
  if (!edition) return res.status(404).end();
  const cover = editionCover(edition);
  const granted = await hasAccess({ userId: req.userId, publication: pub, from: cover.from, to: cover.to });
  if (!granted) return res.status(402).json({ error: 'Payment required' });
  const url = pageImageUrl(edition, Number(num));
  if (!url) return res.status(404).end();
  // private: only valid for the reader who was just checked
  return streamImage(res, url, 'private, max-age=3600');
}

// ---- reader's own access (registered before /:pub/:date so 'me' isn't a publication) ----

/** GET /api/editions/me/ranges?publication=NV -> { publication, ranges: [{start,end,source}] } */
editionsRouter.get('/me/ranges', async (req, res) => {
  const pub = normPub(req.query.publication || LEGACY_PUB);
  if (!req.userId) return res.json({ publication: pub, ranges: [] });
  try {
    const profile = await getAccessProfile(req.userId);
    res.json({ publication: pub, ranges: readableRanges(profile, pub) });
  } catch (err) {
    console.error('[editions] ranges failed:', err.message);
    res.status(502).json({ error: 'Could not load your access' });
  }
});

/** Older name for the same thing (New Vision unless ?publication= is given). */
editionsRouter.get('/me/purchased-dates', async (req, res) => {
  const pub = normPub(req.query.publication || LEGACY_PUB);
  if (!req.userId) return res.json({ ranges: [] });
  try {
    const profile = await getAccessProfile(req.userId);
    res.json({ ranges: readableRanges(profile, pub).map(({ start, end }) => ({ start, end })) });
  } catch (err) {
    console.error('[editions] purchased-dates failed:', err.message);
    res.status(502).json({ error: 'Could not load your access' });
  }
});

// ---- legacy date-only URLs = New Vision ---------------------------------------

editionsRouter.get('/:date', async (req, res, next) => {
  if (req.params.date !== 'today' && !DATE_RE.test(req.params.date)) return next();
  try { await sendEdition(req, res, LEGACY_PUB, req.params.date); } catch (err) { next(err); }
});

editionsRouter.get('/:date/pages/:num.jpg', async (req, res, next) => {
  if (req.params.date !== 'today' && !DATE_RE.test(req.params.date)) return next();
  try { await sendPage(req, res, LEGACY_PUB, req.params.date, req.params.num); } catch (err) { next(err); }
});

// ---- publication URLs ---------------------------------------------------------

editionsRouter.get('/:pub/:date', async (req, res, next) => {
  try { await sendEdition(req, res, normPub(req.params.pub), req.params.date); } catch (err) { next(err); }
});

editionsRouter.get('/:pub/:date/pages/:num.jpg', async (req, res, next) => {
  try { await sendPage(req, res, normPub(req.params.pub), req.params.date, req.params.num); } catch (err) { next(err); }
});

/** Front page of any published edition, free for everyone (landing page and paywall preview). */
editionsRouter.get('/:pub/:date/cover.jpg', async (req, res, next) => {
  try {
    const pub = normPub(req.params.pub);
    if (!PUB_RE.test(pub)) return res.status(400).end();
    const dateIso = await resolveDate(pub, req.params.date);
    if (!dateIso) return res.status(400).end();
    const edition = await getEditionFor(pub, dateIso);
    if (!edition) return res.status(404).end();
    const firstPage = [...(edition.pages || [])].sort((a, b) => a.pageNumber - b.pageNumber)[0];
    const url = firstPage ? pageImageUrl(edition, firstPage.pageNumber) : null;
    if (!url) return res.status(404).end();
    return streamImage(res, url, 'public, max-age=600');
  } catch (err) {
    next(err);
  }
});
