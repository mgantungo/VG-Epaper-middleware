import { Router } from 'express';
import fetch from 'node-fetch';
import { config } from '../config.js';
import { getActiveSubscription, getPurchasedDates } from '../services/strapiClient.js';
import { requireUser } from '../middleware/auth.js';

export const accountRouter = Router();

/** Forwards the reader's own token to Strapi's built-in /api/users/me — this
 * authenticates as THEM, so no service-level STRAPI_API_TOKEN is involved,
 * and it's the source of truth for username/email rather than duplicating
 * that data into the JWT payload itself. */
async function fetchUserProfile(userToken) {
  try {
    const res = await fetch(`${config.strapiUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return { id: user.id, username: user.username, email: user.email };
  } catch {
    return null;
  }
}

accountRouter.get('/me', requireUser, async (req, res) => {
  const [subscription, purchasedDates, user] = await Promise.all([
    getActiveSubscription(req.userId),
    getPurchasedDates(req.userId),
    fetchUserProfile(req.userToken)
  ]);
  res.json({
    user,
    subscriptionActive: Boolean(subscription),
    subscriptionExpiresAt: subscription?.currentPeriodEnd || null,
    purchasedDates
  });
});