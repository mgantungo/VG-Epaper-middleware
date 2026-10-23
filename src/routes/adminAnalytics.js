/**
 * File:      /var/www/VGEpaper/middleware/src/routes/adminAnalytics.js
 * Repo path: apps/middleware/src/routes/adminAnalytics.js
 * System:    apps/middleware (Express, port 4161)          NEW FILE (Phases 1–4)
 *
 * Reader analytics for handle.epapers admins with canManageOrganizations
 * (agreed 23 Oct 2026). Read-only; forwards to the CMS analytics API.
 *
 *   GET /api/admin/analytics/overview          ?from&to
 *   GET /api/admin/analytics/curve             ?editions=NV:2026-10-22,BK:2026-10-22
 *   GET /api/admin/analytics/sections          ?publication&from&to&section
 *   GET /api/admin/analytics/readers           ?from&to&publication&org&type&q&sort&page&pageSize
 *   GET /api/admin/analytics/readers/:userId   ?from&to
 *   GET /api/admin/analytics/revenue           ?from&to
 *   GET /api/admin/analytics/orgs/:orgId/usage ?month=YYYY-MM
 *   POST /api/admin/analytics/rebuild          { from, to }  recompute daily totals (after a fix or import)
 *
 * Dates are Kampala days, YYYY-MM-DD.
 * Mount in src/server.js:  app.use('/api/admin/analytics', adminAnalyticsRouter);
 * (before the generic /api/admin router)
 */
import express, { Router } from 'express';
import fetch from 'node-fetch';
import { config } from '../config.js';
import { requireHandleAdmin, requireHandleRight } from '../middleware/handleRights.js';

export const adminAnalyticsRouter = Router();
adminAnalyticsRouter.use(express.json({ limit: '10kb' }));
adminAnalyticsRouter.use(requireHandleAdmin, requireHandleRight('canManageOrganizations'));

adminAnalyticsRouter.param('userId', (req, res, next, v) => (/^\d+$/.test(v) ? next() : res.status(400).json({ error: 'Invalid reader' })));
adminAnalyticsRouter.param('orgId', (req, res, next, v) => (/^\d+$/.test(v) ? next() : res.status(400).json({ error: 'Invalid organisation' })));

const QUERY_KEYS = ['from', 'to', 'publication', 'editions', 'section', 'org', 'type', 'q', 'sort', 'page', 'pageSize', 'month'];

function forward(method, path) {
  return async (req, res) => {
    const p = typeof path === 'function' ? path(req) : path;
    const qs = new URLSearchParams();
    for (const k of QUERY_KEYS) if (req.query[k] !== undefined) qs.set(k, String(req.query[k]).slice(0, 200));
    const url = `${config.strapiUrl}/api/analytics/admin${p}${qs.toString() ? `?${qs}` : ''}`;
    try {
      const upstream = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${config.strapiApiToken}`,
          'content-type': 'application/json',
          'x-actor-admin-id': String(req.handleAdmin.sub)
        },
        body: method === 'GET' ? undefined : JSON.stringify(req.body || {})
      });
      const data = await upstream.json().catch(() => null);
      if (!data) {
        console.error(`[adminAnalytics] ${method} ${url}: CMS returned non-JSON (${upstream.status}). Is the analytics API deployed and Strapi restarted?`);
        return res.status(502).json({ error: 'Analytics service returned an unexpected response' });
      }
      res.status(upstream.status).json(data);
    } catch (err) {
      console.error('[adminAnalytics] could not reach the CMS:', err.message);
      res.status(502).json({ error: 'Could not reach CMS' });
    }
  };
}

adminAnalyticsRouter.get('/overview', forward('GET', '/overview'));
adminAnalyticsRouter.get('/curve', forward('GET', '/curve'));
adminAnalyticsRouter.get('/sections', forward('GET', '/sections'));
adminAnalyticsRouter.get('/readers', forward('GET', '/readers'));
adminAnalyticsRouter.get('/readers/:userId', forward('GET', (r) => `/readers/${r.params.userId}`));
adminAnalyticsRouter.get('/revenue', forward('GET', '/revenue'));
adminAnalyticsRouter.get('/orgs/:orgId/usage', forward('GET', (r) => `/orgs/${r.params.orgId}/usage`));
adminAnalyticsRouter.post('/rebuild', forward('POST', '/rebuild'));
