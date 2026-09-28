import { Router } from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import { config } from '../config.js';

/**
 * apps/middleware/src/routes/admin.js
 *
 * Exists for one reason: the handle.epapers admin app's server-side code
 * needs to reach Strapi, but it can't assume it's running on the same
 * machine as Strapi the way this middleware is — `localhost:1397` only
 * resolves to Strapi from THIS server. Middleware already sits in front
 * of Strapi for exactly this kind of reachability reason (see
 * apps/web's whole read path) — this file extends that same role to
 * cover the handle app's needs (auth proxying, edition creation/listing/
 * detail) instead of duplicating a second direct-to-Strapi path.
 *
 * Self-contained deliberately — doesn't touch the existing reader-facing
 * auth middleware/token verification anywhere in this file, to avoid any
 * risk to what's already working. HANDLE_ADMIN_JWT_SECRET is a NEW env
 * var this file needs, separate from the reader-facing JWT_ACCESS_SECRET
 * — must match apps/cms's own HANDLE_ADMIN_JWT_SECRET exactly, since
 * that's what actually signs the token being verified here.
 */

export const adminRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });

function requireHandleAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
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

function strapiHeaders(extra = {}) {
  return { Authorization: `Bearer ${config.strapiApiToken}`, ...extra };
}

// ---- auth (public — these ARE the login entry points) ----------------

adminRouter.post('/auth/login', async (req, res) => {
  try {
    const strapiRes = await fetch(`${config.strapiUrl}/api/handle-admins/login`, {
      method: 'POST',
      headers: strapiHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ email: req.body?.email, password: req.body?.password })
    });
    const data = await strapiRes.json();
    res.status(strapiRes.status).json(data);
  } catch (err) {
    console.error('[admin] login proxy failed:', err.message);
    res.status(502).json({ error: 'Could not reach CMS' });
  }
});

adminRouter.post('/auth/verify-token', async (req, res) => {
  try {
    const strapiRes = await fetch(`${config.strapiUrl}/api/handle-admins/verify-token`, {
      method: 'POST',
      headers: strapiHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ email: req.body?.email, token: req.body?.token })
    });
    const data = await strapiRes.json();
    res.status(strapiRes.status).json(data);
  } catch (err) {
    console.error('[admin] verify-token proxy failed:', err.message);
    res.status(502).json({ error: 'Could not reach CMS' });
  }
});

// ---- editions (protected — every route below requires a valid handle-admin session) ----

adminRouter.get('/editions', requireHandleAdmin, async (req, res) => {
  try {
    const page = req.query.page || 1;
    const pageSize = req.query.pageSize || 25;
    const strapiRes = await fetch(
      `${config.strapiUrl}/api/editions?sort=date:desc&status=draft` +
      `&pagination[page]=${page}&pagination[pageSize]=${pageSize}` +
      `&fields[0]=date&fields[1]=publicationCode&fields[2]=volume&fields[3]=issueNumber` +
      `&fields[4]=pageCount&fields[5]=pipelineStatus&fields[6]=pipelineError&fields[7]=sku&fields[8]=createdAt`,
      { headers: strapiHeaders() }
    );
    const data = await strapiRes.json();
    res.status(strapiRes.status).json({ editions: data.data || [], pagination: data.meta?.pagination });
  } catch (err) {
    console.error('[admin] list editions failed:', err.message);
    res.status(502).json({ error: 'Could not reach CMS' });
  }
});

adminRouter.post('/editions', requireHandleAdmin, upload.single('sourcePdf'), async (req, res) => {
  try {
    const { date, publicationCode, volume, issueNumber } = req.body;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!publicationCode) return res.status(400).json({ error: 'publicationCode is required' });
    if (!req.file) return res.status(400).json({ error: 'sourcePdf file is required' });

    // Step 1: upload the PDF to Strapi's media library.
    const uploadForm = new FormData();
    uploadForm.append('files', new Blob([req.file.buffer]), req.file.originalname);
    const uploadRes = await fetch(`${config.strapiUrl}/api/upload`, {
      method: 'POST',
      headers: strapiHeaders(),
      body: uploadForm
    });
    const uploaded = await uploadRes.json();
    const mediaId = uploaded?.[0]?.id;
    if (!mediaId) {
      return res.status(502).json({ error: 'PDF upload to Strapi succeeded with no file id returned' });
    }

    // Step 2: create the Edition, referencing the uploaded file.
    const editionRes = await fetch(`${config.strapiUrl}/api/editions`, {
      method: 'POST',
      headers: strapiHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        data: {
          date,
          publicationCode: publicationCode.trim(),
          volume: volume || null,
          issueNumber: issueNumber || null,
          sourcePdf: mediaId
        }
      })
    });
    const edition = await editionRes.json();
    res.status(editionRes.status).json({ edition: edition.data });
  } catch (err) {
    console.error('[admin] create edition failed:', err.message);
    res.status(502).json({ error: 'Could not reach CMS' });
  }
});

adminRouter.get('/editions/:id', requireHandleAdmin, async (req, res) => {
  try {
    const strapiRes = await fetch(
      `${config.strapiUrl}/api/editions/${req.params.id}?status=draft` +
      `&populate[pages][populate][image]=true&populate[pages][populate][stories]=true&populate[sourcePdf]=true`,
      { headers: strapiHeaders() }
    );
    const result = await strapiRes.json();
    const edition = result.data;
    if (!edition) return res.status(404).json({ error: 'Edition not found' });

    const pages = [...(edition.pages || [])].sort((a, b) => a.pageNumber - b.pageNumber);
    const totalStories = pages.reduce((sum, p) => sum + (p.stories?.length || 0), 0);

    res.json({
      edition: {
        documentId: edition.documentId,
        date: edition.date,
        publicationCode: edition.publicationCode,
        volume: edition.volume,
        issueNumber: edition.issueNumber,
        sku: edition.sku,
        pageCount: edition.pageCount,
        pipelineStatus: edition.pipelineStatus,
        pipelineError: edition.pipelineError,
        sourcePdfUrl: edition.sourcePdf?.url || null
      },
      pages: pages.map(p => ({
        pageNumber: p.pageNumber,
        section: p.section,
        imageUrl: p.image?.url || null,
        storyCount: p.stories?.length || 0,
        stories: (p.stories || []).map(s => ({
          documentId: s.documentId,
          headline: s.headline,
          byline: s.byline,
          source: s.source,
          detectionConfidence: s.detectionConfidence,
          top: s.top, left: s.left, width: s.width, height: s.height
        }))
      })),
      summary: {
        pageCount: pages.length,
        storyCount: totalStories,
        pagesWithNoStories: pages.filter(p => (p.stories?.length || 0) === 0).length
      }
    });
  } catch (err) {
    console.error('[admin] edition detail failed:', err.message);
    res.status(502).json({ error: 'Could not reach CMS' });
  }
});