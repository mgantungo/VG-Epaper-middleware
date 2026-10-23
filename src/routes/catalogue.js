/**
 * File:      /var/www/VGEpaper/middleware/src/routes/catalogue.js
 * Repo path: apps/middleware/src/routes/catalogue.js
 * System:    apps/middleware (Express, port 4161)          NEW FILE (Phase 0)
 *
 * GET /api/catalogue — everything the reader landing page draws, in one call:
 *   {
 *     today,
 *     titles: [{ title, colour, publications: [{ code, name, editionLabel, category,
 *                 language, frequency, scheduleNote, colour,
 *                 latestEdition: { date, coversFrom, coversTo, pageCount, coverUrl } | null,
 *                 access: { today, until, via: personal|organisation|null } | null }] }],
 *     plans: [{ key, label, kind, durationUnit, durationCount, price, currency, publications }],
 *     organisation: { name, role } | null
 *   }
 * Anonymous visitors get access: null. Signed-in readers get their access
 * per publication, so each row can say "Subscribed until …" or offer a plan.
 */
import { Router } from 'express';
import { getStorefront } from '../services/strapiClient.js';
import { getAccessProfile, accessSummary, todayIso } from '../services/access.js';

export const catalogueRouter = Router();

catalogueRouter.get('/', async (req, res) => {
  try {
    const store = await getStorefront();
    const pubs = store.publications || [];
    let summary = null;
    let organisation = null;
    if (req.userId) {
      try {
        const profile = await getAccessProfile(req.userId);
        summary = accessSummary(profile, pubs.map(p => p.code), todayIso());
        if (profile?.org) organisation = { name: profile.org.orgName, role: profile.org.role, usable: profile.org.usable };
      } catch (err) {
        console.error('[catalogue] access profile failed:', err.message);
      }
    }

    const titles = [];
    for (const p of pubs) {
      let group = titles.find(t => t.title === p.title);
      if (!group) {
        group = { title: p.title, colour: p.colour, language: p.language, publications: [] };
        titles.push(group);
      }
      const latest = p.latestEdition;
      group.publications.push({
        code: p.code,
        name: p.name,
        editionLabel: p.editionLabel,
        category: p.category || 'newspaper',
        language: p.language,
        frequency: p.frequency,
        scheduleNote: p.scheduleNote,
        colour: p.colour,
        latestEdition: latest
          ? {
              date: latest.date,
              coversFrom: latest.coversFrom,
              coversTo: latest.coversTo,
              pageCount: latest.pageCount,
              volume: latest.volume,
              issueNumber: latest.issueNumber,
              coverUrl: `/api/editions/${p.code.toLowerCase()}/${latest.date}/cover.jpg`
            }
          : null,
        access: summary ? { today: summary[p.code].today, until: summary[p.code].until, via: summary[p.code].via } : null
      });
    }

    res.set('Cache-Control', 'private, max-age=15');
    res.json({ today: store.today, titles, plans: store.plans || [], organisation });
  } catch (err) {
    console.error('[catalogue] storefront failed:', err.message);
    res.status(502).json({ error: 'Could not load publications' });
  }
});
