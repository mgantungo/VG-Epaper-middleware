import { Router } from 'express';
import { getAccessProfile, accessSummary, todayIso } from '../services/access.js';
import { getStorefront } from '../services/strapiClient.js';
import { requireUser } from '../middleware/auth.js';

/**
 * apps/middleware/src/routes/account.js             REWRITTEN (Phase 0)
 *
 * GET /api/account/me
 *   {
 *     user,
 *     publications: { NV: { today, until, via, ranges }, BK: {...}, ... },
 *     subscriptionActive, subscriptionExpiresAt,   // kept: true if ANY publication is open today
 *     entitlementRanges,                            // kept: New Vision ranges, for older clients
 *     organisation: { id, name, role, status, publications } | null
 *   }
 * Access is per publication now (each paper is sold separately); the two
 * old summary fields are derived from it so older screens keep working.
 */

export const accountRouter = Router();

accountRouter.get('/me', requireUser, async (req, res) => {
  try {
    const today = todayIso();
    const [profile, store] = await Promise.all([getAccessProfile(req.userId), getStorefront().catch(() => ({ publications: [] }))]);
    const codes = new Set((store.publications || []).map(p => p.code));
    for (const e of profile?.personal || []) codes.add(e.publication);
    for (const c of profile?.org?.contracts || []) codes.add(c.publication);
    const publications = accessSummary(profile, [...codes].sort(), today);

    const openToday = Object.values(publications).filter(p => p.today);
    const org = profile?.org || null;

    res.json({
      user: req.userProfile,
      publications,
      subscriptionActive: openToday.length > 0,
      subscriptionExpiresAt: openToday.reduce((m, p) => (p.until > m ? p.until : m), '') || null,
      entitlementRanges: (publications.NV?.ranges || []).map(({ start, end }) => ({ start, end })),
      organisation: org
        ? {
            id: org.orgId,
            name: org.orgName,
            role: org.role,
            status: org.orgStatus,
            publications: org.seatPublications ?? [...new Set((org.contracts || []).map(c => c.publication))]
          }
        : null
    });
  } catch (err) {
    console.error('[account] me failed:', err.message);
    res.status(502).json({ error: 'Could not load your account' });
  }
});
