'use strict';
// Redaktions-Status pro Beitrag (Rohfassung → gegengelesen → schlussredigiert →
// freigegeben).
//
// Lesen ab `viewer`: wer den Beitrag sehen darf, soll erkennen, ob er fertig
// ist — gerade ein Gegenleser braucht das. Setzen ab `editor`: eine Stufe
// weiterzuschalten ist eine redaktionelle Entscheidung, keine Ansicht.
//
// Buchtyp-Gate (`isJournalisticBook`) statt eines eigenen Schalters: die Stufen
// heissen redaktionell und ergeben in einem Roman kein Bild. Der Endpunkt
// antwortet in dem Fall `enabled: false` mit leerer Map statt mit einem Fehler —
// die Organizer-Zeile fragt unabhaengig vom Buchtyp und soll nicht in einen
// Fehlerpfad laufen, nur weil der User gerade einen Roman offen hat.

const express = require('express');
const { aclParamGuard, requireBookAccess, sendACLError } = require('../lib/acl');
const { getBookSettings } = require('../db/schema');
const { isJournalisticBook } = require('../lib/buchtyp');
const {
  REDAKTION_STATUS, listBookStatus, setPageStatus, statusCounts, isValidRedaktionStatus,
} = require('../db/redaktion');
const { resolvePageBookId } = require('../lib/content-ownership');
const { toIntId } = require('../lib/validate');
const { setContext, bookParamHandler } = require('../lib/log-context');

const router = express.Router();
const jsonBody = express.json();

router.param('book_id', bookParamHandler);

/** Stufen-Inventar + alle gesetzten Stufen eines Buchs + Verteilung. */
router.get('/:book_id', aclParamGuard('viewer'), (req, res) => {
  const bookId = req.bookId;
  const settings = getBookSettings(bookId, req.session?.user?.email || null);
  if (!isJournalisticBook(settings)) {
    return res.json({ enabled: false, stufen: REDAKTION_STATUS, pages: {}, counts: null });
  }
  res.json({
    enabled: true,
    stufen: REDAKTION_STATUS,
    pages: listBookStatus(bookId),
    counts: statusCounts(bookId),
  });
});

/** Stufe einer Seite setzen (`status: null` entfernt sie wieder). */
router.put('/page/:page_id', jsonBody, (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' });
  const bookId = resolvePageBookId(pageId);
  if (!bookId) return res.status(404).json({ error_code: 'PAGE_NOT_FOUND' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const settings = getBookSettings(bookId, req.session?.user?.email || null);
  if (!isJournalisticBook(settings)) {
    return res.status(400).json({ error_code: 'NOT_JOURNALISTIC_BOOK' });
  }

  const raw = req.body?.status;
  const status = raw == null || raw === '' ? null : String(raw);
  if (status !== null && !isValidRedaktionStatus(status)) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'status' } });
  }
  const row = setPageStatus(pageId, bookId, {
    status,
    note: req.body?.note ?? null,
    userEmail: req.session?.user?.email || null,
  });
  res.json({ ok: true, page_id: pageId, entry: row, counts: statusCounts(bookId) });
});

module.exports = router;
