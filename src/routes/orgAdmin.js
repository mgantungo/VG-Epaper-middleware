/**
 * File:      /var/www/VGEpaper/middleware/src/routes/orgAdmin.js
 * Repo path: apps/middleware/src/routes/orgAdmin.js
 * System:    apps/middleware (Express, port 4161)          NEW FILE (Phase 3)
 *
 * The Organisation Admin dashboard API, used by the reader web app's
 * /organisation pages. Callers are ordinary signed-in readers (the same
 * access token as everything else under /api); whether they're actually an
 * admin of an active organisation is decided in the CMS on EVERY request,
 * from their own seat. Nothing here takes an organisation id from the client.
 *
 *   GET  /api/org-admin/summary
 *   GET  /api/org-admin/members                    ?search&status&role&page&pageSize
 *   POST /api/org-admin/members                    { email, displayName?, phone?, coverageStart?, coverageEnd?, months? }
 *   POST /api/org-admin/members/:seatId/access     { coverageStart?, coverageEnd?, months? }  create or extend
 *   POST /api/org-admin/members/:seatId/status     { status: active|suspended, reason? }
 *   POST /api/org-admin/members/:seatId/role       { role: member|admin }
 *   POST /api/org-admin/members/:seatId/remove     { reason? }
 *   POST /api/org-admin/members/:seatId/resend-invite
 *   POST /api/org-admin/members/:seatId/publications { publications: ['NV','BK'] }  (Phase 0)
 *   GET  /api/org-admin/import/template            .xlsx: the members spreadsheet (current members
 *                                                  pre-filled; guided empty sheet if none yet)
 *   POST /api/org-admin/import/preview             multipart: file (.xlsx/.csv), defaults (JSON string, optional)
 *   POST /api/org-admin/import/:importId/commit
 *   GET  /api/org-admin/audit                      ?page&pageSize
 *   GET  /api/org-admin/usage                      ?month=YYYY-MM  days and publications per member
 *
 * Mount in src/server.js:  app.use('/api/org-admin', orgAdminRouter);
 * Env: ORG_FEATURE_ENABLED=true (404 otherwise). Needs: npm i exceljs
 */
import { Router } from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import { config } from '../config.js';
import { requireUser } from '../middleware/auth.js';
import { invalidateOrgAccessCache } from '../services/strapiClient.js';
import { parseMemberSheet, buildTemplate, templateFilename, SheetError } from '../services/memberSheet.js';

export const orgAdminRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

orgAdminRouter.use((req, res, next) => {
  if (process.env.ORG_FEATURE_ENABLED !== 'true') return res.status(404).json({ error: 'Not found' });
  next();
});
orgAdminRouter.use(requireUser);

orgAdminRouter.param('seatId', (req, res, next, v) => (/^\d+$/.test(v) ? next() : res.status(400).json({ error: 'Invalid member' })));
orgAdminRouter.param('importId', (req, res, next, v) => (/^\d+$/.test(v) ? next() : res.status(400).json({ error: 'Invalid import' })));

const QUERY_KEYS = ['search', 'status', 'role', 'page', 'pageSize'];

