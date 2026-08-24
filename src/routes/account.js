import { Router } from 'express';
import { getActiveSubscription, getPurchasedDates } from '../services/strapiClient.js';
import { requireUser } from '../middleware/auth.js';

export const accountRouter = Router();

accountRouter.get('/me', requireUser, async (req, res) => {
  const [subscription, purchasedDates] = await Promise.all([
    getActiveSubscription(req.userId),
    getPurchasedDates(req.userId)
  ]);
  res.json({
    subscriptionActive: Boolean(subscription),
    subscriptionExpiresAt: subscription?.currentPeriodEnd || null,
    purchasedDates
  });
});
