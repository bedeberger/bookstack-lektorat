const express = require('express');
const { db } = require('../db/schema');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

// Lektorat-Ergebnis speichern
router.post('/check', jsonBody, (req, res) => {
  const { page_id, page_name, book_id, error_count, errors_json, stilanalyse, fazit, model } = req.body;
  const user_email = req.session?.user?.email || null;
  const result = db.prepare(`
    INSERT INTO page_checks (page_id, page_name, book_id, checked_at, error_count, errors_json, stilanalyse, fazit, model, user_email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    page_id, page_name, book_id,
    new Date().toISOString(),
    error_count || 0,
    JSON.stringify(errors_json || []),
    stilanalyse || null, fazit || null, model || null, user_email
  );
  res.json({ id: result.lastInsertRowid });
});

// Lauf als «in BookStack gespeichert» markieren (oder zurücksetzen)
router.patch('/check/:id/saved', jsonBody, (req, res) => {
  const saved = req.body?.saved !== undefined ? (req.body.saved ? 1 : 0) : 1;
  const saved_at = saved ? new Date().toISOString() : null;
  const applied = req.body?.applied_errors_json !== undefined
    ? JSON.stringify(req.body.applied_errors_json)
    : null;
  const selected = req.body?.selected_errors_json !== undefined
    ? JSON.stringify(req.body.selected_errors_json)
    : null;
  const user_email = req.session?.user?.email || null;
  const id = parseInt(req.params.id);

  // Erst Ownership prüfen (user_email-Scope), dann updaten. Verhindert ID-Raten
  // über Buch-/User-Grenzen und liefert verifizierte book_id für das Log.
  const row = db.prepare('SELECT page_id, page_name, book_id, chapter_id FROM page_checks WHERE id = ? AND user_email = ?').get(id, user_email);
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });

  db.prepare('UPDATE page_checks SET saved = ?, saved_at = ?, applied_errors_json = COALESCE(?, applied_errors_json), selected_errors_json = COALESCE(?, selected_errors_json) WHERE id = ? AND user_email = ? AND book_id = ?')
    .run(saved, saved_at, applied, selected, id, user_email, row.book_id);

  if (saved) {
    const appliedErrors = req.body?.applied_errors_json;
    if (Array.isArray(appliedErrors)) {
      const counts = { rechtschreibung: 0, grammatik: 0, wiederholung: 0, stil: 0 };
      for (const f of appliedErrors) if (f.typ && counts[f.typ] !== undefined) counts[f.typ]++;
      const total = appliedErrors.length;
      logger.info(
        `Lektorat gespeichert: «${row.page_name}» (user=${user_email || '-'}, book=${row.book_id || '-'}, chap=${row.chapter_id || '-'}, page=${row.page_id}, ${total} Korrekturen: R=${counts.rechtschreibung} G=${counts.grammatik} W=${counts.wiederholung} S=${counts.stil})`
      );
    }
  }

  res.json({ ok: true });
});

// Letzte 20 Läufe für eine Seite
router.get('/page/:page_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const rows = db.prepare(`
    SELECT * FROM page_checks WHERE page_id = ? AND user_email = ?
    ORDER BY checked_at DESC LIMIT 20`).all(parseInt(req.params.page_id), user_email);
  res.json(rows.map(r => ({
    ...r,
    errors_json: JSON.parse(r.errors_json || '[]'),
    applied_errors_json: r.applied_errors_json ? JSON.parse(r.applied_errors_json) : null,
    selected_errors_json: r.selected_errors_json ? JSON.parse(r.selected_errors_json) : null,
    szenen_json: r.szenen_json ? JSON.parse(r.szenen_json) : null,
    saved: !!r.saved,
  })));
});

// Buchbewertung speichern
router.post('/review', jsonBody, (req, res) => {
  const { book_id, book_name, review_json, model } = req.body;
  const user_email = req.session?.user?.email || null;
  const result = db.prepare(`
    INSERT INTO book_reviews (book_id, book_name, reviewed_at, review_json, model, user_email)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    book_id, book_name,
    new Date().toISOString(),
    JSON.stringify(review_json || null),
    model || null, user_email
  );
  res.json({ id: result.lastInsertRowid });
});

// Lektorat-Prüfung löschen
router.delete('/check/:id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  db.prepare('DELETE FROM page_checks WHERE id = ? AND user_email = ?')
    .run(parseInt(req.params.id), user_email);
  res.json({ ok: true });
});

// Buchbewertung löschen
router.delete('/review/:id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  db.prepare('DELETE FROM book_reviews WHERE id = ? AND user_email = ?')
    .run(parseInt(req.params.id), user_email);
  res.json({ ok: true });
});