async function callStrapi(req, method, path, body) {
  const qs = new URLSearchParams();
  if (method === 'GET') for (const k of QUERY_KEYS) if (req.query[k] !== undefined) qs.set(k, String(req.query[k]));
  const url = `${config.strapiUrl}/api/org-management/portal${path}${qs.toString() ? `?${qs}` : ''}`;
  const upstream = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.strapiApiToken}`,
      'content-type': 'application/json',
      'x-actor-user-id': String(req.userId)
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? req.body ?? {})
  });
  const data = await upstream.json().catch(() => null);
  return { status: upstream.status, ok: upstream.ok, data };
}

function forward(method, path) {
  return async (req, res) => {
    try {
      const p = typeof path === 'function' ? path(req) : path;
      const r = await callStrapi(req, method, p);
      if (!r.data) {
        console.error(`[orgAdmin] ${method} ${p}: Strapi returned non-JSON (${r.status}). Is the org-management API deployed?`);
        return res.status(502).json({ error: 'Organisation service returned an unexpected response' });
      }
      if (method !== 'GET' && r.ok) invalidateOrgAccessCache();
      res.status(r.status).json(r.data);
    } catch (err) {
      console.error('[orgAdmin] could not reach Strapi:', err.message);
      res.status(502).json({ error: 'Could not reach the organisation service' });
    }
  };
}

orgAdminRouter.get('/summary', forward('GET', '/summary'));
orgAdminRouter.get('/members', forward('GET', '/members'));
orgAdminRouter.post('/members', forward('POST', '/members'));
orgAdminRouter.post('/members/:seatId/access', forward('POST', (r) => `/members/${r.params.seatId}/access`));
orgAdminRouter.post('/members/:seatId/status', forward('POST', (r) => `/members/${r.params.seatId}/status`));
orgAdminRouter.post('/members/:seatId/role', forward('POST', (r) => `/members/${r.params.seatId}/role`));
orgAdminRouter.post('/members/:seatId/remove', forward('POST', (r) => `/members/${r.params.seatId}/remove`));
orgAdminRouter.post('/members/:seatId/resend-invite', forward('POST', (r) => `/members/${r.params.seatId}/resend-invite`));
orgAdminRouter.post('/members/:seatId/publications', forward('POST', (r) => `/members/${r.params.seatId}/publications`));
orgAdminRouter.get('/audit', forward('GET', '/audit'));

/**
 * GET /api/org-admin/usage?month=YYYY-MM  (Phases 1–4)
 * Which days each member was active and which publications they opened —
 * never pages, sections or stories (agreed 23 Oct 2026).
 */
orgAdminRouter.get('/usage', async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? `?month=${req.query.month}` : '';
  try {
    const upstream = await fetch(`${config.strapiUrl}/api/analytics/portal/usage${month}`, {
      headers: { Authorization: `Bearer ${config.strapiApiToken}`, 'x-actor-user-id': String(req.userId) }
    });
    const data = await upstream.json().catch(() => null);
    if (!data) return res.status(502).json({ error: 'Usage service returned an unexpected response' });
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[orgAdmin] usage: could not reach Strapi:', err.message);
    res.status(502).json({ error: 'Could not reach the usage service' });
  }
});

orgAdminRouter.get('/import/template', async (req, res) => {
  try {
    const r = await callStrapi(req, 'GET', '/members/export');
    if (!r.ok) return res.status(r.status || 502).json(r.data || { error: 'Could not load your members' });
    const buf = await buildTemplate(r.data);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${templateFilename(r.data?.organisation?.name)}"`);
    res.send(buf);
  } catch (err) {
    console.error('[orgAdmin] members spreadsheet failed:', err.message);
    res.status(500).json({ error: 'Could not build the spreadsheet' });
  }
});

orgAdminRouter.post('/import/preview', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 2 MB' : 'Upload failed';
    res.status(400).json({ error: msg });
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a .xlsx or .csv file to upload' });

  let defaults = {};
  if (req.body?.defaults) {
    try { defaults = JSON.parse(req.body.defaults); } catch { return res.status(400).json({ error: 'Invalid default period' }); }
  }

  let rows;
  try {
    rows = await parseMemberSheet(req.file.buffer, req.file.originalname || '');
  } catch (err) {
    if (err instanceof SheetError) return res.status(400).json({ error: err.message });
    console.error('[orgAdmin] sheet parse failed:', err);
    return res.status(400).json({ error: 'The file could not be read' });
  }

  try {
    const r = await callStrapi(req, 'POST', '/imports', { filename: req.file.originalname, rows, defaults });
    if (!r.data) return res.status(502).json({ error: 'Organisation service returned an unexpected response' });
    res.status(r.status).json(r.data);
  } catch (err) {
    console.error('[orgAdmin] import preview: could not reach Strapi:', err.message);
    res.status(502).json({ error: 'Could not reach the organisation service' });
  }
});

orgAdminRouter.post('/import/:importId/commit', forward('POST', (r) => `/imports/${r.params.importId}/commit`));
