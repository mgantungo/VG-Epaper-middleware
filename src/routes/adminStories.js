/**
 * File:      /var/www/VGEpaper/apps/middleware/src/routes/adminStories.js
 * Repo path: apps/middleware/src/routes/adminStories.js
 * System:    apps/middleware (Express, port 4161, https://epapersapi.visiongroup.co.ug)   NEW FILE
 *
 * Handle-admin story editor endpoints. Verifies the handle admin JWT (same
 * check as routes/admin.js), then forwards to apps/ingest's /editor routes
 * on localhost with the shared INGEST_WEBHOOK_SECRET in the x-ingest-secret
 * header (same header the CMS webhook uses).
 *
 *   GET   /api/admin/editor/editions/:editionId/pages/:pageNumber
 *   POST  /api/admin/editor/editions/:editionId/pages/:pageNumber/compile
 *   POST  /api/admin/editor/editions/:editionId/pages/:pageNumber/stories
 *   PATCH /api/admin/editor/editions/:editionId/pages/:pageNumber/stories/:storyId
 *
 * Mounted in src/server.js with:  app.use('/api/admin', adminStoriesRouter);
 * Env: INGEST_URL (default http://localhost:4158), INGEST_WEBHOOK_SECRET (same value as apps/ingest)
 */
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const adminStoriesRouter = Router();
// server.js already applies express.json() to every /api/admin request.

function requireHandleAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, config.handleAdminJwtSecret);
    if (payload.type !== 'handle-admin') throw new Error('wrong token type');
    req.handleAdmin = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired or invalid' });
  }
}

function forward(method) {
  return async (req, res) => {
    const ingestUrl = process.env.INGEST_URL || 'http://localhost:4158';
    const secret = process.env.INGEST_WEBHOOK_SECRET;
    if (!secret) return res.status(500).json({ error: 'INGEST_WEBHOOK_SECRET is not configured on middleware' });
    try {
      const upstream = await fetch(`${ingestUrl}${req.originalUrl.replace(/^\/api\/admin/, '')}`, {
        method,
        headers: { 'x-ingest-secret': secret, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(req.body || {})
      });
      const text = await upstream.text();
      res.status(upstream.status).type('application/json').send(text || '{}');
    } catch (err) {
      console.error('[adminStories] ingest unreachable:', err.message);
      res.status(502).json({ error: 'Story editor service is unreachable' });
    }
  };
}

const base = '/editor/editions/:editionId/pages/:pageNumber';
adminStoriesRouter.get(base, requireHandleAdmin, forward('GET'));
adminStoriesRouter.post(`${base}/compile`, requireHandleAdmin, forward('POST'));
adminStoriesRouter.post(`${base}/stories`, requireHandleAdmin, forward('POST'));
adminStoriesRouter.patch(`${base}/stories/:storyId`, requireHandleAdmin, forward('PATCH'));