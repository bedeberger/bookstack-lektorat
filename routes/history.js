const express = require('express');
const { db } = require('../db/schema');

const router = express.Router();
const jsonBody = express.json();

// Lektorat-Ergebnis speichern
router.post('/check', jsonBody, (req, res) => {
  const { page_id, page_name, book_id, error_count, errors_json, stilanalyse, fazit, model } = req.body;
  const result = db.prepare(`
    INSERT INTO page_checks (page_id, page_name, book_id, checked_at, error_count, errors_json, stilanalyse, fazit, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    page_id, page_name, book_id,
    new Date().toISOString(),
    error_count || 0,
    JSON.stringify(errors_json || []),
    stilanalyse || null, fazit || null, model || null
  );
  res.json({ id: result.lastInsertRowid });
});

// Lauf als «in BookStack gespeichert» markieren
router.patch('/check/:id/saved', jsonBody, (req, res) => {
  db.prepare('UPDATE page_checks SET saved = 1, saved_at = ? WHERE id = ?')
    .run(new Date().toISOString(), parseInt(req.params.id));
  res.json({ ok: true });
});

// Letzte 20 Läufe für eine Seite
router.get('/page/:page_id', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM page_checks WHERE page_id = ?
    ORDER BY checked_at DESC LIMIT 20`).all(parseInt(req.params.page_id));
  res.json(rows.map(r => ({ ...r, errors_json: JSON.parse(r.errors_json || '[]'), saved: !!r.saved })));
});

// Buchbewertung speichern
router.post('/review', jsonBody, (req, res) => {
  const { book_id, book_name, review_json, model } = req.body;
  const result = db.prepare(`
    INSERT INTO book_reviews (book_id, book_name, reviewed_at, review_json, model)
    VALUES (?, ?, ?, ?, ?)`).run(
    book_id, book_name,
    new Date().toISOString(),
    JSON.stringify(review_json || null),
    model || null
  );
  res.json({ id: result.lastInsertRowid });
});

// Letzte 10 Bewertungen für ein Buch
router.get('/review/:book_id', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM book_reviews WHERE book_id = ?
    ORDER BY reviewed_at DESC LIMIT 10`).all(parseInt(req.params.book_id));
  res.json(rows.map(r => ({ ...r, review_json: JSON.parse(r.review_json || 'null') })));
});

module.exports = router;
