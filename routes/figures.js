const express = require('express');
const { db, saveFigurenToDb, getChapterFigures, listFigurenWithDetails } = require('../db/schema');
const { mergeFigures } = require('../db/entity-merge');
const { recomputeBookFigureMentions } = require('../lib/page-index');
const { toIntId } = require('../lib/validate');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const { computeFigureYears } = require('../lib/figure-years');
const searchIndex = require('../lib/search');
const semanticChunks = require('../db/semantic-chunks');
const logger = require('../logger');

const router = express.Router();
// Figuren/Orte/Szenen sind nur fuer editor+ relevant (Buchwelt-CRUD); Lektor
// und Viewer sehen die Karten nicht — Server folgt der Frontend-Sicht.
router.param('book_id', aclParamGuard('editor'));
router.param('book_id', bookParamHandler);
const jsonBody = express.json();

// Der Zeitstrahl haengt am selben Prefix und damit am selben ACL-/Log-Guard,
// ist aber ein eigenes Thema (zeitstrahl_events statt figures) — Submodul auf
// demselben Router, Muster wie routes/history/. Muss VOR `/:book_id` stehen,
// sonst schluckt die Buch-Route den Pfad `/zeitstrahl/:book_id`.
require('./figures/zeitstrahl').register(router);
// Szenen ebenso: eigenes Thema (figure_scenes), gleicher Prefix und Guard.
require('./figures/scenes').register(router);

// Figuren eines Kapitels laden (für Kontext-Panel im Editor)
router.get('/chapter/:book_id/:chapter_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  const chapterId = toIntId(req.params.chapter_id);
  if (!bookId || !chapterId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = sessionEmail(req);
  const figuren = getChapterFigures(bookId, chapterId, userEmail);
  // Pro-Figur-Jahr/Alter anreichern (nur bei zeitlinie_real; sonst null-Map).
  const yearMap = computeFigureYears(bookId, userEmail);
  if (yearMap) {
    for (const fig of figuren) {
      const fy = yearMap.get(fig.id);
      if (!fy) continue;
      fig.jahr_im_roman   = fy.jahr_im_roman;
      fig.geburtsjahr     = fy.geburtsjahr;
      fig.alter_im_roman  = fy.alter_im_roman;
      fig.anchor_ereignis = fy.anchor_ereignis;
      fig.anchor_kapitel  = fy.anchor_kapitel;
    }
  }
  res.json({ figuren });
});

// Gespeicherte Figuren eines Buchs laden. Die Aufloesung selbst (sechs
// Abfragen, darunter Namens-JOINs auf chapters/pages) liegt in
// db/figures/queries.js — CLAUDE.md, harte Regel „Content-Store-Facade als
// einziger Eintrittspunkt": ein Namens-JOIN gehoert in das db-Modul der
// abgeleiteten Tabelle, nicht in den Handler.
router.get('/:book_id', (req, res) => {
  res.json(listFigurenWithDetails(req.bookId, sessionEmail(req)));
});

// Figuren eines Buchs speichern (überschreibt)
router.put('/:book_id', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  // Reconcile per fig_id (round-trippt stabil durch GET→PUT): behaltene Figuren
  // behalten ihre figures.id → externe Referenzen (Plot/Recherche/Events) überleben
  // den manuellen Save. Im Katalog entfernte Figuren werden gelöscht (User autoritativ).
  saveFigurenToDb(bookId, req.body.figuren || [], userEmail, null, { reconcile: true, matchBy: 'figId', onMissing: 'delete' });
  // Response sofort – Mentions-Neuberechnung läuft im Hintergrund. Auf grossen Büchern
  // (>500 Seiten × >50 Figuren) braucht der Regex-Scan mehrere Sekunden.
  res.json({ ok: true });
  // FTS-Index nachziehen: saveFigurenToDb ist Full-Replace pro Buch — daher
  // kind/book droppen und neu indexieren. Beides bewusst OHNE user_email:
  // `removeKindForBook` loescht buchweit, also muss auch buchweit neu geschrieben
  // werden — eine user-skopierte Auswahl hier liesse die Figuren der uebrigen
  // Mitarbeitenden desselben Buchs geloescht und unindiziert zurueck.
  searchIndex.removeKindForBook('figure', bookId);
  const figRows = db.prepare('SELECT id FROM figures WHERE book_id = ?').all(bookId);
  for (const r of figRows) searchIndex.upsertFigure(r.id);
  setImmediate(() => {
    try {
      const { figures, pagesProcessed } = recomputeBookFigureMentions(bookId, userEmail);
      logger.info(`Figuren-Mentions aktualisiert: Buch ${bookId}, ${figures} Figuren × ${pagesProcessed} Seiten.`);
    } catch (e) {
      logger.warn(`Figuren-Mentions-Neuberechnung für Buch ${bookId} fehlgeschlagen: ${e.message}`);
    }
  });
});

