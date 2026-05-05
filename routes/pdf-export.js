'use strict';
// PDF-Export-Profile (CRUD) + Cover-Upload + Font-Liste.
// Render-Trigger läuft via /jobs/pdf-export (Job-Queue). Diese Routen
// verwalten nur Konfiguration, Cover-Bild und Font-Auswahl.

const express = require('express');
const {
  listPdfExportProfiles, getPdfExportProfile, createPdfExportProfile,
  updatePdfExportProfile, deletePdfExportProfile,
  setPdfExportProfileCover, clearPdfExportProfileCover, getPdfExportProfileCover,
  setPdfExportProfileDefault,
} = require('../db/schema');
const { defaultConfig, validateConfig } = require('../lib/pdf-export-defaults');
const { prepareCover, MAX_INPUT_BYTES } = require('../lib/cover-prepare');
const { listFonts, isAllowed: isFontAllowed, fetchFont } = require('../lib/font-fetch');
const { toIntId } = require('../lib/validate');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json({ limit: '1mb' });
const rawCoverBody = express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_INPUT_BYTES + 1 });

const NAME_MAX = 80;
const PROFILE_MAX_PER_SCOPE = 20;

function _user(req) { return req.session?.user?.email || null; }

function _ownedOr404(profile, userEmail) {
  if (!profile) return { error_code: 'PROFILE_NOT_FOUND', status: 404 };
  if (profile.user_email !== userEmail) return { error_code: 'FORBIDDEN', status: 403 };
  return null;
}

// ── Profile listing & CRUD ──────────────────────────────────────────────────
router.get('/profiles', (req, res) => {
  const userEmail = _user(req);
  const bookId = toIntId(req.query.book) || 0;
  const profiles = listPdfExportProfiles(bookId, userEmail);
  res.json({ profiles });
});

router.get('/profiles/:id', (req, res) => {
  const userEmail = _user(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  res.json(profile);
});

router.post('/profiles', jsonBody, (req, res) => {
  const userEmail = _user(req);
  const { book_id, name, config, clone_from } = req.body || {};
  const bookId = book_id != null ? toIntId(book_id) : 0;
  const safeName = String(name || '').trim().slice(0, NAME_MAX);
  if (!safeName) return res.status(400).json({ error_code: 'NAME_REQUIRED' });

  const existing = listPdfExportProfiles(bookId || 0, userEmail);
  if (existing.length >= PROFILE_MAX_PER_SCOPE) {
    return res.status(400).json({ error_code: 'PROFILE_LIMIT_REACHED', params: { max: PROFILE_MAX_PER_SCOPE } });
  }
  if (existing.some(p => p.name === safeName)) {
    return res.status(409).json({ error_code: 'PROFILE_NAME_TAKEN' });
  }

  let cfg;
  if (clone_from) {
    const src = getPdfExportProfile(toIntId(clone_from));
    if (!src || src.user_email !== userEmail) return res.status(404).json({ error_code: 'CLONE_SOURCE_NOT_FOUND' });
    cfg = validateConfig(src.config);
  } else {
    cfg = validateConfig(config || defaultConfig());
  }

  try {
    const profile = createPdfExportProfile(bookId || 0, userEmail, safeName, cfg);
    res.status(201).json(profile);
  } catch (e) {
    logger.error(`pdf-export profile create: ${e.message}`);
    res.status(500).json({ error_code: 'PROFILE_CREATE_FAILED' });
  }
});

router.put('/profiles/:id', jsonBody, (req, res) => {
  const userEmail = _user(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });

  const { name, config } = req.body || {};
  const safeName = name != null ? String(name).trim().slice(0, NAME_MAX) : profile.name;
  if (!safeName) return res.status(400).json({ error_code: 'NAME_REQUIRED' });

  if (safeName !== profile.name) {
    const dups = listPdfExportProfiles(profile.book_id, userEmail);
    if (dups.some(p => p.name === safeName && p.id !== id)) {
      return res.status(409).json({ error_code: 'PROFILE_NAME_TAKEN' });
    }
  }

  const cfg = validateConfig(config || profile.config);
  // Font-Auswahl gegen Whitelist prüfen, damit das Profil nicht später beim
  // Render scheitert.
  const roles = ['body', 'heading', 'title', 'subtitle', 'byline'];
  for (const r of roles) {
    const f = cfg.font[r];
    if (!isFontAllowed(f.family, f.weight || 400, 'normal')) {
      return res.status(400).json({ error_code: 'FONT_NOT_ALLOWED', params: { role: r, family: f.family, weight: f.weight } });
    }
  }

  const updated = updatePdfExportProfile(id, safeName, cfg);
  res.json(updated);
});

