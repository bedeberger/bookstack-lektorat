'use strict';
// Bewertungen + Tagebuch-Rueckblicke: Buch-/Kapitel-Reviews und Rueckblicke
// lesen und loeschen, dazu der komplette History-Reset eines Buchs.

const { db } = require('../../db/schema');
const { toIntId } = require('../../lib/validate');
const { sessionEmail } = require('../../lib/acl');
const { buildRueckblickCoverage } = require('../jobs/rueckblick-dates');
const logger = require('../../logger');

function register(router) {
  // Buchbewertung löschen
  router.delete('/review/:id', (req, res) => {
    const user_email = sessionEmail(req);
    const id = toIntId(req.params.id);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    db.prepare('DELETE FROM book_reviews WHERE id = ? AND user_email = ?')
      .run(id, user_email);
    res.json({ ok: true });
  });

  // Tagebuch-Rückblick (History-Eintrag) löschen
  router.delete('/rueckblick/:id', (req, res) => {
    const user_email = sessionEmail(req);
    const id = toIntId(req.params.id);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    db.prepare('DELETE FROM tagebuch_rueckblicke WHERE id = ? AND user_email = ?')
      .run(id, user_email);
    res.json({ ok: true });
  });

  // Kompletter History-Reset für ein Buch: löscht page_checks, book_reviews und
  // chat_sessions (inkl. Nachrichten via ON DELETE CASCADE) des eingeloggten Users.
  router.delete('/book/:book_id', (req, res) => {
    const user_email = sessionEmail(req);
    const book_id = req.bookId;

    const delChecks     = db.prepare('DELETE FROM page_checks      WHERE book_id = ? AND user_email = ?');
    const delReviews    = db.prepare('DELETE FROM book_reviews     WHERE book_id = ? AND user_email = ?');
    const delChReviews  = db.prepare('DELETE FROM chapter_reviews  WHERE book_id = ? AND user_email = ?');
    const delSessions   = db.prepare('DELETE FROM chat_sessions    WHERE book_id = ? AND user_email = ?');
    const delWerkRuns   = db.prepare('DELETE FROM werkstatt_runs   WHERE book_id = ? AND user_email = ?');
    const delRueckblicke = db.prepare('DELETE FROM tagebuch_rueckblicke WHERE book_id = ? AND user_email = ?');

    const result = db.transaction(() => ({
      page_checks:      delChecks.run(book_id, user_email).changes,
      book_reviews:     delReviews.run(book_id, user_email).changes,
      chapter_reviews:  delChReviews.run(book_id, user_email).changes,
      chat_sessions:    delSessions.run(book_id, user_email).changes,
      werkstatt_runs:   delWerkRuns.run(book_id, user_email).changes,
      rueckblicke:      delRueckblicke.run(book_id, user_email).changes,
    }))();

    logger.info(
      `History-Reset: book=${book_id} user=${user_email} ` +
      `page_checks=${result.page_checks} book_reviews=${result.book_reviews} ` +
      `chapter_reviews=${result.chapter_reviews} chat_sessions=${result.chat_sessions} ` +
      `werkstatt_runs=${result.werkstatt_runs} rueckblicke=${result.rueckblicke}`
    );
    res.json({ ok: true, deleted: result });
  });

  // Letzte 10 Bewertungen für ein Buch
  router.get('/review/:book_id', (req, res) => {
    const user_email = sessionEmail(req);
    const bookId = req.bookId;
    const rows = db.prepare(`
      SELECT br.*, b.name AS book_name FROM book_reviews br
      LEFT JOIN books b ON b.book_id = br.book_id
      WHERE br.book_id = ? AND br.user_email = ?
      ORDER BY br.reviewed_at DESC LIMIT 10`).all(bookId, user_email);
    res.json(rows.map(r => ({ ...r, review_json: JSON.parse(r.review_json || 'null') })));
  });

  // Tagebuch-Rückblicke: letzte 20 generierte Rückblicke eines Buchs (re-öffenbar).
  router.get('/rueckblick/:book_id', (req, res) => {
    const user_email = sessionEmail(req);
    const bookId = req.bookId;
    const rows = db.prepare(`
      SELECT id, zeitraum, result_json, model, entry_count, created_at
      FROM tagebuch_rueckblicke
      WHERE book_id = ? AND user_email = ?
      ORDER BY created_at DESC LIMIT 20`).all(bookId, user_email);
    // Pro-Zeile parsen: eine einzelne kaputte result_json-Zeile darf nicht die
    // ganze Liste 500en (sonst lädt die History gar nicht → Rückblick-Karte bleibt
    // leer). Fehlerhafte Zeile → result_json: null (Frontend blendet sie aus).
    res.json(rows.map(r => {
      let result_json = null;
      try { result_json = JSON.parse(r.result_json || 'null'); }
      catch (e) { logger.warn(`[history/rueckblick] kaputte result_json in Zeile id=${r.id}: ${e.message}`); }
      return { ...r, result_json };
    }));
  });

  // Rückblick-Heatmap-Coverage: aggregiert datierte Seiten (Monats-/Jahres-Buckets)
  // + vorhandene KI-Rückblicke des Users zu fertigen Buckets fürs Overview-Tile.
  // Liest nur Metadaten (page_name/page_id) zur Datums-Aggregation — kein Buch-
  // Inhalt (folgt der Praxis von /fehler-heatmap, /style-stats). Kein KI-Call.
  router.get('/rueckblick-coverage/:book_id', (req, res) => {
    const user_email = sessionEmail(req);
    const bookId = req.bookId;
    const pages = db.prepare('SELECT page_id, page_name FROM pages WHERE book_id = ?').all(bookId);
    // Jüngster Rückblick je Zeitraum (user-spezifisch — tagebuch_rueckblicke ist persönlich).
    const rbRows = db.prepare(`
      WITH ranked AS (
        SELECT id, zeitraum, created_at,
               ROW_NUMBER() OVER (PARTITION BY zeitraum ORDER BY created_at DESC, id DESC) AS rn
        FROM tagebuch_rueckblicke
        WHERE book_id = ? AND user_email = ?
      )
      SELECT id, zeitraum, created_at FROM ranked WHERE rn = 1
    `).all(bookId, user_email);
    res.json(buildRueckblickCoverage(pages, rbRows));
  });

  // Kapitel-Reviews: alle Einträge eines Buchs, gruppiert als { [chapter_id]: [entries] }.
  // Max. 10 Einträge pro Kapitel (absteigend nach Datum).
  router.get('/chapter-reviews/:book_id', (req, res) => {
    const user_email = sessionEmail(req);
    const book_id = req.bookId;
    const rows = db.prepare(`
      SELECT cr.*, b.name AS book_name FROM chapter_reviews cr
      LEFT JOIN books b ON b.book_id = cr.book_id
      WHERE cr.book_id = ? AND cr.user_email = ?
      ORDER BY cr.chapter_id, cr.reviewed_at DESC`).all(book_id, user_email);
    const byChapter = {};
    for (const r of rows) {
      const key = String(r.chapter_id);
      if (!byChapter[key]) byChapter[key] = [];
      if (byChapter[key].length < 10) {
        byChapter[key].push({ ...r, review_json: JSON.parse(r.review_json || 'null') });
      }
    }
    res.json(byChapter);
  });

  // Einzelnes Kapitel-Review löschen
  router.delete('/chapter-review/:id', (req, res) => {
    const user_email = sessionEmail(req);
    const id = toIntId(req.params.id);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    db.prepare('DELETE FROM chapter_reviews WHERE id = ? AND user_email = ?')
      .run(id, user_email);
    res.json({ ok: true });
  });
}

module.exports = { register };
