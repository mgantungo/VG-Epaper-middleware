import { Router } from 'express';
import fetch from 'node-fetch';
import { config } from '../config.js';
import { todayIso } from '../services/access.js';

export const paymentsRouter = Router();

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
  const planKey = isToday ? 'daily' : 'single_archive';

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