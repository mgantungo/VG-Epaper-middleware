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
 * Creates a pending Purchase (or, for "today", just returns subscription
 * pricing — you may not need a pending record for a recurring subscription
 * depending on how your gateway models it) and returns whatever your gateway
 * needs the frontend to redirect to / open.
 *
 * This is the seam where your real gateway's SDK/API call goes. Replace the
 * `checkoutUrl` placeholder below with the real "create a checkout session"
 * call, and pass its result straight through to the frontend.
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
      provider: 'your-gateway', providerReference: null, status: 'pending'
    });
    purchaseId = purchase.data.documentId; // Strapi 5: mutate/reference documents by documentId, not id
  }

  // TODO: replace with your real gateway's "create checkout session" call.
  // Pass purchaseId (or a subscription-intent id) through as metadata so the
  // webhook below can find the right record when the gateway calls back.
  res.json({
    checkoutUrl: `https://your-gateway.example.com/checkout?ref=${purchaseId || 'subscription'}&amount=${amount}&currency=${currency}`,
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
