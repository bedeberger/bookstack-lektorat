const express = require('express');
const { db, saveFigurenToDb } = require('../db/schema');

const router = express.Router();
const jsonBody = express.json();

// Gespeicherte Figuren eines Buchs laden
router.get('/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const figs = db.prepare('SELECT * FROM figures WHERE book_id = ? ORDER BY sort_order, id').all(bookId);
  if (!figs.length) return res.json(null);

  const tags = db.prepare(`
    SELECT ft.figure_id, ft.tag FROM figure_tags ft
    JOIN figures f ON f.id = ft.figure_id WHERE f.book_id = ?`).all(bookId);
  const apps = db.prepare(`
    SELECT fa.figure_id, fa.chapter_name, fa.haeufigkeit FROM figure_appearances fa
    JOIN figures f ON f.id = fa.figure_id WHERE f.book_id = ?`).all(bookId);
  const rels = db.prepare(
    'SELECT from_fig_id, to_fig_id, typ, beschreibung FROM figure_relations WHERE book_id = ?'
  ).all(bookId);

  const tagMap = {};
  for (const t of tags) (tagMap[t.figure_id] ??= []).push(t.tag);
  const appMap = {};
  for (const a of apps) (appMap[a.figure_id] ??= []).push({ name: a.chapter_name, haeufigkeit: a.haeufigkeit });
  const relMap = {};
  for (const r of rels) (relMap[r.from_fig_id] ??= []).push({ figur_id: r.to_fig_id, typ: r.typ, beschreibung: r.beschreibung });

  const figuren = figs.map(f => ({
    id: f.fig_id,
    name: f.name,
    kurzname: f.kurzname,
    typ: f.typ,
    geburtstag: f.geburtstag,
    geschlecht: f.geschlecht,
    beruf: f.beruf,
    beschreibung: f.beschreibung,
    eigenschaften: tagMap[f.id] || [],
    kapitel: appMap[f.id] || [],
    beziehungen: relMap[f.fig_id] || [],
  }));

  res.json({ figuren, updated_at: figs[0]?.updated_at || null });
});

// Figuren eines Buchs speichern (überschreibt)
router.put('/:book_id', jsonBody, (req, res) => {
  saveFigurenToDb(parseInt(req.params.book_id), req.body.figuren || []);
  res.json({ ok: true });
});

module.exports = router;
