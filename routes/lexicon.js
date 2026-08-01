'use strict';
// Lesepfad der Wortschatz-Analyse. Nur lesend — geschrieben wird ausschliesslich
// im Job (/jobs/lexicon-scan), und zwar als Full-Replace. Es gibt hier bewusst
// kein POST/PUT/DELETE: die Zahlen sind aus dem Buchtext abgeleitet, nicht
// kuratiert. Wer sie ändern will, ändert den Text.
//
// Zugriff ab `viewer`: ein Lektor, der das Buch lesen darf, darf auch seine
// Kennzahlen sehen — sie stehen ohnehin im Text, den er vor sich hat.

const express = require('express');
const lexiconDb = require('../db/lexicon');
const {
  LEXICON_VERSION, MATTR_WINDOW, MTLD_MIN_TOKENS, HEAPS_MIN_TOKENS, HAPAX_LIMIT,
} = require('../lib/lexicon');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError } = require('../lib/acl');

const router = express.Router();

// Die Analyse-Version wird MITGELIEFERT, nicht im Frontend gespiegelt. Genau an
// einer solchen Frontend-Kopie driftet die Stil-Heatmap gegen lib/page-index.js
// (EXPECTED_METRICS_VERSION); dieser Fehler wird hier nicht wiederholt.
// `stale` sagt der Karte, dass die gespeicherte Analyse aus einer älteren
// Rechenregel stammt und ein Scan lohnt.
router.get('/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'viewer'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const stats = lexiconDb.getBookLexicon(bookId);
  const thresholds = {
    version: LEXICON_VERSION,
    mattrWindow: MATTR_WINDOW,
    mtldMinTokens: MTLD_MIN_TOKENS,
    heapsMinTokens: HEAPS_MIN_TOKENS,
    // Deckel der Einmalwort-Liste. Die Karte stellt ihn neben `stats.hapax_listed`,
    // sonst sieht ein Ausschnitt aus wie eine Vollständigkeit.
    hapaxLimit: HAPAX_LIMIT,
  };
  if (!stats) return res.json({ stats: null, terms: [], hapax: [], ngrams: [], peers: null, stale: false, thresholds });

  return res.json({
    stats,
    terms: lexiconDb.listLexiconTerms(bookId),
    // Einmalwörter als eigene Liste, nicht in `terms` gemischt: eigene Auswahlregel,
    // eigener Reiter, und um ein Vielfaches länger als die Lieblingswörter.
    hapax: lexiconDb.listLexiconHapax(bookId),
    ngrams: lexiconDb.listLexiconNgrams(bookId),
    // Vergleichs-Mediane der übrigen Bücher desselben Besitzers — eine nackte
    // Kennzahl ist für den Autor nicht interpretierbar.
    peers: lexiconDb.loadPeerStats(bookId),
    stale: (stats.lexicon_version || 0) !== LEXICON_VERSION,
    thresholds,
  });
});

module.exports = router;
