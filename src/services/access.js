import { getActiveSubscription, getCompletedPurchase } from './strapiClient.js';

/** ISO date string for "today" in server time. Swap for a specific timezone if your masthead's "today" should be fixed to e.g. Africa/Kampala regardless of server location. */
export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The rule from the spec, in one place:
 *   - today's edition: requires an ACTIVE SUBSCRIPTION. Nothing else grants it.
 *   - any archive date (anything not today): requires a completed PURCHASE for
 *     that specific date. An active subscription does NOT unlock archive dates.
 */
export async function hasAccess({ userId, dateIso }) {
  if (!userId) return false;
  if (dateIso === todayIso()) {
    const sub = await getActiveSubscription(userId);
    return Boolean(sub);
  }
  const purchase = await getCompletedPurchase(userId, dateIso);
  return Boolean(purchase);
}
