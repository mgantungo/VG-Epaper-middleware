import { Router } from 'express';
import { getPersonalEntitlement, getOrgAccess, orgAccessCovers, orgAccessRanges, getEntitlementRanges } from '../services/strapiClient.js';
import { todayIso } from '../services/access.js';
import { requireUser } from '../middleware/auth.js';

/**
 * apps/middleware/src/routes/account.js                  MODIFIED (Phase 2)
 *
 * Change: today's org access goes through the same rule as hasAccess(), and
 * the response gains an additive `organisation` field ({ id, name, role,
 * status } or null), which the web app will use in Phase 5 to show the
 * Organisation dashboard link to Org Admins. Existing fields are unchanged.
 */

export const accountRouter = Router();

accountRouter.get('/me', requireUser, async (req, res) => {
  const today = todayIso();

  // "Does today's paper unlock for this reader right now" — same rough
  // meaning subscriptionActive always had, just resolved through the
  // unified entitlement check instead of a dedicated Subscription record.
  const personal = await getPersonalEntitlement(req.userId, today);
  const orgAccess = await getOrgAccess(req.userId);

  let subscriptionActive = Boolean(personal);
  let subscriptionExpiresAt = personal?.coverageEnd || null;

  if (!personal && orgAccessCovers(orgAccess, today)) {
    subscriptionActive = true;
    const covering = orgAccessRanges(orgAccess).filter(r => r.start <= today && today <= r.end);
    subscriptionExpiresAt = covering.reduce((m, r) => (r.end > m ? r.end : m), '') || null;
  }

  const entitlementRanges = await getEntitlementRanges(req.userId);

  res.json({
    user: req.userProfile,
    subscriptionActive,
    subscriptionExpiresAt,
    // Replaces the old flat purchasedDates array — see
    // getEntitlementRanges()'s own comment for why a flat date list no
    // longer works now that one entitlement can span a whole period.
    entitlementRanges,
    organisation: orgAccess
      ? { id: orgAccess.orgId, name: orgAccess.orgName, role: orgAccess.role, status: orgAccess.orgStatus }
      : null
  });
});