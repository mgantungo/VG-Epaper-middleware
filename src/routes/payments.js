import { Router } from 'express';
import fetch from 'node-fetch';
import { config } from '../config.js';
import { todayIso } from '../services/access.js';

export const paymentsRouter = Router();

/**
 * POST /api/pay/checkout
 * Body: { date: "YYYY-MM-DD" | "today", phoneNumber, paymentmethod }
 *
 * Proxies to Strapi's POST /api/epaper-transactions/initialize (built
 * earlier — see apps/cms/src/api/epaper-transaction). That endpoint is
 * what actually creates the pending transaction and requests the payment
 * prompt from the integrator; the middleware's only job here is checking
 * the reader is signed in and picking the right planKey.
 *
 * SCOPED DELIBERATELY: only 'daily' (today) and 'single_archive' (any
 * other date) — personal purchases only, no organization_new/
 * organization_topup, no weekly/monthly/quarterly/annual. Those all exist
 * as real plans in epaper-plan already, but choosing between them needs
 * picker UI the frontend doesn't have yet. Extending this once that UI
 * exists means accepting planKey/purchaseKind from the request body
 * instead of hardcoding them below — the Strapi side already supports it.
 *
 * NOTE: unlike the old "assume yes" version, this does NOT grant access
 * itself and does NOT return an external checkoutUrl to redirect to — the
 * integrator sends a payment PIN prompt directly to the customer's phone
 * (see epaper-transaction's callIntegrator()), there's no hosted checkout
 * page to redirect to. The frontend's PaywallModal.vue still assumes a
 * redirect-based flow from the earlier placeholder design — that's a real,
 * separate follow-up: it needs to show "check your phone" and poll for
 * completion instead, not navigate anywhere.
 */
paymentsRouter.post('/checkout', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Sign in required' });

  const dateIso = req.body?.date === 'today' ? todayIso() : req.body?.date;
  const { phoneNumber, paymentmethod } = req.body || {};
  if (!dateIso) return res.status(400).json({ error: 'date is required' });
  if (!phoneNumber || !paymentmethod) {
    return res.status(400).json({ error: 'phoneNumber and paymentmethod are required' });
  }

  const isToday = dateIso === todayIso();
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
        archiveDate: isToday ? undefined : dateIso
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
      status: data.status
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