'use strict';
// Textsorte pro Seite + Struktur-Befunde eines Buchs.
//
// Lesen ab `viewer` (die Karte ist eine Auswertung), Setzen ab `editor` — die
// Textsorte steuert das Lektorat-Typ-Set und den Struktur-Check, das ist eine
// redaktionelle Entscheidung, keine Ansicht.
//
// Der Struktur-Befund selbst wird hier nur gelesen; geschrieben wird er
// ausschliesslich vom Job (`POST /jobs/struktur-check`).

const express = require('express');
const { aclParamGuard } = require('../lib/acl');
const { getBookSettings } = require('../db/schema');
const {
  listPageTextsorten, setPageTextsorte, listStructureChecks, isValidTextsorte,
} = require('../db/textsorte');
const { resolvePageBookId } = require('../lib/content-ownership');
const { requireBookAccess, sendACLError } = require('../lib/acl');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');

const router = express.Router();
const jsonBody = express.json();

router.param('book_id', require('../lib/log-context').bookParamHandler);

/** Textsorten-Overrides + letzte Struktur-Befunde eines Buchs. */
router.get('/:book_id', aclParamGuard('viewer'), (req, res) => {
  const bookId = req.bookId;
  const settings = getBookSettings(bookId, req.session?.user?.email || null);
  res.json({
    book_textsorte: settings?.textsorte || null,
    pages: listPageTextsorten(bookId),
    checks: listStructureChecks(bookId),
  });
});

/** Seiten-Override setzen (`textsorte: null` entfernt ihn wieder). */
router.put('/page/:page_id', jsonBody, (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' });
  const bookId = resolvePageBookId(pageId);
  if (!bookId) return res.status(404).json({ error_code: 'PAGE_NOT_FOUND' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const raw = req.body?.textsorte;
  const value = raw == null || raw === '' ? null : String(raw);
  if (value !== null && !isValidTextsorte(value)) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'textsorte' } });
  }
  setPageTextsorte(pageId, bookId, value);
  res.json({ ok: true, page_id: pageId, textsorte: value });
});

module.exports = router;