// Zwei Figuren zusammenführen: alle Referenzen der Quelle wandern aufs Ziel, die
// Quelle wird gelöscht (Merge-Kern db/entity-merge.js). Gedacht für verwaiste
// («nicht mehr im Text») Einträge, deren Verknüpfungen beim blossen Löschen
// verloren gingen — bewusst OHNE stale-Gate, weil der Reconcile dieselbe Figur
// gelegentlich auch als zwei aktive Einträge auseinanderhält.
// `source`/`target` sind `figures.fig_id` (TEXT) — dieselbe Kennung, die GET als
// `id` ausliefert und die der Einzel-Delete-Handler nimmt.
router.post('/:book_id/merge', jsonBody, (req, res) => {
  const bookId = toIntId(req.params.book_id);
  const src = String(req.body?.source || '').trim();
  const tgt = String(req.body?.target || '').trim();
  if (!bookId || !src || !tgt) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (src === tgt) return res.status(409).json({ error_code: 'SAME_ENTITY' });
  const userEmail = sessionEmail(req);
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal = userEmail ? [userEmail] : [];
  const get = db.prepare(`SELECT id FROM figures WHERE fig_id = ? AND book_id = ? AND ${emailCond}`);
  const sRow = get.get(src, bookId, ...emailVal);
  const tRow = get.get(tgt, bookId, ...emailVal);
  if (!sRow) return res.status(404).json({ error_code: 'NOT_FOUND', side: 'source' });
  if (!tRow) return res.status(404).json({ error_code: 'NOT_FOUND', side: 'target' });
  if (sRow.id === tRow.id) return res.status(409).json({ error_code: 'SAME_ENTITY' });

  const result = mergeFigures(bookId, userEmail, sRow.id, tRow.id);
  // Index-Pflege wie beim Einzel-Delete: Quelle raus, Ziel neu schreiben (der
  // Feld-Backfill kann seinen FTS-Text verändert haben).
  searchIndex.remove('figure', sRow.id);
  semanticChunks.remove('figure', sRow.id);
  searchIndex.upsertFigure(tRow.id);
  logger.info(`Figuren-Merge: «${result.sourceName}» → «${result.targetName}» (Buch ${bookId}).`);
  res.json({ ok: true, ...result });
  // page_figure_mentions ist abgeleitet: die Summe aus dem Merge hält den Stand
  // brauchbar, korrekt wird er erst mit dem Neu-Scan (der auch den kurzname des
  // Ziels berücksichtigt). Wie im PUT-Pfad im Hintergrund.
  setImmediate(() => {
    try {
      recomputeBookFigureMentions(bookId, userEmail);
    } catch (e) {
      logger.warn(`Figuren-Mentions nach Merge (Buch ${bookId}) fehlgeschlagen: ${e.message}`);
    }
  });
});

// Bulk-Cleanup: alle STALE Figuren eines Buchs auf einmal löschen (Danger-Zone). Pendant
// zum Einzel-Delete '/:book_id/:id'. Nur stale wird angefasst — aktive Figuren bleiben
// unberührt. CASCADE räumt die Bridges mit.
// Muss VOR '/:book_id/:id' stehen, sonst matcht 'stale' als :id.
router.delete('/:book_id/stale', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = sessionEmail(req);
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal = userEmail ? [userEmail] : [];
  const ids = db.prepare(
    `SELECT id FROM figures WHERE book_id = ? AND ${emailCond} AND stale = 1`
  ).all(bookId, ...emailVal).map(r => r.id);
  db.transaction(() => {
    const del = db.prepare('DELETE FROM figures WHERE id = ?');
    for (const id of ids) del.run(id);
  })();
  for (const id of ids) { searchIndex.remove('figure', id); semanticChunks.remove('figure', id); }
  res.json({ ok: true, deleted: { figures: ids.length } });
});

// Einzelne STALE-Figur endgültig löschen (GUI-Button auf "nicht mehr im Text"-Zeilen).
// Nur stale erlaubt — aktive Figuren überleben die Re-Analyse via Reconcile. CASCADE räumt
// figure_relations/-events/-scenes/-appearances/-tags/page_figure_mentions +
// plot_beat_figures/research_item_links mit.
// `:id` ist die oeffentliche Figuren-Kennung `figures.fig_id` (TEXT) — dieselbe, die GET
// als `id` ausliefert; die INTEGER-PK verlaesst die Route nie. Bei stale-Figuren ist sie
// 'orphan_<rowid>', also nie eine Zahl.
router.delete('/:book_id/:id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  const figId = String(req.params.id || '').trim();
  if (!bookId || !figId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = sessionEmail(req);
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const row = db.prepare(
    `SELECT id, stale FROM figures WHERE fig_id = ? AND book_id = ? AND ${emailCond}`
  ).get(figId, bookId, ...(userEmail ? [userEmail] : []));
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!row.stale) return res.status(409).json({ error_code: 'NOT_STALE' });
  db.prepare('DELETE FROM figures WHERE id = ?').run(row.id);
  searchIndex.remove('figure', row.id);
  semanticChunks.remove('figure', row.id);
  res.json({ ok: true });
});

module.exports = router;