// Kompletter History-Reset für ein Buch: löscht page_checks, book_reviews und
// chat_sessions (inkl. Nachrichten via ON DELETE CASCADE) des eingeloggten Users.
router.delete('/book/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  if (!user_email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const book_id = parseInt(req.params.book_id);
  if (!Number.isFinite(book_id)) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });

  const delChecks   = db.prepare('DELETE FROM page_checks    WHERE book_id = ? AND user_email = ?');
  const delReviews  = db.prepare('DELETE FROM book_reviews   WHERE book_id = ? AND user_email = ?');
  const delSessions = db.prepare('DELETE FROM chat_sessions  WHERE book_id = ? AND user_email = ?');

  const result = db.transaction(() => ({
    page_checks:    delChecks.run(book_id, user_email).changes,
    book_reviews:   delReviews.run(book_id, user_email).changes,
    chat_sessions:  delSessions.run(book_id, user_email).changes,
  }))();

  logger.info(
    `History-Reset: book=${book_id} user=${user_email} ` +
    `page_checks=${result.page_checks} book_reviews=${result.book_reviews} chat_sessions=${result.chat_sessions}`
  );
  res.json({ ok: true, deleted: result });
});

// Letzte 10 Bewertungen für ein Buch
router.get('/review/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const rows = db.prepare(`
    SELECT * FROM book_reviews WHERE book_id = ? AND user_email = ?
    ORDER BY reviewed_at DESC LIMIT 10`).all(parseInt(req.params.book_id), user_email);
  res.json(rows.map(r => ({ ...r, review_json: JSON.parse(r.review_json || 'null') })));
});

// Seiten-Stats-Cache: alle gecachten Stats für ein Buch (geteilter Cache, nicht user-spezifisch)
router.get('/page-stats/:book_id', (req, res) => {
  const rows = db.prepare(
    'SELECT page_id, tok, words, chars, updated_at FROM page_stats WHERE book_id = ?'
  ).all(parseInt(req.params.book_id));
  const map = {};
  for (const r of rows) map[r.page_id] = { tok: r.tok, words: r.words, chars: r.chars, updated_at: r.updated_at };
  res.json(map);
});

// Seiten-Stats-Cache: Batch-Upsert (vom Frontend nach Token-Berechnung)
router.post('/page-stats/batch', express.json(), (req, res) => {
  const items = req.body;
  if (!Array.isArray(items) || !items.length) return res.json({ ok: true, count: 0 });
  const stmt = db.prepare(`
    INSERT INTO page_stats (page_id, book_id, tok, words, chars, updated_at, cached_at)
    VALUES (@page_id, @book_id, @tok, @words, @chars, @updated_at, @cached_at)
    ON CONFLICT(page_id) DO UPDATE SET
      tok=excluded.tok, words=excluded.words, chars=excluded.chars,
      updated_at=excluded.updated_at, cached_at=excluded.cached_at
  `);
  const now = new Date().toISOString();
  db.transaction(() => { for (const s of items) stmt.run({ ...s, cached_at: now }); })();
  res.json({ ok: true, count: items.length });
});

// Buchstatistik-Verlauf für Zeitliniendiagramm (geteilter Cache, nicht user-spezifisch)
router.get('/book-stats/:book_id', (req, res) => {
  const rows = db.prepare(`
    SELECT id, book_id, book_name, recorded_at, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len
    FROM book_stats_history WHERE book_id = ?
    ORDER BY recorded_at ASC
  `).all(parseInt(req.params.book_id));
  res.json(rows);
});

// Pro Seite den letzten Check-Zeitpunkt (user-spezifisch). Frontend berechnet Staleness.
// Wenn Korrekturen aus einem Check übernommen wurden (saved_at gesetzt), zählt dieser
// Zeitpunkt — sonst würde das anschliessende BookStack-updated_at die Seite sofort
// wieder auf "bearbeitet seit Lektorat" (warn) flippen.
router.get('/page-ages/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const bookId = parseInt(req.params.book_id);
  const rows = db.prepare(`
    SELECT page_id,
           MAX(CASE WHEN saved_at IS NOT NULL AND saved_at > checked_at THEN saved_at ELSE checked_at END) as last_checked_at
    FROM page_checks
    WHERE book_id = ? AND user_email = ?
    GROUP BY page_id
  `).all(bookId, user_email);
  const map = {};
  for (const r of rows) map[r.page_id] = r.last_checked_at;
  res.json(map);
});

// Lektorat-Abdeckung: wie viele Seiten eines Buchs wurden schon geprüft (user-spezifisch)
router.get('/coverage/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const bookId = parseInt(req.params.book_id);
  const { total } = db.prepare('SELECT COUNT(*) as total FROM page_stats WHERE book_id = ?').get(bookId);
  const { checked } = db.prepare(
    'SELECT COUNT(DISTINCT page_id) as checked FROM page_checks WHERE book_id = ? AND user_email = ?'
  ).get(bookId, user_email);
  const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
  res.json({ checked_pages: checked, total_pages: total, pct });
});

module.exports = router;
