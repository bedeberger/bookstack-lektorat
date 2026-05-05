'use strict';
const express = require('express');
const { db, saveOrteToDb } = require('../db/schema');
const { toIntId, inClause } = require('../lib/validate');

const router = express.Router();
const jsonBody = express.json();

// Schauplätze eines Buchs laden
router.get('/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;

  const rows = db.prepare(`
    SELECT id, loc_id, name, typ, beschreibung, erste_erwaehnung, erste_erwaehnung_page_id, stimmung,
           updated_at
    FROM locations
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order, id
  `).all(bookId, userEmail);

  if (!rows.length) return res.json(null);

  const locIds = rows.map(r => r.id);
  const { sql: locSql, values: locVals } = inClause(locIds);

  const lfRows = db.prepare(`SELECT location_id, fig_id FROM location_figures WHERE location_id IN ${locSql}`).all(...locVals);
  const figMap = {};
  for (const lf of lfRows) (figMap[lf.location_id] ??= []).push(lf.fig_id);

  const lcRows = db.prepare(`
    SELECT lc.location_id, lc.chapter_id, c.chapter_name, lc.haeufigkeit
    FROM location_chapters lc
    LEFT JOIN chapters c ON c.chapter_id = lc.chapter_id
    WHERE lc.location_id IN ${locSql}
    ORDER BY lc.haeufigkeit DESC
  `).all(...locVals);
  const kapMap = {};
  for (const lc of lcRows) (kapMap[lc.location_id] ??= []).push({ chapter_id: lc.chapter_id, name: lc.chapter_name, haeufigkeit: lc.haeufigkeit });

  const orte = rows.map(r => ({
    id:                       r.loc_id,
    name:                     r.name,
    typ:                      r.typ,
    beschreibung:             r.beschreibung,
    erste_erwaehnung:         r.erste_erwaehnung,
    erste_erwaehnung_page_id: r.erste_erwaehnung_page_id || null,
    stimmung:                 r.stimmung,
    figuren:                  figMap[r.id] || [],
    kapitel:                  kapMap[r.id] || [],
  }));

  res.json({ orte, updated_at: rows[0]?.updated_at || null });
});

// Schauplätze eines Buchs speichern (überschreibt)
router.put('/:book_id', jsonBody, (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  saveOrteToDb(bookId, req.body.orte || [], userEmail);
  res.json({ ok: true });
});

module.exports = router;
