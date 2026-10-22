/**
 * File:      /var/www/VGEpaper/middleware/src/routes/adminCatalogue.js
 * Repo path: apps/middleware/src/routes/adminCatalogue.js
 * System:    apps/middleware (Express, port 4161)          NEW FILE (Phase 0)
 *
 * Publications, plans and prices for handle.epapers admins. Forwards to the
 * CMS catalogue API (/api/catalogue/admin/*). Every route needs a handle
 * admin session; every change needs the canManageOrganizations right
 * (agreed 23 Oct 2026), checked live against the CMS on each request.
 * Listing publications needs only a session, because the edition upload
 * form (canManageEditions) picks from it.
 *
 *   GET    /api/admin/catalogue/publications
 *   POST   /api/admin/catalogue/publications              { code, title, name, editionLabel?, language?, frequency, coverDays?, scheduleNote?, colour?, description?, sortOrder? }
 *   PATCH  /api/admin/catalogue/publications/:id          same fields except code
 *   GET    /api/admin/catalogue/plans                     every plan with its versions
 *   POST   /api/admin/catalogue/plans                     { key, label, kind, durationUnit?, durationCount?, price, publications: [codes], revenueSplit?, featured?, sortOrder?, validFrom? }
 *   POST   /api/admin/catalogue/plans/split-suggestion    { publications: [codes] } -> { revenueSplit }
 *   PATCH  /api/admin/catalogue/plans/:key                { label?, description?, featured?, sortOrder? } (all versions)
 *   POST   /api/admin/catalogue/plans/:key/versions       { price?, revenueSplit?, validFrom? } new price from a date
 *   POST   /api/admin/catalogue/plans/:key/stop
 *   POST   /api/admin/catalogue/plans/:key/resume
 *
 * Mount in src/server.js:  app.use('/api/admin/catalogue', adminCatalogueRouter);
 * (before the generic /api/admin router)
 */
import express, { Router } from 'express';
import fetch from 'node-fetch';
import { config } from '../config.js';
import { requireHandleAdmin, requireHandleRight } from '../middleware/handleRights.js';
import { invalidateStorefront, invalidateEditionCache } from '../services/strapiClient.js';

export const adminCatalogueRouter = Router();
adminCatalogueRouter.use(express.json({ limit: '100kb' }));

adminCatalogueRouter.param('id', (req, res, next, v) => (/^\d+$/.test(v) ? next() : res.status(400).json({ error: 'Invalid id' })));
adminCatalogueRouter.param('key', (req, res, next, v) => (/^[a-z0-9][a-z0-9_]{1,39}$/.test(v) ? next() : res.status(400).json({ error: 'Invalid plan key' })));

function forward(method, path) {
  return async (req, res) => {
    const p = typeof path === 'function' ? path(req) : path;
    const url = `${config.strapiUrl}/api/catalogue/admin${p}`;
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
        console.error(`[adminCatalogue] ${method} ${url}: CMS returned non-JSON (${upstream.status}). Is the catalogue API deployed and Strapi restarted?`);
        return res.status(502).json({ error: 'Catalogue service returned an unexpected response' });
      }
      if (method !== 'GET' && upstream.ok) {
        invalidateStorefront();
        // A publication's coverDays change re-dates its editions' cover days.
        if (p.startsWith('/publications')) invalidateEditionCache();
      }
      res.status(upstream.status).json(data);
    } catch (err) {
      console.error('[adminCatalogue] could not reach the CMS:', err.message);
      res.status(502).json({ error: 'Could not reach CMS' });
    }
  };
}

const manage = [requireHandleAdmin, requireHandleRight('canManageOrganizations')];

adminCatalogueRouter.get('/publications', requireHandleAdmin, forward('GET', '/publications'));
adminCatalogueRouter.post('/publications', manage, forward('POST', '/publications'));
adminCatalogueRouter.patch('/publications/:id', manage, forward('PATCH', r => `/publications/${r.params.id}`));

adminCatalogueRouter.get('/plans', manage, forward('GET', '/plans'));
adminCatalogueRouter.post('/plans', manage, forward('POST', '/plans'));
adminCatalogueRouter.post('/plans/split-suggestion', manage, forward('POST', '/plans/split-suggestion'));
adminCatalogueRouter.patch('/plans/:key', manage, forward('PATCH', r => `/plans/${r.params.key}`));
adminCatalogueRouter.post('/plans/:key/versions', manage, forward('POST', r => `/plans/${r.params.key}/versions`));
adminCatalogueRouter.post('/plans/:key/stop', manage, forward('POST', r => `/plans/${r.params.key}/stop`));
adminCatalogueRouter.post('/plans/:key/resume', manage, forward('POST', r => `/plans/${r.params.key}/resume`));
