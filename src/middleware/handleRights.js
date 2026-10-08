/**
 * apps/middleware/src/middleware/handleRights.js          NEW FILE (Phase 2)
 *
 * Guards for handle-admin routes that need more than a valid session.
 *
 * requireHandleAdmin is the same JWT check routes/admin.js and
 * adminStories.js each carry inline (those files are left untouched).
 *
 * requireHandleRight('canManageOrganizations') then asks Strapi for the
 * admin's CURRENT rights on every request, not the JWT's. This is
 * low-traffic admin work, and it means revoking a right (or deactivating
 * the admin) in Strapi takes effect immediately rather than after the 12h
 * session expires. isSuperAdmin implies every right (resolved in the CMS).
 */
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import { config } from '../config.js';

export function requireHandleAdmin(req, res, next) {
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

export async function fetchHandleRights(adminId) {
  const res = await fetch(`${config.strapiUrl}/api/org-management/handle-admins/${encodeURIComponent(adminId)}/rights`, {
    headers: { Authorization: `Bearer ${config.strapiApiToken}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`rights lookup returned ${res.status}`);
  return res.json();
}

/** Must run after requireHandleAdmin. Sets req.handleRights. */
export function requireHandleRight(right) {
  return async (req, res, next) => {
    try {
      const rights = await fetchHandleRights(req.handleAdmin.sub);
      if (!rights || !rights.active) return res.status(401).json({ error: 'Admin account is inactive' });
      if (!rights[right]) return res.status(403).json({ error: 'You do not have permission for this section' });
      req.handleRights = rights;
      next();
    } catch (err) {
      console.error('[handleRights] could not check rights:', err.message);
      res.status(502).json({ error: 'Could not verify permissions' });
    }
  };
}