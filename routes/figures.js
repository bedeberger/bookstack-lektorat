const express = require('express');
const { db, saveFigurenToDb } = require('../db/schema');

const router = express.Router();
const jsonBody = express.json();

// Szenen eines Buchs laden (vor /:book_id definiert um Konflikte zu vermeiden)
router.get('/scenes/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const userEmail = req.session?.user?.email || null;

  const rows = db.prepare(`
    SELECT kapitel, seite, titel, wertung, kommentar, fig_ids, updated_at
    FROM figure_scenes
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order
  `).all(bookId, userEmail);

  const szenen = rows.map(s => ({
    kapitel:   s.kapitel,
    seite:     s.seite,
    titel:     s.titel,
    wertung:   s.wertung,
    kommentar: s.kommentar,
    fig_ids:   (() => { try { return JSON.parse(s.fig_ids); } catch { return []; } })(),
  }));

  const updated_at = rows.length ? rows[0].updated_at : null;
  res.json({ szenen, updated_at });
});

// Szenen eines Buchs löschen
router.delete('/scenes/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const userEmail = req.session?.user?.email || null;
  db.prepare('DELETE FROM figure_scenes WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
  res.json({ ok: true });
});

// Gespeicherte Figuren eines Buchs laden
router.get('/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const userEmail = req.session?.user?.email || null;

  const figs = db.prepare(`
    SELECT * FROM figures
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order, id
  `).all(bookId, userEmail);
  if (!figs.length) return res.json(null);

  const tags = db.prepare(`
    SELECT ft.figure_id, ft.tag FROM figure_tags ft
    JOIN figures f ON f.id = ft.figure_id
    WHERE f.book_id = ? AND f.user_email = ?`).all(bookId, userEmail);
  const apps = db.prepare(`
    SELECT fa.figure_id, fa.chapter_name, fa.haeufigkeit FROM figure_appearances fa
    JOIN figures f ON f.id = fa.figure_id
    WHERE f.book_id = ? AND f.user_email = ?`).all(bookId, userEmail);
  const evts = db.prepare(`
    SELECT fe.figure_id, fe.datum, fe.ereignis, fe.bedeutung, fe.typ FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    WHERE f.book_id = ? AND f.user_email = ?
    ORDER BY fe.figure_id, fe.sort_order`).all(bookId, userEmail);
  const rels = db.prepare(
    'SELECT from_fig_id, to_fig_id, typ, beschreibung FROM figure_relations WHERE book_id = ? AND user_email = ?'
  ).all(bookId, userEmail);

  const tagMap = {};
  for (const t of tags) (tagMap[t.figure_id] ??= []).push(t.tag);
  const appMap = {};
  for (const a of apps) (appMap[a.figure_id] ??= []).push({ name: a.chapter_name, haeufigkeit: a.haeufigkeit });
  const evtMap = {};
  for (const e of evts) (evtMap[e.figure_id] ??= []).push({ datum: e.datum, ereignis: e.ereignis, bedeutung: e.bedeutung, typ: e.typ || 'persoenlich' });
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
    lebensereignisse: evtMap[f.id] || [],
    beziehungen: relMap[f.fig_id] || [],
  }));

  res.json({ figuren, updated_at: figs[0]?.updated_at || null });
});

// Figuren eines Buchs speichern (überschreibt)
router.put('/:book_id', jsonBody, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  saveFigurenToDb(parseInt(req.params.book_id), req.body.figuren || [], userEmail);
  res.json({ ok: true });
});


module.exports = router;
