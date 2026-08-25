import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { todayIso } from '../services/access.js';
import {
  createPurchase, markPurchaseCompleted, upsertActiveSubscription, getEditionDocumentIdByDate
} from '../services/strapiClient.js';

export const paymentsRouter = Router();

/**
 * POST /api/pay/checkout
 * Body: { date: "YYYY-MM-DD" | "today" }
 *
 * ⚠️ TEMPORARY "ASSUME YES" MODE — no real payment gateway is wired in yet.
 * This grants access IMMEDIATELY, server-side, as if payment had already
 * succeeded — no money moves, no gateway is contacted, no webhook fires.
 * It exists so the rest of the app (paywall -> checkout -> unlock -> read)
 * can be tested and demoed end-to-end before a real gateway is chosen.
 *
 * TO WIRE IN A REAL GATEWAY LATER: delete the "grant immediately" block
 * below and replace it with a real "create checkout session" call, same as
 * the comment further down in /webhook describes. Nothing else in this
 * app — not the frontend, not /pay/return, not the paywall — needs to
 * change; they were built expecting checkoutUrl to point at your gateway
 * and /webhook to confirm completion, this is just a stand-in for both of
 * those in one place until that's ready.
 */
paymentsRouter.post('/checkout', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
  const dateIso = req.body?.date === 'today' ? todayIso() : req.body?.date;
  if (!dateIso) return res.status(400).json({ error: 'date is required' });

  const isToday = dateIso === todayIso();
  const amount = isToday ? config.pricing.subscription : config.pricing.archiveEdition;
  const currency = isToday ? config.pricing.subscriptionCurrency : 'UGX';

  let purchaseId = null; // this will hold the Purchase document's `documentId`, not a numeric id
  if (!isToday) {
    const editionDocumentId = await getEditionDocumentIdByDate(dateIso);
    if (!editionDocumentId) return res.status(404).json({ error: 'No edition for that date' });
    const purchase = await createPurchase({
      userId: req.userId, editionDocumentId, amount, currency,
      provider: 'assume-yes', providerReference: null, status: 'pending'
    });
    purchaseId = purchase.data.documentId; // Strapi 5: mutate/reference documents by documentId, not id
  }

  // --- grant immediately, as if a gateway had just confirmed payment ---
  if (isToday) {
    const periodEnd = new Date();
    periodEnd.setDate(periodEnd.getDate() + 30); // matches the "/ month" pricing shown in the UI
    await upsertActiveSubscription({
      userId: req.userId,
      provider: 'assume-yes',
      providerSubscriptionId: null,
      currentPeriodEnd: periodEnd.toISOString()
    });
  } else {
    await markPurchaseCompleted(purchaseId);
  }
  // --- end of the part to delete once a real gateway is wired in ---

  // checkoutUrl points back at this app's own return page instead of an
  // external gateway, since there's nothing external to redirect to yet.
  // The frontend (PaywallModal.vue) appends `&returnTo=...` to whatever URL
  // comes back here — that's meant for a real gateway to know where to send
  // the reader after ITS hosted checkout page, so it's harmless-but-unused
  // in this stand-in mode. The `?date=` here is what actually matters: it's
  // what /pay/return reads to know which edition to poll for, and it polls
  // successfully almost immediately since access was already granted above.
  res.json({
    checkoutUrl: `${config.webOrigin}/pay/return?date=${dateIso}`,
    purchaseId,
    amount,
    currency,
    kind: isToday ? 'subscription' : 'archive_purchase'
  });
});

/**
 * POST /api/pay/webhook
 * Your gateway calls this when a payment completes. Signature verification
 * below is a PLACEHOLDER SCHEME (HMAC-SHA256 over the raw body with a shared
 * secret) — swap it for your actual gateway's documented verification method
 * (most differ in header name and exact signing string). Never trust this
 * endpoint's payload without verifying it; anyone can POST to a public URL.
 *
 * Must be mounted with a raw body parser (see server.js) so the signature can
 * be computed over the exact bytes the gateway signed.
 */
paymentsRouter.post('/webhook', async (req, res) => {
  const signature = req.headers['x-webhook-signature']; // placeholder header name — check your gateway's docs
  const expected = crypto
    .createHmac('sha256', config.paymentWebhookSecret || '')
    .update(req.body) // raw Buffer, from express.raw()
    .digest('hex');

  if (!signature || !timingSafeEqual(signature, expected)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  const event = JSON.parse(req.body.toString('utf8'));
  // TODO: map this to your gateway's actual event shape. This assumes
  // something like { type: 'payment.completed', reference, kind, userId, subscription: {...} }.
  if (event.type !== 'payment.completed') {
    return res.status(200).json({ ignored: true });
  }

  if (event.kind === 'archive_purchase' && event.purchaseId) {
    await markPurchaseCompleted(event.purchaseId);
  } else if (event.kind === 'subscription' && event.userId) {
    await upsertActiveSubscription({
      userId: event.userId,
      provider: event.provider || 'your-gateway',
      providerSubscriptionId: event.providerSubscriptionId,
      currentPeriodEnd: event.currentPeriodEnd // your gateway should tell you this
    });
  }

  res.status(200).json({ received: true });
});

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}