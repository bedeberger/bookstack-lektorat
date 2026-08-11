'use strict';
// Titel-Werkstatt: Dachzeile / Titel / Lead / Teaser eines Beitrags.
//
// Lesen ab `viewer` (auch ein Lektor muss den Titel sehen, gegen den er den Text
// liest), Schreiben ab `editor`. Buchtyp-Gate wie beim Redaktions-Status: in
// einem Roman gibt es keine Dachzeile, und der Endpunkt antwortet dort mit
// `enabled: false` statt mit einem Fehler.
//
// Zeichenlimits kommen hier NICHT vor — sie sind Anzeige, nicht Validierung
// (siehe public/js/headline/channels.js). Was der Autor schreibt, wird
// gespeichert.

const express = require('express');
const { aclParamGuard, requireBookAccess, sendACLError, sessionEmail } = require('../lib/acl');
const {
  HEADLINE_FIELDS, isValidHeadlineField,
  getHeadline, listBookHeadlines, setHeadline,
  listVariants, addVariant, deleteVariant, promoteVariant, getVariant,
} = require('../db/headline');
const { pageBookGuard, journalisticBookSettings } = require('../lib/page-guard');
const { toIntId } = require('../lib/validate');
const { setContext, bookParamHandler } = require('../lib/log-context');

const router = express.Router();
const jsonBody = express.json();

router.param('book_id', bookParamHandler);

/** Guard fuer die Seiten-Routen: ACL + Buchtyp (SSoT in lib/page-guard.js). */
function _pageGuard(req, res, minRole) {
  return pageBookGuard(req, res, { minRole, journalistic: true });
}

/** Alle Titel-Saetze eines Buchs (Organizer-/Karten-Uebersicht). */
router.get('/:book_id', aclParamGuard('viewer'), (req, res) => {
  const bookId = req.bookId;
  if (!journalisticBookSettings(req, bookId)) {
    return res.json({ enabled: false, felder: HEADLINE_FIELDS, pages: {} });
  }
  res.json({ enabled: true, felder: HEADLINE_FIELDS, pages: listBookHeadlines(bookId) });
});

/** Geltender Stand + Varianten einer Seite. */
router.get('/page/:page_id', (req, res) => {
  const g = _pageGuard(req, res, 'viewer');
  if (!g) return;
  res.json({
    page_id: g.pageId,
    felder: HEADLINE_FIELDS,
    headline: getHeadline(g.pageId),
    varianten: listVariants(g.pageId),
  });
});

/** Felder setzen. Nur die uebergebenen — fehlende bleiben unberuehrt. */
router.put('/page/:page_id', jsonBody, (req, res) => {
  const g = _pageGuard(req, res, 'editor');
  if (!g) return;
  const patch = {};
  for (const f of HEADLINE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) patch[f] = req.body[f];
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error_code: 'NO_FIELDS' });
  }
  const row = setHeadline(g.pageId, g.bookId, patch, sessionEmail(req));
  res.json({ ok: true, page_id: g.pageId, headline: row });
});

/** Variante von Hand anlegen. */
router.post('/page/:page_id/variants', jsonBody, (req, res) => {
  const g = _pageGuard(req, res, 'editor');
  if (!g) return;
  const feld = String(req.body?.feld || '');
  if (!isValidHeadlineField(feld)) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'feld' } });
  }
  const v = addVariant(g.pageId, g.bookId, {
    feld, text: req.body?.text, herkunft: 'user',
    userEmail: sessionEmail(req),
  });
  if (!v) return res.status(400).json({ error_code: 'EMPTY_TEXT' });
  res.json({ ok: true, variant: v, varianten: listVariants(g.pageId) });
});

/** Variante loeschen. ACL laeuft ueber das Buch der Variante, nicht ueber einen
 *  mitgeschickten Parameter — sonst koennte ein Client eine fremde Variante
 *  unter Angabe seines eigenen Buchs loeschen. */
router.delete('/variants/:id', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const v = getVariant(id);
  if (!v) return res.status(404).json({ error_code: 'VARIANT_NOT_FOUND' });
  setContext({ book: v.book_id });
  try { requireBookAccess(req, v.book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  deleteVariant(id);
  res.json({ ok: true, page_id: v.page_id, varianten: listVariants(v.page_id) });
});

/** Variante uebernehmen: wird geltender Stand, bisheriger Stand wird gesichert. */
router.post('/variants/:id/promote', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const v = getVariant(id);
  if (!v) return res.status(404).json({ error_code: 'VARIANT_NOT_FOUND' });
  setContext({ book: v.book_id });
  try { requireBookAccess(req, v.book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const row = promoteVariant(id, sessionEmail(req));
  res.json({ ok: true, page_id: v.page_id, headline: row, varianten: listVariants(v.page_id) });
});

module.exports = router;
