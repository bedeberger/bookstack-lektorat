'use strict';
const express = require('express');
const { db } = require('../db/schema');
const { toIntId, inClause } = require('../lib/validate');
const { aclParamGuard, sessionEmail } = require('../lib/acl');

const router = express.Router();
router.param('book_id', aclParamGuard('editor'));

// Welt-Fakten eines Buchs laden (read-only; Schreibpfad ist die Komplettanalyse).
router.get('/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = sessionEmail(req);

  const rows = db.prepare(`
    SELECT id, kategorie, subjekt, fakt, seite_label, updated_at
    FROM world_facts
    WHERE book_id = ? AND user_email IS ?
    ORDER BY sort_order, id
  `).all(bookId, userEmail);

  if (!rows.length) return res.json({ fakten: [], updated_at: null });

  const factIds = rows.map(r => r.id);
  const { sql: idSql, values: idVals } = inClause(factIds);
  const chRows = db.prepare(`
    SELECT wfc.fact_id, c.chapter_name
    FROM world_fact_chapters wfc
    LEFT JOIN chapters c ON c.chapter_id = wfc.chapter_id
    WHERE wfc.fact_id IN ${idSql}
    ORDER BY wfc.fact_id, wfc.chapter_id
  `).all(...idVals);
  const kapMap = {};
  for (const r of chRows) if (r.chapter_name) (kapMap[r.fact_id] ??= []).push(r.chapter_name);

  const fakten = rows.map(r => ({
    id:        r.id,
    kategorie: r.kategorie,
    subjekt:   r.subjekt,
    fakt:      r.fakt,
    seite:     r.seite_label,
    kapitel:   kapMap[r.id] || [],
  }));
  const updated_at = rows.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), '');

  res.json({ fakten, updated_at: updated_at || null });
});

module.exports = router;
