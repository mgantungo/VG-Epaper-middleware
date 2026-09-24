import { Router } from 'express';
import fetch from 'node-fetch';
import { config } from '../config.js';
import { getEditionByDate, getPageImageUrl, getEntitlementRanges } from '../services/strapiClient.js';
import { hasAccess, todayIso } from '../services/access.js';

export const editionsRouter = Router();

// NOTE: still reading static config.pricing here, not epaper-plan's actual
// price — deliberately left as-is for this pass, since wiring the paywall's
// displayed price to real Plan records belongs with the /checkout rebuild
// (the next item in the series), not this entitlement-checking one. This
// will need to change then, not forgotten, just sequenced.
function priceFor(dateIso, edition) {
  if (dateIso === todayIso()) {
    return { amount: config.pricing.subscription, currency: config.pricing.subscriptionCurrency, kind: 'subscription' };
  }
  const override = edition?.archivePriceOverride;
  return { amount: override ?? config.pricing.archiveEdition, currency: 'UGX', kind: 'archive_purchase' };
}

/**
 * GET /api/editions/:date
 * :date is either "today" or YYYY-MM-DD. Defaults to the server's current
 * date when the literal "today" is used, so the frontend never has to compute
 * "today" itself — this is the single source of truth for what "today" means.
 *
 * Always returns edition metadata (so the paywall can show a locked preview
 * with the real date/price), but page image URLs and story text are only
 * included when the requester actually has access.
 *
 * Response shapes below read Strapi 5's flattened fields directly (e.g.
 * `edition.pages[i].image.url`) — there is no `.attributes` wrapper to dig
 * through, unlike Strapi 4.
 */
editionsRouter.get('/:date', async (req, res) => {
  const dateIso = req.params.date === 'today' ? todayIso() : req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD or "today"' });
  }

  const edition = await getEditionByDate(dateIso);
  if (!edition) {
    return res.status(404).json({ error: 'No published edition for this date' });
  }

  const granted = await hasAccess({ userId: req.userId, dateIso });

  const sortedPages = [...(edition.pages || [])].sort((a, b) => a.pageNumber - b.pageNumber);
  const basePages = sortedPages.map(p => ({ pageNumber: p.pageNumber, section: p.section }));

  if (!granted) {
    return res.json({
      date: dateIso,
      locked: true,
      pageCount: edition.pageCount,
      price: priceFor(dateIso, edition),
      pages: basePages // page numbers/sections only — no image URLs, no story text
    });
  }

  const pages = sortedPages.map(p => ({
    pageNumber: p.pageNumber,
    section: p.section,
    // Signed/short-lived URLs in production — see the README note on
    // fronting this with a real CDN instead of proxying through Node.
    imageUrl: `/api/editions/${dateIso}/pages/${p.pageNumber}.jpg`,
    stories: (p.stories || []).map(s => ({
      id: s.documentId,
      top: s.top, left: s.left, width: s.width, height: s.height,
      kicker: s.kicker,
      headline: s.headline,
      byline: s.byline,
      teaser: s.teaser,
      body: s.body
    }))
  }));

  res.json({
    date: dateIso,
    locked: false,
    volume: edition.volume,
    issueNumber: edition.issueNumber,
    coverPrice: edition.coverPrice,
    currency: edition.currency,
    pageCount: edition.pageCount,
    pages
  });
});

/**
 * GET /api/editions/:date/pages/:num.jpg
 * Streams the actual page image, re-checking access on THIS request — not
 * just relying on the caller having seen a granted /:date response earlier.
 * That matters because someone could otherwise bookmark/share an image URL
 * and read a paid edition without ever passing the entitlement check.
 */
editionsRouter.get('/:date/pages/:num.jpg', async (req, res) => {
  const dateIso = req.params.date === 'today' ? todayIso() : req.params.date;
  const granted = await hasAccess({ userId: req.userId, dateIso });
  if (!granted) return res.status(402).json({ error: 'Payment required' });

  const imageUrl = await getPageImageUrl(dateIso, Number(req.params.num));
  if (!imageUrl) return res.status(404).end();

  const upstream = await fetch(imageUrl);
  if (!upstream.ok) return res.status(502).end();
  res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=3600'); // private: this response is only valid for the requester who was just entitlement-checked
  upstream.body.pipe(res);
});

/** This user's entitlement date ranges — powers the lock badges in the
 * Archive UI. Was `{ dates: [...] }` (flat list); now `{ ranges: [...] }`,
 * since one entitlement can span a whole subscription period, not just a
 * single purchased day — see getEntitlementRanges()'s own comment. */
editionsRouter.get('/me/purchased-dates', async (req, res) => {
  if (!req.userId) return res.json({ ranges: [] });
  res.json({ ranges: await getEntitlementRanges(req.userId) });
});