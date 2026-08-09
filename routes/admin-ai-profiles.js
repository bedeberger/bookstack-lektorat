'use strict';
// Admin-CRUD fuer KI-Profile (`ai_profiles`) — benannte Modell-Konfigurationen, die
// im Benutzer-Tab einem User zugewiesen werden (app_users.ai_profile_id).
//
// Ein Profil ueberschreibt punktuell die globalen `ai.<provider>.*`-Settings; jedes
// leer gelassene Feld bleibt global (Aufloesung: lib/ai/profile.js#aiSetting). Genau
// deshalb pruefen die Validierungen hier IMMER den effektiven Wert (Profil ODER
// global) und nicht nur die Profil-Spalte — sonst schlaegt ein Profil fehl, das
// bewusst nur ein anderes Modell auf demselben Host waehlt.

const express = require('express');
const aiProfiles = require('../db/ai-profiles');
const appUsers = require('../db/app-users');
const appSettings = require('../lib/app-settings');
const { requireAdmin } = require('../lib/admin-mw');
const { VALID_PROVIDERS, contextSafetyMargin } = require('../lib/ai');
const logger = require('../logger');

const router = express.Router();
router.use(requireAdmin);

// Effektiver Wert eines Profil-Felds (Profil-Spalte, sonst globales Setting).
function _eff(body, provider, key) {
  const v = body[key];
  if (v !== null && v !== undefined && v !== '') return v;
  return appSettings.get(`ai.${provider}.${key}`);
}

/**
 * Validierung eines eingehenden Profils. Gibt einen `{ error_code, detail }` zurueck
 * oder null.
 *
 * Die Fenster-Pruefung ist die wichtigste: sie ist im Boot-Check von
 * lib/ai/config.js nur fuer die GLOBALEN Keys verdrahtet. Ohne sie koennte ein Profil
 * eine Kombination tragen, bei der das Input-Budget still auf den 2000-Token-Floor
 * kollabiert — die Analyse saehe dann einen Bruchteil des Buchs und meldete trotzdem
 * Erfolg. Hier scheitert es beim Speichern, wo ein Mensch es lesen kann.
 */
function _validate(body, { existing = null } = {}) {
  const name = String(body.name || '').trim();
  if (!name) return { error_code: 'NAME_REQUIRED' };
  if (name.length > 80) return { error_code: 'NAME_TOO_LONG' };

  const provider = String(body.provider || '').toLowerCase();
  if (!VALID_PROVIDERS.has(provider)) return { error_code: 'PROVIDER_INVALID' };

  const dupe = aiProfiles.getProfileByName(name);
  if (dupe && (!existing || dupe.id !== existing.id)) return { error_code: 'NAME_TAKEN' };

  // Lokale/kompatible Endpunkte brauchen einen Host — im Profil oder global.
  if (provider !== 'claude' && !_eff(body, provider, 'host')) {
    return { error_code: 'HOST_REQUIRED' };
  }

  const ctx = parseInt(_eff(body, provider, 'context_window'), 10) || 0;
  const out = parseInt(_eff(body, provider, 'max_tokens_out'), 10) || 0;
  if (ctx && out) {
    const margin = contextSafetyMargin(ctx);
    if (out + margin >= ctx) {
      return {
        error_code: 'CONTEXT_WINDOW_TOO_SMALL',
        detail: { contextWindow: ctx, maxTokensOut: out, margin },
      };
    }
  }

  const temp = body.temperature;
  if (temp !== null && temp !== undefined && temp !== '') {
    const t = Number(temp);
    if (!Number.isFinite(t) || t < 0 || t > 2) return { error_code: 'TEMPERATURE_INVALID' };
  }
  const par = body.max_parallel;
  if (par !== null && par !== undefined && par !== '') {
    const n = parseInt(par, 10);
    if (!Number.isInteger(n) || n < 1 || n > 16) return { error_code: 'MAX_PARALLEL_INVALID' };
  }
  const rp = body.repeat_penalty;
  if (rp !== null && rp !== undefined && rp !== '') {
    const n = Number(rp);
    if (!Number.isFinite(n) || n < 1 || n > 2) return { error_code: 'REPEAT_PENALTY_INVALID' };
  }
  return null;
}

// Liste inkl. Nutzungszahl — der Admin soll vor dem Loeschen sehen, wen es trifft.
router.get('/', (req, res) => {
  const profiles = aiProfiles.listProfiles().map(p => ({
    ...p,
    user_count: aiProfiles.profileUsageCount(p.id),
  }));
  res.json({ profiles });
});

router.post('/', express.json(), (req, res) => {
  const body = req.body || {};
  const bad = _validate(body);
  if (bad) return res.status(400).json(bad);
  try {
    const profile = aiProfiles.createProfile(body, req.session.user.email);
    logger.info(`KI-Profil angelegt: ${profile.name} (${profile.provider})`, { user: req.session.user.email });
    res.json({ profile });
  } catch (e) {
    res.status(400).json({ error_code: 'PROFILE_INVALID', detail: e.message });
  }
});

router.put('/:id', express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = aiProfiles.getProfile(id);
  if (!existing) return res.status(404).json({ error_code: 'PROFILE_NOT_FOUND' });
  const body = { ...req.body };
  // Der PUT ist ein Voll-Update (die Oberflaeche schickt das ganze Formular). Einzige
  // Ausnahme ist der API-Key: fehlt er, bleibt der gespeicherte stehen — die Admin-UI
  // bekommt ihn nie im Klartext zu sehen und koennte ihn gar nicht zuruecksenden.
  if (body.api_key === undefined) body.api_key = '__unchanged__';
  const bad = _validate(body, { existing });
  if (bad) return res.status(400).json(bad);
  try {
    const profile = aiProfiles.updateProfile(id, body);
    logger.info(`KI-Profil geaendert: ${profile.name} (${profile.provider})`, { user: req.session.user.email });
    res.json({ profile });
  } catch (e) {
    res.status(400).json({ error_code: 'PROFILE_INVALID', detail: e.message });
  }
});

// Loeschen haengt die zugewiesenen User ab (FK ON DELETE SET NULL) — sie folgen
// danach wieder dem globalen Provider. Die Zahl kommt in der Antwort mit, damit die
// Oberflaeche es sagen kann, statt es stillschweigend geschehen zu lassen.
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = aiProfiles.getProfile(id);
  if (!existing) return res.status(404).json({ error_code: 'PROFILE_NOT_FOUND' });
  const { deleted, detachedUsers } = aiProfiles.deleteProfile(id);
  logger.info(`KI-Profil geloescht: ${existing.name} (${detachedUsers} User abgehaengt)`, { user: req.session.user.email });
  res.json({ ok: deleted, detachedUsers });
});

// Wer haengt an diesem Profil? Fuer die Loesch-Rueckfrage in der Oberflaeche.
router.get('/:id/users', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!aiProfiles.getProfile(id)) return res.status(404).json({ error_code: 'PROFILE_NOT_FOUND' });
  const users = appUsers.listUsers().filter(u => u.ai_profile_id === id).map(u => u.email);
  res.json({ users });
});

module.exports = router;
