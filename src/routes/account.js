import { Router } from 'express';
import { getPersonalEntitlement, getActiveOrgSeat, getOrgEntitlement, getEntitlementRanges } from '../services/strapiClient.js';
import { todayIso } from '../services/access.js';
import { requireUser } from '../middleware/auth.js';

export const accountRouter = Router();

accountRouter.get('/me', requireUser, async (req, res) => {
  const today = todayIso();

  // "Does today's paper unlock for this reader right now" — same rough
  // meaning subscriptionActive always had, just resolved through the
  // unified entitlement check instead of a dedicated Subscription record.
  let todaysEntitlement = await getPersonalEntitlement(req.userId, today);
  if (!todaysEntitlement) {
    const seat = await getActiveOrgSeat(req.userId);
    if (seat?.organization?.id) {
      todaysEntitlement = await getOrgEntitlement(seat.organization.id, today);
    }
  }

  const entitlementRanges = await getEntitlementRanges(req.userId);

  res.json({
    user: req.userProfile,
    subscriptionActive: Boolean(todaysEntitlement),
    subscriptionExpiresAt: todaysEntitlement?.coverageEnd || null,
    // Replaces the old flat purchasedDates array — see
    // getEntitlementRanges()'s own comment for why a flat date list no
    // longer works now that one entitlement can span a whole period.
    entitlementRanges
  });
});