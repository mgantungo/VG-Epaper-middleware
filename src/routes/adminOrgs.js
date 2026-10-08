/**
 * File:      /var/www/VGEpaper/middleware/src/routes/adminOrgs.js
 * Repo path: apps/middleware/src/routes/adminOrgs.js
 * System:    apps/middleware (Express, port 4161)          NEW FILE (Phase 2)
 *
 * Organisation management for handle.epapers admins. Every route needs a
 * handle-admin session; everything except GET /rights also needs the
 * canManageOrganizations right (or isSuperAdmin), checked live against
 * Strapi on every request.
 *
 * Mount in src/server.js, next to the other /api/admin routers:
 *   import { adminOrgsRouter } from './routes/adminOrgs.js';
 *   app.use('/api/admin/organisations', adminOrgsRouter);
 *
 * Mounted on its own sub-path, so the ORG_FEATURE_ENABLED gate below can
 * never affect the existing /api/admin/editions or /api/admin/editor routes.
 *
 *   GET    /api/admin/organisations/rights                  current admin's rights (no special right needed)
 *   GET    /api/admin/organisations                         ?search&status&page&pageSize
 *   POST   /api/admin/organisations                         create (optionally with contract + first admin)
 *   GET    /api/admin/organisations/:id
 *   PATCH  /api/admin/organisations/:id                     name, seatLimit, contact*, notes
 *   POST   /api/admin/organisations/:id/status              { status: active|suspended|archived, reason }
 *   POST   /api/admin/organisations/:id/contracts           { coverageStart, coverageEnd, planKey?, amountPaid?, currency?, note? }
 *   PATCH  /api/admin/organisations/:id/contracts/:cid      { coverageStart?, coverageEnd?, note? }
 *   POST   /api/admin/organisations/:id/contracts/:cid/revoke  { reason }
 *   POST   /api/admin/organisations/:id/admins              { email, grantAccess? }
 *   DELETE /api/admin/organisations/:id/admins/:seatId      demote to member
 *   GET    /api/admin/organisations/:id/members             ?search&status&role&page&pageSize
 *   POST   /api/admin/organisations/:id/members/:seatId/status  { status: active|suspended, reason }
 *   GET    /api/admin/organisations/:id/audit               ?page&pageSize
 *
 * Env: ORG_FEATURE_ENABLED=true to switch these on (404 otherwise).
 */
import express, { Router } from 'express';
import fetch from 'node-fetch';
import { config } from '../config.js';
import { requireHandleAdmin, requireHandleRight, fetchHandleRights } from '../middleware/handleRights.js';
import { invalidateOrgAccessCache } from '../services/strapiClient.js';

export const adminOrgsRouter = Router();

adminOrgsRouter.use((req, res, next) => {
  if (process.env.ORG_FEATURE_ENABLED !== 'true') return res.status(404).json({ error: 'Not found' });
  next();
});
adminOrgsRouter.use(express.json({ limit: '100kb' })); // no-op if server.js already parsed the body

// Reject non-numeric ids before they reach Strapi.
for (const p of ['id', 'cid', 'seatId']) {
  adminOrgsRouter.param(p, (req, res, next, value) => {
    if (!/^\d+$/.test(value)) return res.status(400).json({ error: `Invalid ${p}` });
    next();
  });
}

const QUERY_KEYS = ['search', 'status', 'role', 'page', 'pageSize'];

function forward(method, strapiPath) {
  return async (req, res) => {
    const path = typeof strapiPath === 'function' ? strapiPath(req) : strapiPath;
    const qs = new URLSearchParams();
    for (const k of QUERY_KEYS) if (req.query[k] !== undefined) qs.set(k, String(req.query[k]));
    const url = `${config.strapiUrl}/api/org-management${path}${qs.toString() ? `?${qs}` : ''}`;

    try {
      const upstream = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${config.strapiApiToken}`,
          'content-type': 'application/json',
          'x-actor-admin-id': String(req.handleAdmin.sub)
        },
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(req.body || {})
      });
      const data = await upstream.json().catch(() => null);
      if (!data) {
        console.error(`[adminOrgs] ${method} ${url}: Strapi returned non-JSON (${upstream.status}). Is the org-management API deployed and Strapi restarted?`);
        return res.status(502).json({ error: 'Organisation service returned an unexpected response' });
      }
      if (method !== 'GET' && upstream.ok) invalidateOrgAccessCache();
      res.status(upstream.status).json(data);
    } catch (err) {
      console.error('[adminOrgs] could not reach Strapi:', err.message);
      res.status(502).json({ error: 'Could not reach CMS' });
    }
  };
}

// No special right needed: the handle app calls this to decide whether to
// show the Organisations menu at all.
adminOrgsRouter.get('/rights', requireHandleAdmin, async (req, res) => {
  try {
    const rights = await fetchHandleRights(req.handleAdmin.sub);
    if (!rights || !rights.active) return res.status(401).json({ error: 'Admin account is inactive' });
    res.json({ rights });
  } catch (err) {
    console.error('[adminOrgs] rights lookup failed:', err.message);
    res.status(502).json({ error: 'Could not verify permissions' });
  }
});

const guard = [requireHandleAdmin, requireHandleRight('canManageOrganizations')];

adminOrgsRouter.get('/', guard, forward('GET', '/orgs'));
adminOrgsRouter.post('/', guard, forward('POST', '/orgs'));
adminOrgsRouter.get('/:id', guard, forward('GET', r => `/orgs/${r.params.id}`));
adminOrgsRouter.patch('/:id', guard, forward('PATCH', r => `/orgs/${r.params.id}`));
adminOrgsRouter.post('/:id/status', guard, forward('POST', r => `/orgs/${r.params.id}/status`));

adminOrgsRouter.post('/:id/contracts', guard, forward('POST', r => `/orgs/${r.params.id}/contracts`));
adminOrgsRouter.patch('/:id/contracts/:cid', guard, forward('PATCH', r => `/orgs/${r.params.id}/contracts/${r.params.cid}`));
adminOrgsRouter.post('/:id/contracts/:cid/revoke', guard, forward('POST', r => `/orgs/${r.params.id}/contracts/${r.params.cid}/revoke`));

adminOrgsRouter.post('/:id/admins', guard, forward('POST', r => `/orgs/${r.params.id}/admins`));
adminOrgsRouter.delete('/:id/admins/:seatId', guard, forward('DELETE', r => `/orgs/${r.params.id}/admins/${r.params.seatId}`));

adminOrgsRouter.get('/:id/members', guard, forward('GET', r => `/orgs/${r.params.id}/members`));
adminOrgsRouter.post('/:id/members/:seatId/status', guard, forward('POST', r => `/orgs/${r.params.id}/members/${r.params.seatId}/status`));

adminOrgsRouter.get('/:id/audit', guard, forward('GET', r => `/orgs/${r.params.id}/audit`));