/**
 * File:      /var/www/VGEpaper/apps/middleware/src/server.js
 * Repo path: apps/middleware/src/server.js
 * System:    apps/middleware (Express, port 4161)          MODIFIED
 *
 * Changes:
 *   - mounts routes/adminStories.js (story editor) under /api/admin.
 *   - Phase 2 (organisations): mounts routes/adminOrgs.js at
 *     /api/admin/organisations, ahead of the other /api/admin routers. It is
 *     gated by ORG_FEATURE_ENABLED=true and returns 404 for everything when
 *     that is unset. Because it sits on its own sub-path, the gate can't touch
 *     /api/admin/auth, /api/admin/editions or /api/admin/editor.
 *   - Phase 3 (organisations): mounts routes/orgAdmin.js at /api/org-admin
 *     (the Org Admin dashboard, also gated by ORG_FEATURE_ENABLED) and
 *     routes/invites.js at /api/auth/invite (accepting an invite).
 *   - Story search: mounts routes/search.js at /api/search (POST /stories),
 *     which proxies to the CMS full-text search (services/storySearchClient.js).
 *   - Phase 0 (publications): mounts routes/catalogue.js at /api/catalogue
 *     (reader landing page) and routes/adminCatalogue.js at
 *     /api/admin/catalogue (handle: publications, plans and prices).
 *   - Phases 1–4 (reader analytics): mounts routes/track.js at /api/track
 *     (reading events from the web reader) and routes/adminAnalytics.js at
 *     /api/admin/analytics (handle dashboards). Org Admin usage is
 *     /api/org-admin/usage (routes/orgAdmin.js).
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { attachUser } from './middleware/auth.js';
import { editionsRouter } from './routes/editions.js';
import { paymentsRouter } from './routes/payments.js';
import { accountRouter } from './routes/account.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { adminStoriesRouter } from './routes/adminStories.js';
import { adminOrgsRouter } from './routes/adminOrgs.js';
import { orgAdminRouter } from './routes/orgAdmin.js';
import { invitesRouter } from './routes/invites.js';
import { searchRouter } from './routes/search.js';
import { catalogueRouter } from './routes/catalogue.js';
import { adminCatalogueRouter } from './routes/adminCatalogue.js';
import { adminAnalyticsRouter } from './routes/adminAnalytics.js';
import { trackRouter } from './routes/track.js';

const app = express();

app.use(cors({ origin: config.webOrigin, credentials: true }));
app.use(cookieParser());

// The webhook needs the *raw* request body to verify the gateway's signature,
// so it gets its own raw parser and is deliberately excluded from the general
// express.json() below — applying both to the same request would try to read
// the request stream twice.
app.use('/api/pay/webhook', express.raw({ type: 'application/json' }));

app.use((req, res, next) => {
  if (req.path === '/api/pay/webhook') return next();
  express.json()(req, res, next);
});
app.use(attachUser);

app.use('/api/editions', editionsRouter);
// Reading events from the web reader (sendBeacon; Phases 1–4).
app.use('/api/track', trackRouter);
// Landing page: publications, latest editions, plans, the reader's access (Phase 0).
app.use('/api/catalogue', catalogueRouter);
app.use('/api/pay', paymentsRouter);
app.use('/api/account', accountRouter);
// Full-text story search (proxies to the CMS; see routes/search.js).
app.use('/api/search', searchRouter);
// Organisation invites: under /api/auth so the path-scoped refresh cookie is
// set for /api/auth, exactly as on login. Mounted before authRouter.
app.use('/api/auth/invite', invitesRouter);
app.use('/api/auth', authRouter);
// Org Admin dashboard (reader web app /organisation).
app.use('/api/org-admin', orgAdminRouter);
// Serves handle.epapers.visiongroup.co.ug — a completely separate app
// and origin from config.webOrigin above, but that's irrelevant to CORS
// here: the handle app's own Nitro server calls this router server-to-
// server (see apps/handle/server/api/*.ts), never from its browser
// directly. Server-to-server requests aren't subject to CORS at all —
// no change needed to the cors() config above for this to work.
// Organisation management (handle admins with canManageOrganizations) —
// see routes/adminOrgs.js. Mounted first and on its own sub-path.
app.use('/api/admin/organisations', adminOrgsRouter);
// Publications, plans and prices (handle; changes need canManageOrganizations). Phase 0.
app.use('/api/admin/catalogue', adminCatalogueRouter);
// Reader analytics dashboards (handle; canManageOrganizations). Phases 1–4.
app.use('/api/admin/analytics', adminAnalyticsRouter);
app.use('/api/admin', adminRouter);
// Story editor: /api/admin/editor/* -> apps/ingest (see routes/adminStories.js).
app.use('/api/admin', adminStoriesRouter);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(config.port, () => {
  console.log(`[middleware] listening on :${config.port}`);
});