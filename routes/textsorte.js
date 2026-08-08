'use strict';
// Textsorte pro Seite + Struktur-Befunde eines Buchs.
//
// Lesen ab `viewer` (die Karte ist eine Auswertung), Setzen ab `editor` — die
// Textsorte steuert das Lektorat-Typ-Set und den Struktur-Check, das ist eine
// redaktionelle Entscheidung, keine Ansicht.
//
// Buchtyp-Gate wie bei den Geschwistern (`/headline`, `/redaktion`): lesend
// `enabled: false` mit leerer Antwort, schreibend ein Fehler. In einem Roman
// gibt es keine Textsorte im journalistischen Sinn, und ein dort gesetzter
// Override wuerde stillschweigend das Lektorat-Typ-Set verbiegen.
//
// Der Struktur-Befund selbst wird hier nur gelesen; geschrieben wird er
// ausschliesslich vom Job (`POST /jobs/struktur-check`).

const express = require('express');
const { aclParamGuard } = require('../lib/acl');
const {
  listPageTextsorten, setPageTextsorte, listStructureChecks, isValidTextsorte,
} = require('../db/textsorte');
const { pageBookGuard, journalisticBookSettings } = require('../lib/page-guard');
const { bookParamHandler } = require('../lib/log-context');

const router = express.Router();
const jsonBody = express.json();

router.param('book_id', bookParamHandler);

/** Textsorten-Overrides + letzte Struktur-Befunde eines Buchs. */
router.get('/:book_id', aclParamGuard('viewer'), (req, res) => {
  const bookId = req.bookId;
  const settings = journalisticBookSettings(req, bookId);
  if (!settings) {
    return res.json({ enabled: false, book_textsorte: null, pages: {}, checks: [] });
  }
  res.json({
    enabled: true,
    book_textsorte: settings.textsorte || null,
    pages: listPageTextsorten(bookId),
    checks: listStructureChecks(bookId),
  });
});

/** Seiten-Override setzen (`textsorte: null` entfernt ihn wieder). */
router.put('/page/:page_id', jsonBody, (req, res) => {
  const g = pageBookGuard(req, res, { minRole: 'editor', journalistic: true });
  if (!g) return;

  const raw = req.body?.textsorte;
  const value = raw == null || raw === '' ? null : String(raw);
  if (value !== null && !isValidTextsorte(value)) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'textsorte' } });
  }
  setPageTextsorte(g.pageId, g.bookId, value);
  res.json({ ok: true, page_id: g.pageId, textsorte: value });
});

module.exports = router;
