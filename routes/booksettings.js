'use strict';
const express = require('express');
const { getBookSettings, saveBookSettings } = require('../db/schema');

const router = express.Router();
const jsonBody = express.json();

const VALID_LANGUAGES = ['de', 'en'];
const VALID_REGIONS   = ['CH', 'DE', 'US', 'GB'];
const VALID_BUCHTYPEN = ['roman', 'kurzgeschichten', 'gesellschaft', 'krimi', 'historisch', 'fantasy_scifi', 'erotik', 'jugend', 'autobiografie', 'andere'];
const BUCH_KONTEXT_MAX = 1000;

/** Gibt Sprache, Region, Buchtyp und Buchkontext für ein Buch zurück. */
router.get('/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  if (!bookId) return res.status(400).json({ error: 'Ungültige book_id.' });
  const settings = getBookSettings(bookId);
  res.json(settings);
});

/** Speichert Sprache, Region, Buchtyp und Buchkontext für ein Buch. */
router.put('/:book_id', jsonBody, (req, res) => {
  const bookId = parseInt(req.params.book_id);
  if (!bookId) return res.status(400).json({ error: 'Ungültige book_id.' });

  const { language, region, buchtyp, buch_kontext } = req.body || {};
  if (!language || !region) {
    return res.status(400).json({ error: 'language und region sind Pflichtfelder.' });
  }
  if (!VALID_LANGUAGES.includes(language)) {
    return res.status(400).json({ error: `Ungültige Sprache. Erlaubt: ${VALID_LANGUAGES.join(', ')}.` });
  }
  if (!VALID_REGIONS.includes(region)) {
    return res.status(400).json({ error: `Ungültige Region. Erlaubt: ${VALID_REGIONS.join(', ')}.` });
  }
  if (buchtyp && !VALID_BUCHTYPEN.includes(buchtyp)) {
    return res.status(400).json({ error: `Ungültiger Buchtyp. Erlaubt: ${VALID_BUCHTYPEN.join(', ')}.` });
  }
  if (buch_kontext && buch_kontext.length > BUCH_KONTEXT_MAX) {
    return res.status(400).json({ error: `Buchkontext zu lang (max. ${BUCH_KONTEXT_MAX} Zeichen).` });
  }

  saveBookSettings(bookId, language, region, buchtyp || null, buch_kontext || null);
  res.json({ ok: true, language, region, buchtyp: buchtyp || null, buch_kontext: buch_kontext || null, locale: `${language}-${region}` });
});

module.exports = router;
