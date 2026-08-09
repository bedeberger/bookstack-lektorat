'use strict';
// Querverweise: Lesepfad auf die verweisbaren ZIELE eines Buchs (Kapitel +
// Abbildungen) und die Rueckwaertsfrage („wer verweist hierher").
//
// Kein CRUD. Ein Querverweis wird nicht angelegt, sondern geschrieben — der
// Marker im Seiten-HTML ist die Wahrheit, und der entsteht im Editor ueber den
// normalen Seiten-Save. Diese Routen bedienen nur den Ziel-Picker und die
// Warnung vor dem Loeschen eines Ziels.
//
// Rein kuratierend: nie generativ im Buchtext.

const express = require('express');
const { db } = require('../db/schema');
const { listBookAnchors, listXrefBacklinks } = require('../db/xrefs');
const { ensureBookXrefsIndexed } = require('../lib/xref-index');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError } = require('../lib/acl');
const logger = require('../logger');

const router = express.Router();

function _guard(req, res, bookId, minRole) {
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return true; }
  catch (e) { return !sendACLError(res, e); }
}

// Kapitel in Buch-Leserichtung, mit Elternzeiger fuer die Tiefe. Der Picker
// zeigt die Hierarchie eingerueckt; die NUMMER steht hier bewusst nicht dabei —
// sie haengt am Ausgabeweg und entsteht erst beim Rendern
// (public/js/xrefs/xref-number.js).
const _stmtChapters = db.prepare(`
  SELECT chapter_id, chapter_name, parent_chapter_id, position
    FROM chapters
   WHERE book_id = ?
   ORDER BY position
`);

/** GET /xrefs/targets?book_id=42
 *  Alles, worauf ein Querverweis zeigen kann — in EINER Antwort, damit der
 *  Picker im Editor nicht zwei Quellen zusammenstueckeln muss.
 *  Ab Rolle 'viewer': auch ein Lektor muss Verweise setzen und lesen koennen. */
router.get('/targets', async (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error: 'book_id fehlt' });
  if (!_guard(req, res, bookId, 'viewer')) return;

  // Bestandsinhalte nachindizieren, falls noch nie geschehen. Ohne das zeigt der
  // Picker in einem gewachsenen Buch keine Abbildung und keine Tabelle, weil
  // `xref_anchors` nur am Seiten-Write waechst. Einmal pro Buch und Prozess-Leben (siehe
  // lib/xref-index.js); der Nacht-Cron holt die uebrigen Buecher.
  try { await ensureBookXrefsIndexed(bookId); }
  catch (e) { logger.warn(`[xref] Nachindizierung fehlgeschlagen (book=${bookId}): ${e.message}`); }

  const chapters = _stmtChapters.all(bookId).map(c => ({
    kind: 'chapter',
    target: String(c.chapter_id),
    title: c.chapter_name || '',
    parentId: c.parent_chapter_id,
  }));

  // Ein Durchlauf, zwei Listen: `listBookAnchors` liefert beide Typen in
  // Leserichtung, und die Aufteilung hier haelt die Antwort ruecklaufkompatibel
  // (`figures` gab es schon).
  const anchors = listBookAnchors(bookId).map(a => ({
    kind: (a.kind === 'table') ? 'table' : 'figure',
    target: a.bid,
    title: a.caption || '',
    pageId: a.page_id,
    pageName: a.page_name || '',
    chapterId: a.chapter_id,
  }));

  res.json({
    chapters,
    figures: anchors.filter(a => a.kind === 'figure'),
    tables: anchors.filter(a => a.kind === 'table'),
  });
});

/** GET /xrefs/backlinks?kind=chapter&target=42
 *  Wer verweist auf dieses Ziel. Grundlage der Warnung, bevor ein Kapitel oder
 *  eine Abbildung geloescht wird — die Marker im Text ueberleben das Loeschen
 *  und werden sonst still zu verwaisten Verweisen. */
router.get('/backlinks', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error: 'book_id fehlt' });
  if (!_guard(req, res, bookId, 'viewer')) return;

  const kind = String(req.query.kind || '');
  if (kind !== 'chapter' && kind !== 'figure') {
    return res.status(400).json({ error: 'kind muss chapter oder figure sein' });
  }
  const target = String(req.query.target || '').trim();
  if (!target) return res.status(400).json({ error: 'target fehlt' });

  res.json(listXrefBacklinks(kind, target));
});

module.exports = router;
