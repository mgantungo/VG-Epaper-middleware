import { Router } from 'express';
import fetch from 'node-fetch';
import { config } from '../config.js';
import { todayIso } from '../services/access.js';

export const paymentsRouter = Router();

/**
 * GET /api/pay/plans
 * Real plan data — key, label, price, currency, kind, durationDays — from
 * Strapi's epaper-plan collection, replacing the hardcoded
 * config.pricing.subscription/archiveEdition values editions.js's
 * priceFor() has been using. The paywall's plan picker calls this to
 * render its radio options with real, currently-configured prices;
 * changing a price in Strapi admin now actually reaches the UI without
 * any code change, which config.pricing values never could.
 * Requires the Public role's `find` permission enabled for epaper-plan in
 * Strapi (Settings -> Users & Permissions -> Roles -> Public ->
 * epaper-plan -> find) — read-only, no write permissions needed or
 * recommended there.
 */
paymentsRouter.get('/plans', async (req, res) => {
  try {
    const strapiRes = await fetch(
      `${config.strapiUrl}/api/epaper-plans?filters[active][$eq]=true&sort=sortOrder:asc&pagination[pageSize]=100`,
      { headers: { Authorization: `Bearer ${config.strapiApiToken}` } }
    );
    if (!strapiRes.ok) {
      return res.status(strapiRes.status).json({ error: 'Could not load plans' });
    }
    const json = await strapiRes.json();
    const plans = (json.data || []).map(p => ({
      key: p.key,
      label: p.label,
      kind: p.kind,
      durationDays: p.durationDays,
      price: p.price,
      currency: p.currency,
      allowsOrgPurchase: p.allowsOrgPurchase
    }));
    res.json({ plans });
  } catch (err) {
    console.error('[payments] plans: could not reach Strapi:', err.message);
    res.status(502).json({ error: 'Could not reach payment service' });
  }
});

/**
 * POST /api/pay/checkout
 * Body: { date: "YYYY-MM-DD" | "today", phoneNumber, paymentmethod }
 *    OR { dates: ["YYYY-MM-DD", ...], phoneNumber, paymentmethod }
 *
 * Proxies to Strapi's POST /api/epaper-transactions/initialize. `dates`
 * (plural) is the "buy any number of archives in one purchase" shape —
 * every entry becomes its own entitlement once payment succeeds (see
 * epaper-transaction's grantEntitlement()), priced as
 * single_archive.price × number of dates. `date` (singular) still works
 * exactly as before — "today" maps to the daily plan, any other single
 * date maps to a one-element archive purchase. Only one of date/dates
 * should be sent; dates wins if both are present.
 *
 * SCOPED DELIBERATELY: personal purchases only, no organization_new/
 * organization_topup — those exist as real options in epaper-plan
 * already, but choosing between them needs picker UI the frontend
 * doesn't have yet.
 *
 * NOTE: unlike the old "assume yes" version, this does NOT grant access
 * itself and does NOT return an external checkoutUrl to redirect to — the
 * integrator sends a payment PIN prompt directly to the customer's phone,
 * there's no hosted checkout page to redirect to.
 */
