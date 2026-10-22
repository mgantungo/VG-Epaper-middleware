import { Router } from 'express';
import fetch from 'node-fetch';
import { config } from '../config.js';
import { todayIso, invalidateAccess } from '../services/access.js';
import { getCurrentPlans } from '../services/strapiClient.js';

export const paymentsRouter = Router();

/**
 * MODIFIED (Phase 0: publications, plans and paper-aware access)
 *
 * GET /api/pay/plans?publication=BK
 * The standard plans on sale today, from the CMS catalogue (prices are set
 * in handle, never in code or env). With ?publication= only the plans that
 * include that publication: what the paywall offers for the paper being read.
 *   { plans: [{ key, version, label, kind: period|single_issue,
 *               durationUnit, durationCount, price, currency,
 *               publications: ['BK', 'BKW'], featured }], today }
 */
paymentsRouter.get('/plans', async (req, res) => {
  try {
    const out = await getCurrentPlans(req.query.publication);
    res.json({
      today: out.today,
      plans: (out.plans || []).map(p => ({
        key: p.key,
        version: p.version,
        label: p.label,
        description: p.description,
        kind: p.kind,
        durationUnit: p.durationUnit,
        durationCount: p.durationCount,
        price: p.price,
        currency: p.currency,
        publications: p.publications,
        featured: p.featured
      }))
    });
  } catch (err) {
    console.error('[payments] plans: could not load from the CMS:', err.message);
    res.status(502).json({ error: 'Could not load plans' });
  }
});

/**
 * POST /api/pay/checkout
 * Body: { planKey, phoneNumber, paymentmethod,
 *         date?: "YYYY-MM-DD" | "today",   single-issue plans: the edition
 *         dates?: ["YYYY-MM-DD", ...] }     single-issue plans: several back issues
 *
 * Individuals only, at the standard price on sale today. The CMS works out
 * the amount from the plan version and, for single-issue plans, finds the
 * plan's publication's editions on those dates — the client never sends a
 * price or an edition id. Organisations are not sold online; their
 * contracts are priced by hand in handle.
 *
 * The integrator sends a payment PIN prompt to the customer's phone; there
 * is no hosted checkout page to redirect to.
 */
paymentsRouter.post('/checkout', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Sign in required' });

  const { phoneNumber, paymentmethod, planKey } = req.body || {};
  if (!phoneNumber || !paymentmethod || !planKey) {
    return res.status(400).json({ error: 'planKey, phoneNumber and paymentmethod are required' });
  }

  const raw = Array.isArray(req.body?.dates) ? req.body.dates : (req.body?.date ? [req.body.date] : []);
  const editionDates = raw.map(d => (d === 'today' ? todayIso() : String(d))).filter(Boolean);

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
        editionDates
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
      planLabel: data.planLabel,
      publicationCodes: data.publicationCodes,
      editionsCount: data.editionsCount
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
    // Access granted: drop this reader's cached access so the paper opens on their very next request.
    if (data?.access_ready && req.userId) invalidateAccess(req.userId);
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