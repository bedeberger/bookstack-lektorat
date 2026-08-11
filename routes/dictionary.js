'use strict';
// User-Custom-Dictionary CRUD fuer LanguageTool-Spellcheck.
//
// GET    /dictionary           -> alle Eintraege des Users
// POST   /dictionary           -> { word, bookId?, lang? } anlegen
// DELETE /dictionary           -> { word, bookId?, lang? } loeschen
//
// Cache-Invalidierung beim Add/Remove ist im DB-Modul user-dictionary.js
// versteckt — Frontend bekommt frische LT-Resultate ab dem naechsten Check.

const express = require('express');
const logger = require('../logger');
const dict = require('../db/user-dictionary');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
const WORD_MAX = 80;

router.get('/', (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'unauthorized' });
  res.json({ entries: dict.listForUser(userEmail) });
});

router.post('/', express.json({ limit: '4kb' }), (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  const word = typeof body.word === 'string' ? body.word.trim() : '';
  if (!word || word.length > WORD_MAX) {
    return res.status(400).json({ error: 'invalid_word', max: WORD_MAX });
  }
  const bookId = toIntId(body.bookId) || 0;
  let lang = typeof body.lang === 'string' && body.lang.trim() ? body.lang.trim() : '*';
  if (lang === 'auto') lang = '*';
  if (bookId) setContext({ book: bookId });
  try {
    dict.add(userEmail, { word, bookId, lang });
    logger.child({ job: 'lt-dict', user: userEmail, book: bookId || '-' }).info(`add "${word}" lang=${lang}`);
    res.json({ ok: true });
  } catch (err) {
    logger.warn(`dictionary add failed: ${err.message}`);
    res.status(500).json({ error: 'add_failed' });
  }
});

router.delete('/', express.json({ limit: '4kb' }), (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  const word = typeof body.word === 'string' ? body.word.trim() : '';
  if (!word) return res.status(400).json({ error: 'missing_word' });
  const bookId = toIntId(body.bookId) || 0;
  const lang = typeof body.lang === 'string' && body.lang.trim() ? body.lang.trim() : '*';
  if (bookId) setContext({ book: bookId });
  const changes = dict.remove(userEmail, { word, bookId, lang });
  res.json({ ok: true, removed: changes });
});

module.exports = router;
