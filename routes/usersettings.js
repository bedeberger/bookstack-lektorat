'use strict';
const express = require('express');
const { getUser, updateUserSettings } = require('../db/schema');

const router = express.Router();
const jsonBody = express.json();

const VALID_LOCALES   = ['de', 'en'];
const VALID_THEMES    = ['auto', 'light', 'dark'];
const VALID_LANGUAGES = ['de', 'en'];
const VALID_REGIONS   = ['CH', 'DE', 'US', 'GB'];
const VALID_BUCHTYPEN = ['roman', 'kurzgeschichten', 'gesellschaft', 'krimi', 'historisch', 'fantasy_scifi', 'erotik', 'jugend', 'autobiografie', 'andere'];

const FIELDS = [
  { key: 'locale',           allowed: VALID_LOCALES,   label: 'locale' },
  { key: 'theme',            allowed: VALID_THEMES,    label: 'theme' },
  { key: 'default_buchtyp',  allowed: VALID_BUCHTYPEN, label: 'default_buchtyp' },
  { key: 'default_language', allowed: VALID_LANGUAGES, label: 'default_language' },
  { key: 'default_region',   allowed: VALID_REGIONS,   label: 'default_region' },
];

/** Aktuelles User-Profil samt Einstellungen. */
router.get('/settings', (req, res) => {
  const email = req.session.user.email;
  const user = getUser(email);
  if (!user) return res.status(404).json({ error: 'Benutzerprofil nicht gefunden.' });
  res.json(user);
});

/** Partielles Update. Nicht übergebene Felder bleiben unverändert;
 *  leerer String oder null setzt das Feld zurück. */
router.patch('/settings', jsonBody, (req, res) => {
  const email = req.session.user.email;
  const existing = getUser(email);
  if (!existing) return res.status(404).json({ error: 'Benutzerprofil nicht gefunden.' });

  const body = req.body || {};

  for (const { key, allowed, label } of FIELDS) {
    if (body[key] === undefined || body[key] === null || body[key] === '') continue;
    if (!allowed.includes(body[key])) {
      return res.status(400).json({ error: `Ungültiger Wert für ${label}. Erlaubt: ${allowed.join(', ')}.` });
    }
  }

  const merged = {};
  for (const { key } of FIELDS) {
    if (body[key] === undefined)           merged[key] = existing[key];
    else if (body[key] === '' || body[key] === null) merged[key] = null;
    else                                   merged[key] = body[key];
  }

  updateUserSettings(email, merged);
  res.json({ ok: true, ...getUser(email) });
});

module.exports = router;
