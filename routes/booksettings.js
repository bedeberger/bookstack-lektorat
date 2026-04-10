'use strict';
const express = require('express');
const { getBookSettings, saveBookSettings } = require('../db/schema');

const router = express.Router();
const jsonBody = express.json();

const VALID_LANGUAGES = ['de', 'en'];
const VALID_REGIONS   = ['CH', 'DE', 'US', 'GB'];

/** Gibt Sprache + Region für ein Buch zurück. */
router.get('/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  if (!bookId) return res.status(400).json({ error: 'Ungültige book_id.' });
  const settings = getBookSettings(bookId);
  res.json(settings);
});

/** Speichert Sprache + Region für ein Buch. */
router.put('/:book_id', jsonBody, (req, res) => {
  const bookId = parseInt(req.params.book_id);
  if (!bookId) return res.status(400).json({ error: 'Ungültige book_id.' });

  const { language, region } = req.body || {};
  if (!language || !region) {
    return res.status(400).json({ error: 'language und region sind Pflichtfelder.' });
  }
  if (!VALID_LANGUAGES.includes(language)) {
    return res.status(400).json({ error: `Ungültige Sprache. Erlaubt: ${VALID_LANGUAGES.join(', ')}.` });
  }
  if (!VALID_REGIONS.includes(region)) {
    return res.status(400).json({ error: `Ungültige Region. Erlaubt: ${VALID_REGIONS.join(', ')}.` });
  }

  saveBookSettings(bookId, language, region);
  res.json({ ok: true, language, region, locale: `${language}-${region}` });
});

module.exports = router;
