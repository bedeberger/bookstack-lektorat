'use strict';
const express = require('express');
const { getUser, updateUserSettings } = require('../db/schema');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

// Audit-Log-Events (UI-Trigger ohne anderen Server-Roundtrip).
// Allowlist verhindert beliebige Logs durch den Client.
const AUDIT_EVENTS = {
  chatOpened:     'Seiten-Chat geöffnet',
  bookChatOpened: 'Buch-Chat geöffnet',
  lektoratOpened: 'Lektorat geöffnet',
};

router.post('/event', jsonBody, (req, res) => {
  const event = String(req.body?.event || '');
  const label = AUDIT_EVENTS[event];
  if (!label) return res.status(400).json({ error_code: 'INVALID_EVENT' });
  const meta = req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : null;
  const suffix = meta
    ? ' ' + Object.entries(meta)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    : '';
  logger.info(`${label}${suffix}`);
  res.json({ ok: true });
});

const VALID_LOCALES   = ['de', 'en'];
const VALID_THEMES    = ['auto', 'light', 'dark'];
const VALID_LANGUAGES = ['de', 'en'];
const VALID_REGIONS   = ['CH', 'DE', 'US', 'GB'];
const VALID_BUCHTYPEN = ['roman', 'kurzgeschichten', 'gesellschaft', 'krimi', 'historisch', 'fantasy_scifi', 'erotik', 'jugend', 'autobiografie', 'andere'];
const VALID_FOCUS_GRANULARITIES = ['paragraph', 'sentence', 'window-3', 'typewriter-only'];

const FIELDS = [
  { key: 'locale',            allowed: VALID_LOCALES,             label: 'locale' },
  { key: 'theme',             allowed: VALID_THEMES,              label: 'theme' },
  { key: 'default_buchtyp',   allowed: VALID_BUCHTYPEN,           label: 'default_buchtyp' },
  { key: 'default_language',  allowed: VALID_LANGUAGES,           label: 'default_language' },
  { key: 'default_region',    allowed: VALID_REGIONS,             label: 'default_region' },
  { key: 'focus_granularity', allowed: VALID_FOCUS_GRANULARITIES, label: 'focus_granularity' },
];

/** Aktuelles User-Profil samt Einstellungen. */
router.get('/settings', (req, res) => {
  const email = req.session.user.email;
  const user = getUser(email);
  if (!user) return res.status(404).json({ error_code: 'USER_PROFILE_NOT_FOUND' });
  res.json(user);
});

/** Partielles Update. Nicht übergebene Felder bleiben unverändert;
 *  leerer String oder null setzt das Feld zurück. */
router.patch('/settings', jsonBody, (req, res) => {
  const email = req.session.user.email;
  const existing = getUser(email);
  if (!existing) return res.status(404).json({ error_code: 'USER_PROFILE_NOT_FOUND' });

  const body = req.body || {};

  for (const { key, allowed, label } of FIELDS) {
    if (body[key] === undefined || body[key] === null || body[key] === '') continue;
    if (!allowed.includes(body[key])) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: label, allowed: allowed.join(', ') } });
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
