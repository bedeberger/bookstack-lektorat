'use strict';

// Namens-/Konsistenz-Waechter (regelbasiert, kein KI-Call).
//
// Synchroner Endpunkt — bewusste Ausnahme zur „KI-Calls nur via Job-Queue“-Regel,
// analog LanguageTool/STT: hier laeuft KEIN KI-Call, sondern reine Edit-Distance-
// Erkennung (lib/name-guard.js) gegen den kanonischen Namens-Stamm (figures +
// locations). Schnell genug fuer on-demand; kein Persistenz-G-eruest noetig ausser
// der Ignore-Liste (db/name-guard.js).
//
//   POST /name-guard/:book_id/check     → { clusters, anchorCount, checkedAt }
//   POST /name-guard/:book_id/ignore    { canonical, variant } → akzeptiert eine Variante
//   POST /name-guard/:book_id/unignore  { variant }            → zuruecknehmen

const express = require('express');
const logger = require('../logger');
const { db } = require('../db/schema');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const contentStore = require('../lib/content-store');
const { htmlToPlainText } = require('../lib/html-text');
const { detectNameVariants } = require('../lib/name-guard');
const nameGuardDb = require('../db/name-guard');

const router = express.Router();
const jsonBody = express.json({ limit: '64kb' });

// aclParamGuard validiert :book_id, setzt den Log-Context (book) + verlangt
// editor-Rolle und legt req.bookId ab.
router.param('book_id', aclParamGuard('editor'));

function _canonicalNames(bookId, userEmail) {
  const figRows = db.prepare(
    'SELECT name, kurzname FROM figures WHERE book_id = ? AND user_email IS ? ORDER BY sort_order'
  ).all(bookId, userEmail);
  const locRows = db.prepare(
    'SELECT name FROM locations WHERE book_id = ? AND user_email IS ? ORDER BY sort_order'
  ).all(bookId, userEmail);
  const names = [];
  for (const f of figRows) { if (f.name) names.push(f.name); if (f.kurzname) names.push(f.kurzname); }
  for (const l of locRows) if (l.name) names.push(l.name);
  return names;
}

router.post('/:book_id/check', async (req, res) => {
  const bookId = req.bookId;
  const userEmail = sessionEmail(req);
  const ctx = { session: req.session };
  const log = logger.child({ job: 'name-guard', user: userEmail || '-', book: bookId });
  try {
    const names = _canonicalNames(bookId, userEmail);
    if (!names.length) return res.json({ clusters: [], anchorCount: 0, checkedAt: new Date().toISOString() });

    const metas = await contentStore.listPages(bookId, ctx);
    if (!metas.length) return res.json({ clusters: [], anchorCount: names.length, checkedAt: new Date().toISOString() });
    const pages = await contentStore.loadPagesBatch(metas, ctx);
    const text = pages.filter(Boolean).map(p => htmlToPlainText(p.body_html || '')).join('\n');

    const ignores = nameGuardDb.list(bookId, userEmail);
    const { clusters } = detectNameVariants({ names, text, ignores });
    log.info(`Namens-Check: ${names.length} Namen, ${clusters.length} Cluster.`);
    res.json({ clusters, anchorCount: names.length, checkedAt: new Date().toISOString() });
  } catch (e) {
    log.warn(`Namens-Check fehlgeschlagen: ${e.message}`);
    res.status(500).json({ error_code: 'NAME_GUARD_FAILED' });
  }
});

router.post('/:book_id/ignore', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const canonical = typeof req.body?.canonical === 'string' ? req.body.canonical : '';
  const variant = typeof req.body?.variant === 'string' ? req.body.variant : '';
  if (!variant.trim()) return res.status(400).json({ error_code: 'VARIANT_REQUIRED' });
  nameGuardDb.add(req.bookId, userEmail, { canonical, variant });
  res.json({ ok: true });
});

router.post('/:book_id/unignore', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const variant = typeof req.body?.variant === 'string' ? req.body.variant : '';
  if (!variant.trim()) return res.status(400).json({ error_code: 'VARIANT_REQUIRED' });
  nameGuardDb.remove(req.bookId, userEmail, variant);
  res.json({ ok: true });
});

module.exports = router;