router.delete('/profiles/:id', (req, res) => {
  const userEmail = _user(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  deletePdfExportProfile(id);
  res.json({ ok: true });
});

router.post('/profiles/:id/default', (req, res) => {
  const userEmail = _user(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  const updated = setPdfExportProfileDefault(profile.book_id, userEmail, id);
  res.json(updated);
});

// ── Cover ───────────────────────────────────────────────────────────────────
router.post('/profiles/:id/cover', rawCoverBody, async (req, res) => {
  const userEmail = _user(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error_code: 'COVER_EMPTY' });
  }

  let prepared;
  try {
    prepared = await prepareCover(req.body);
  } catch (e) {
    return res.status(400).json({ error_code: 'COVER_INVALID', params: { reason: e.message } });
  }
  setPdfExportProfileCover(id, prepared.buffer, prepared.mime);
  res.json({ ok: true, mime: prepared.mime, width: prepared.width, height: prepared.height, bytes: prepared.buffer.length });
});

router.delete('/profiles/:id/cover', (req, res) => {
  const userEmail = _user(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  clearPdfExportProfileCover(id);
  res.json({ ok: true });
});

router.get('/profiles/:id/cover', (req, res) => {
  const userEmail = _user(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  const cover = getPdfExportProfileCover(id);
  if (!cover) return res.status(404).json({ error_code: 'NO_COVER' });
  res.setHeader('Content-Type', cover.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(cover.image);
});

// ── Font-Liste (für Picker) ─────────────────────────────────────────────────
router.get('/fonts', (_req, res) => {
  res.json({ fonts: listFonts() });
});

// ── Font-Preview (self-hosted, CSP-konform) ─────────────────────────────────
// Live-Preview im Picker: liefert @font-face-CSS und TTF aus eigenem Origin,
// damit CSP `style-src 'self'` und `font-src 'self'` greifen. Backend nutzt
// denselben Cache wie der Render-Pfad (lib/font-fetch.js).
router.get('/fonts/:family/:weight/preview.css', (req, res) => {
  const family = String(req.params.family || '');
  const weight = parseInt(req.params.weight, 10);
  if (!isFontAllowed(family, weight, 'normal')) {
    return res.status(400).json({ error_code: 'FONT_NOT_ALLOWED' });
  }
  const ttfUrl = `/pdf-export/fonts/${encodeURIComponent(family)}/${weight}/font.ttf`;
  const css = `@font-face{font-family:${JSON.stringify(family)};font-style:normal;font-weight:${weight};font-display:swap;src:url(${JSON.stringify(ttfUrl)}) format("truetype");}`;
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.end(css);
});

router.get('/fonts/:family/:weight/font.ttf', async (req, res) => {
  const family = String(req.params.family || '');
  const weight = parseInt(req.params.weight, 10);
  if (!isFontAllowed(family, weight, 'normal')) {
    return res.status(400).json({ error_code: 'FONT_NOT_ALLOWED' });
  }
  try {
    const buf = await fetchFont(family, weight, 'normal');
    res.setHeader('Content-Type', 'font/ttf');
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.end(buf);
  } catch (e) {
    logger.warn(`font-preview ${family} ${weight}: ${e.message}`);
    res.status(502).json({ error_code: 'FONT_FETCH_FAILED' });
  }
});

module.exports = router;
