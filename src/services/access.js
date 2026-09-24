import { getPersonalEntitlement, getActiveOrgSeat, getOrgEntitlement } from './strapiClient.js';

/** ISO date string for "today" in server time. Swap for a specific timezone if your masthead's "today" should be fixed to e.g. Africa/Kampala regardless of server location. */
export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Replaces the old split rule ("today needs an active Subscription, archive
 * dates need a completed Purchase") with one unified check against
 * epaper-entitlement — there's no special-casing of "today" vs "archive"
 * at this layer anymore, because that distinction now lives entirely in
 * WHICH PLAN someone bought, not in this function:
 *   - a `daily` plan's entitlement has coverageStart === coverageEnd (the
 *     one day it was bought for), so it structurally can't cover any other
 *     date — "pay again for history papers" falls out automatically.
 *   - a `period_subscription` plan's entitlement spans its whole window,
 *     so it covers every edition published anywhere in that range, past or
 *     present, automatically.
 * See apps/cms/src/api/epaper-transaction/services/epaper-transaction.js's
 * computeCoverage() for where that mapping actually happens.
 *
 * A date is accessible if EITHER:
 *   - the user has a personal entitlement covering it, OR
 *   - the user is an active seat in an organization whose own entitlement
 *     covers it (master/child accounts — see epaper-organization/epaper-org-seat)
 */
export async function hasAccess({ userId, dateIso }) {
  if (!userId) return false;

  const personal = await getPersonalEntitlement(userId, dateIso);
  if (personal) return true;

  const seat = await getActiveOrgSeat(userId);
  if (seat?.organization?.id) {
    const orgEntitlement = await getOrgEntitlement(seat.organization.id, dateIso);
    if (orgEntitlement) return true;
  }

  return false;
}