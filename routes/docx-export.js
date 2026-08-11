'use strict';
// Word-Export-Profile (CRUD). Render-Trigger läuft via /jobs/docx-export
// (Job-Queue). Diese Routen verwalten nur Konfiguration. Pendant zu
// routes/pdf-export.js, aber ohne Cover-/Font-Fetch-Endpunkte — DOCX nutzt
// System-Fonts aus einer festen Whitelist; die Titelei-Texte leben buch-weit
// in book_publication (routes/publication.js).

const express = require('express');
const {
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile, setDefault,
} = require('../db/docx-export');
const { defaultConfig, validateConfig, FONT_FAMILIES } = require('../lib/docx-export-defaults');
const { toIntId } = require('../lib/validate');
const logger = require('../logger');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
const jsonBody = express.json({ limit: '256kb' });

const NAME_MAX = 80;
const PROFILE_MAX = 20;

function _user(req) { return sessionEmail(req); }

function _ownedOr404(profile, userEmail) {
  if (!profile) return { error_code: 'PROFILE_NOT_FOUND', status: 404 };
  if (profile.user_email !== userEmail) return { error_code: 'FORBIDDEN', status: 403 };
  return null;
}

// Profile sind user-scoped (bookId=0 → user_default). `?book=X` wird ignoriert.
router.get('/profiles', (req, res) => {
  res.json({ profiles: listProfiles(0, _user(req)) });
});

router.get('/profiles/:id', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getProfile(id);
  const err = _ownedOr404(profile, _user(req));
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  res.json(profile);
});

router.post('/profiles', jsonBody, (req, res) => {
  const userEmail = _user(req);
  const { name, config, clone_from } = req.body || {};
  const safeName = String(name || '').trim().slice(0, NAME_MAX);
  if (!safeName) return res.status(400).json({ error_code: 'NAME_REQUIRED' });

  const existing = listProfiles(0, userEmail);
  if (existing.length >= PROFILE_MAX) {
    return res.status(400).json({ error_code: 'PROFILE_LIMIT_REACHED', params: { max: PROFILE_MAX } });
  }
  if (existing.some(p => p.name === safeName)) {
    return res.status(409).json({ error_code: 'PROFILE_NAME_TAKEN' });
  }

  let cfg;
  if (clone_from) {
    const src = getProfile(toIntId(clone_from));
    if (!src || src.user_email !== userEmail) return res.status(404).json({ error_code: 'CLONE_SOURCE_NOT_FOUND' });
    cfg = validateConfig(src.config);
  } else {
    cfg = validateConfig(config || defaultConfig());
  }

  try {
    const profile = createProfile(0, userEmail, safeName, cfg);
    logger.info(`Word-Export-Profil erstellt: «${safeName}» (id=${profile.id})`);
    res.status(201).json(profile);
  } catch (e) {
    logger.error(`docx-export profile create: ${e.message}`);
    res.status(500).json({ error_code: 'PROFILE_CREATE_FAILED' });
  }
});

router.put('/profiles/:id', jsonBody, (req, res) => {
  const userEmail = _user(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });

  const { name, config } = req.body || {};
  const safeName = name != null ? String(name).trim().slice(0, NAME_MAX) : profile.name;
  if (!safeName) return res.status(400).json({ error_code: 'NAME_REQUIRED' });

  if (safeName !== profile.name) {
    const dups = listProfiles(0, userEmail);
    if (dups.some(p => p.name === safeName && p.id !== id)) {
      return res.status(409).json({ error_code: 'PROFILE_NAME_TAKEN' });
    }
  }

  const updated = updateProfile(id, safeName, validateConfig(config || profile.config));
  res.json(updated);
});

router.delete('/profiles/:id', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getProfile(id);
  const err = _ownedOr404(profile, _user(req));
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  deleteProfile(id);
  res.json({ ok: true });
});

router.post('/profiles/:id/default', (req, res) => {
  const userEmail = _user(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  res.json(setDefault(0, userEmail, id));
});

// Font-Whitelist für den Picker.
router.get('/fonts', (_req, res) => {
  res.json({ fonts: FONT_FAMILIES });
});

module.exports = router;
