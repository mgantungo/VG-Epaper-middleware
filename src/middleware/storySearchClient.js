import fetch from 'node-fetch';
import { config } from '../config.js';

/**
 * apps/middleware/src/services/storySearchClient.js          NEW FILE
 *
 * Calls the CMS full-text story search (POST /api/stories/search, see
 * apps/cms/src/api/story/{services,controllers,routes}/story-search.js),
 * authenticated with STRAPI_API_TOKEN like every other Strapi call here.
 *
 * Same convention as epaperUserClient.js: never throws. A network failure,
 * timeout or non-JSON reply comes back as { ok: false, status, data: { error } },
 * so callers only ever need `if (!result.ok)`.
 */

const SEARCH_TIMEOUT_MS = 15_000;

export async function searchStories({ query, startDate, endDate, page, pageSize }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.strapiUrl}/api/stories/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.strapiApiToken}`,
        'content-type': 'application/json'
      },
      // undefined fields are dropped by JSON.stringify, so optional params stay optional
      body: JSON.stringify({ query, startDate, endDate, page, pageSize }),
      signal: controller.signal
    });

    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      console.error(`[storySearchClient] Strapi returned non-JSON (status ${res.status}) — is /api/stories/search registered and Strapi restarted?`, parseErr.message);
      return { ok: false, status: res.status, data: { error: 'Search service returned an unexpected response' } };
    }
    if (!res.ok) {
      console.warn(`[storySearchClient] Strapi responded ${res.status} —`, data?.error?.message || data?.error || data);
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    console.error(`[storySearchClient] ${timedOut ? 'timed out' : 'could not reach Strapi'} at ${config.strapiUrl} —`, err.message);
    return { ok: false, status: 0, data: { error: timedOut ? 'Search timed out' : 'Could not reach search service' } };
  } finally {
    clearTimeout(timer);
  }
}