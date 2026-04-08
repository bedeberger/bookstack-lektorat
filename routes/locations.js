'use strict';
const express = require('express');
const { db, saveOrteToDb } = require('../db/schema');

const router = express.Router();
const jsonBody = express.json();

// Schauplätze eines Buchs laden
router.get('/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const userEmail = req.session?.user?.email || null;

  const rows = db.prepare(`
    SELECT loc_id, name, typ, beschreibung, erste_erwaehnung, stimmung,
           figuren_json, kapitel_json, updated_at
    FROM locations
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order, id
  `).all(bookId, userEmail);

  if (!rows.length) return res.json(null);

  const parseJson = (s) => { try { return JSON.parse(s); } catch { return []; } };

  const orte = rows.map(r => ({
    id:               r.loc_id,
    name:             r.name,
    typ:              r.typ,
    beschreibung:     r.beschreibung,
    erste_erwaehnung: r.erste_erwaehnung,
    stimmung:         r.stimmung,
    figuren:          parseJson(r.figuren_json),
    kapitel:          parseJson(r.kapitel_json),
  }));

  res.json({ orte, updated_at: rows[0]?.updated_at || null });
});

// Schauplätze eines Buchs speichern (überschreibt)
router.put('/:book_id', jsonBody, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  saveOrteToDb(parseInt(req.params.book_id), req.body.orte || [], userEmail);
  res.json({ ok: true });
});

module.exports = router;