paymentsRouter.post('/checkout', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Sign in required' });

  const { phoneNumber, paymentmethod } = req.body || {};
  if (!phoneNumber || !paymentmethod) {
    return res.status(400).json({ error: 'phoneNumber and paymentmethod are required' });
  }

  const rawDates = Array.isArray(req.body?.dates) ? req.body.dates : null;
  const singleDateIso = req.body?.date === 'today' ? todayIso() : req.body?.date;

  if (!rawDates && !singleDateIso) {
    return res.status(400).json({ error: 'date or dates is required' });
  }

  // A multi-date request is always an archive purchase — "today" isn't an
  // archive date yet, so it doesn't belong mixed into this shape; it goes
  // through the singular `date: 'today'` path below instead.
  const isMultiArchive = Boolean(rawDates && rawDates.length);
  const isToday = !isMultiArchive && singleDateIso === todayIso();

  // planKey is now explicit from the plan picker (radio selection) rather
  // than always auto-derived from the date — the whole point of letting
  // someone choose weekly/monthly/etc. instead of just paying for today.
  // Still falls back to the old auto-derivation when the caller doesn't
  // send one, so nothing that predates the plan picker breaks.
  const planKey = req.body?.planKey || (isToday ? 'daily' : 'single_archive');

  try {
    const strapiRes = await fetch(`${config.strapiUrl}/api/epaper-transactions/initialize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.strapiApiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: req.userId,
        phoneNumber,
        paymentmethod,
        planKey,
        purchaseKind: 'personal',
        customerName: req.userProfile?.displayName || '',
        customerEmail: req.userProfile?.email || '',
        customerPhone: phoneNumber,
        ...(isMultiArchive
          ? { archiveDates: rawDates }
          : { archiveDate: isToday ? undefined : singleDateIso })
      })
    });
    const data = await strapiRes.json();
    if (!strapiRes.ok) {
      return res.status(strapiRes.status).json({ error: data?.error || 'Could not start payment' });
    }

    res.json({
      receiptToken: data.receipt_token,
      invoiceNumber: data.invoice_number,
      amount: data.amount,
      currency: data.currency,
      status: data.status,
      archiveDatesCount: data.archiveDatesCount
    });
  } catch (err) {
    console.error('[payments] checkout: could not reach Strapi:', err.message);
    res.status(502).json({ error: 'Could not reach payment service' });
  }
});

/**
 * GET /api/pay/status/:receiptToken
 * Proxies to Strapi's GET /api/epaper-transactions/status/:token — lets the
 * frontend poll while the customer approves the PIN prompt on their phone.
 */
paymentsRouter.get('/status/:receiptToken', async (req, res) => {
  try {
    const strapiRes = await fetch(`${config.strapiUrl}/api/epaper-transactions/status/${req.params.receiptToken}`, {
      headers: { Authorization: `Bearer ${config.strapiApiToken}` }
    });
    const data = await strapiRes.json();
    res.status(strapiRes.status).json(data);
  } catch (err) {
    console.error('[payments] status: could not reach Strapi:', err.message);
    res.status(502).json({ error: 'Could not reach payment service' });
  }
});

/**
 * POST /api/pay/callback
 *
 * A thin proxy — the actual callback logic lives entirely in Strapi's
 * epaper-transaction controller (verifying the shared secret, updating
 * aggregator_status, granting the entitlement on success). This exists
 * purely because Strapi has never been exposed to the public internet
 * anywhere in this project — everything public-facing goes through the
 * middleware, Strapi stays reachable only internally via
 * config.strapiApiToken — and the payment integrator, an external
 * third-party service, needs a PUBLIC url to call back to. Rather than
 * carve out a one-off exception and expose Strapi directly for just this
 * endpoint, this route gives the integrator a public URL that forwards
 * straight through to Strapi's real one internally.
 *
 * PAYMENT_CALLBACK_URL in apps/cms/.env (NOT this service's .env — that
 * warning about it being unset comes from the CMS's own controller code)
 * needs to be set to THIS route's public URL
 * (https://<this-service's-public-domain>/api/pay/callback), not
 * Strapi's own address directly.
 *
 * Forwards the x-callback-secret header if present, since Strapi's own
 * callback action checks it — the integrator will have been configured
 * to send that header to whatever URL it's given (now this one), so it
 * has to be relayed through, not dropped, or Strapi's own verification
 * would see it missing.
 */
paymentsRouter.post('/callback', async (req, res) => {
  try {
    const strapiRes = await fetch(`${config.strapiUrl}/api/epaper-transactions/callback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(req.headers['x-callback-secret'] ? { 'x-callback-secret': req.headers['x-callback-secret'] } : {})
      },
      body: JSON.stringify(req.body)
    });
    const data = await strapiRes.json().catch(() => ({}));
    res.status(strapiRes.status).json(data);
  } catch (err) {
    console.error('[payments] callback proxy: could not reach Strapi:', err.message);
    res.status(502).json({ error: 'Could not reach payment service' });
  }
});