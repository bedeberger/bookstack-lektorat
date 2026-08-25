'use strict';
// Leseweg der Alters-Analyse: GET /figures/:book_id/alter.
//
// EIGENER ROUTER neben routes/figures.js, nicht darin: der Alters-Index ist ein
// abgeleitetes Ergebnis, das die Karte erst beim Oeffnen ihres Reiters braucht.
// Im heissen Pfad GET /figures/:book_id (Katalog, bei jedem Buchwechsel) haetten
// die Belege pro Figur nichts zu suchen.
//
// Die Zeilen sind nach `figures.fig_id` geschluesselt — dieselbe Kennung, die der
// Katalog als `id` nach vorne gibt. Nur daran kann das Frontend die Tabelle an
// die schon geladenen Figuren haengen, ohne einen zweiten Namensvergleich.

const express = require('express');
const { listFigureAges, getFigureAgeScan } = require('../db/figure-ages');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');

const router = express.Router();

// Lesen ab `viewer`: die Frage „wie alt ist die Figur hier" stellt sich beim
// Lektorieren genauso wie beim Schreiben. Der Scan selbst verlangt `editor`
// (routes/jobs/figur-alter.js) — er schreibt einen Index ans Buch.
router.param('book_id', aclParamGuard('viewer'));
router.param('book_id', bookParamHandler);

router.get('/:book_id/alter', (req, res) => {
  const bookId = req.bookId; // aclParamGuard hat Login + Buch-ID schon geprueft
  const userEmail = sessionEmail(req);
  const scan = getFigureAgeScan(bookId, userEmail);
  res.json({
    figuren: listFigureAges(bookId, userEmail),
    scan: scan ? {
      scanned_at: scan.scanned_at,
      figuren_total: scan.figuren_total,
      mit_alter: scan.mit_alter,
      belege_total: scan.belege_total,
      embed_used: !!scan.embed_used,
      model: scan.model,
    } : null,
  });
});

module.exports = router;
