'use strict';
// Admin-Routen fuer app_settings. Hinter requireAdmin (lib/admin-mw.js).
//
// Endpoints:
//   GET   /admin/settings           — Liste aller Keys (encrypted maskiert)
//   GET   /admin/settings/:key      — Einzelwert (encrypted maskiert)
//   PUT   /admin/settings/:key      — Update (Sentinel "__unchanged__" fuer
//                                    encrypted ohne Re-Eingabe)
//   DELETE /admin/settings/:key     — Reset auf Default
//   POST  /admin/settings/models   — Modell-Liste eines konfigurierten Hosts
//   POST  /admin/settings/test-provider — 1-Token-Probecall (Latenz + ok)
//   POST  /admin/settings/test-oauth    — Discovery-Doc-Fetch (Format-Check)
//
// Sicherheit: encrypted-Werte verlassen den Server nur als "__masked__" mit
// letzten 4 Zeichen als Hint. Wer den Klartext braucht (Backup, Debug):
// Direkter DB-Zugriff vom Server.

const express = require('express');
const appSettings = require('../lib/app-settings');
const { requireAdmin } = require('../lib/admin-mw');
const modelList = require('../lib/model-list');
const logger = require('../logger');

const router = express.Router();
router.use(requireAdmin);

router.get('/', (req, res) => {
  const items = appSettings.listForAdmin();
  res.json({ settings: items });
});

router.get('/:key', (req, res) => {
  const items = appSettings.listForAdmin();
  const item = items.find(s => s.key === req.params.key);
  if (!item) return res.status(404).json({ error_code: 'KEY_NOT_FOUND' });
  res.json({ setting: item });
});

router.put('/:key', express.json(), (req, res) => {
  const { key } = req.params;
  const body = req.body || {};
  if (!('value' in body)) return res.status(400).json({ error_code: 'VALUE_REQUIRED' });
  if (!appSettings.isKnownKey(key)) return res.status(400).json({ error_code: 'UNKNOWN_KEY', key });
  const updatedBy = req.session.user.email;
  try {
    const stored = appSettings.set(key, body.value, { updatedBy });
    logger.info(`app-settings: ${key} updated`, { user: updatedBy });
    res.json({ ok: true, key, value: appSettings.isEncryptedKey(key) ? '__masked__' : stored });
  } catch (e) {
    if (e.code === 'INVALID_VALUE') {
      logger.warn(`app-settings put ${key} rejected: ${e.reason}`, { user: updatedBy });
      return res.status(400).json({ error_code: 'INVALID_VALUE', key, reason: e.reason });
    }
    logger.error(`app-settings put ${key}: ${e.message}`, { user: updatedBy });
    res.status(500).json({ error_code: 'PUT_FAILED', detail: e.message });
  }
});

router.delete('/:key', (req, res) => {
  const { key } = req.params;
  appSettings.remove(key, { updatedBy: req.session.user.email });
  res.json({ ok: true, key, value: appSettings.get(key) });
});

// POST /admin/settings/test-provider — 1-Token-Probecall.
// Liest aktuellen Provider + Credentials aus app_settings, ruft einen
// minimalen Completion-Call ab. Liefert latency_ms + ok-Flag.
router.post('/test-provider', express.json(), async (req, res) => {
  const provider = appSettings.get('ai.provider');
  const t0 = Date.now();
  try {
    if (provider === 'claude') {
      const key = appSettings.get('ai.claude.api_key');
      if (!key) return res.json({ ok: false, error: 'NO_API_KEY' });
      const model = appSettings.get('ai.claude.model');
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      const ok = resp.ok;
      return res.json({ ok, status: resp.status, provider, model, latency_ms: Date.now() - t0 });
    }
    if (provider === 'ollama') {
      const host = String(appSettings.get('ai.ollama.host') || '').replace(/\/$/, '');
      const r = await fetch(`${host}/api/tags`).catch(() => null);
      return res.json({ ok: !!r?.ok, status: r?.status || 0, provider, latency_ms: Date.now() - t0 });
    }
    if (provider === 'openai-compat') {
      const host = String(appSettings.get('ai.openai-compat.host') || '').replace(/\/$/, '');
      const apiKey = String(appSettings.get('ai.openai-compat.api_key') || '').trim();
      const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
      const r = await fetch(`${host}/v1/models`, { headers }).catch(() => null);
      return res.json({ ok: !!r?.ok, status: r?.status || 0, provider, latency_ms: Date.now() - t0 });
    }
    return res.json({ ok: false, error: 'UNKNOWN_PROVIDER', provider });
  } catch (e) {
    return res.json({ ok: false, error: e.message, latency_ms: Date.now() - t0 });
  }
});

// POST /admin/settings/test-oauth — Discovery-Doc-Fetch (kein voller
// OAuth-Roundtrip; nur Format-Check, dass Client-ID + Discovery-URL klappen).
router.post('/test-oauth', async (req, res) => {
  const clientId = appSettings.get('auth.google.client_id');
  if (!clientId) return res.json({ ok: false, error: 'NO_CLIENT_ID' });
  const t0 = Date.now();
  try {
    const r = await fetch('https://accounts.google.com/.well-known/openid-configuration');
    if (!r.ok) return res.json({ ok: false, status: r.status, latency_ms: Date.now() - t0 });
    const j = await r.json();
    return res.json({ ok: !!j.authorization_endpoint, latency_ms: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: e.message, latency_ms: Date.now() - t0 });
  }
});

// POST /admin/settings/test-languagetool — Health-Probe der konfigurierten
// LanguageTool-URL. Pingt /v2/languages (no-Body, billig); ok wenn 200.
router.post('/test-languagetool', async (req, res) => {
  const enabled = appSettings.get('languagetool.enabled') === true;
  const url = String(appSettings.get('languagetool.url') || '').replace(/\/$/, '').replace(/\/v2$/i, '');
  if (!url) return res.json({ ok: false, error: 'NO_URL' });
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${url}/v2/languages`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return res.json({ ok: false, status: r.status, latency_ms: Date.now() - t0, enabled });
    const j = await r.json().catch(() => null);
    const count = Array.isArray(j) ? j.length : 0;
    return res.json({ ok: true, status: r.status, latency_ms: Date.now() - t0, language_count: count, enabled });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message, latency_ms: Date.now() - t0, enabled });
  }
});

// POST /admin/settings/test-stt — Health-Probe des konfigurierten Whisper-
// Hosts. Pingt /v1/models (billig, no-Body) mit optionalem Bearer; ok wenn 200.
router.post('/test-stt', async (req, res) => {
  const enabled = appSettings.get('stt.enabled') === true;
  const host = String(appSettings.get('stt.host') || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!host) return res.json({ ok: false, error: 'NO_HOST', enabled });
  const apiKey = String(appSettings.get('stt.api_key') || '').trim();
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${host}/v1/models`, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    return res.json({ ok: !!r.ok, status: r.status, latency_ms: Date.now() - t0, enabled });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message, latency_ms: Date.now() - t0, enabled });
  }
});

// POST /admin/settings/test-tts — Health-Probe des konfigurierten Speech-
// Hosts. Pingt /v1/models (billig, no-Body) mit optionalem Bearer; ok wenn 200.
router.post('/test-tts', async (req, res) => {
  const enabled = appSettings.get('tts.enabled') === true;
  const host = String(appSettings.get('tts.host') || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!host) return res.json({ ok: false, error: 'NO_HOST', enabled });
  const apiKey = String(appSettings.get('tts.api_key') || '').trim();
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${host}/v1/models`, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    return res.json({ ok: !!r.ok, status: r.status, latency_ms: Date.now() - t0, enabled });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message, latency_ms: Date.now() - t0, enabled });
  }
});

// POST /admin/settings/test-image — Health-Probe des konfigurierten Bild-
// Endpunkts. Pingt /v1/models (billig, no-Body) mit optionalem Bearer; ok wenn 200.
router.post('/test-image', async (req, res) => {
  const enabled = appSettings.get('image.enabled') === true;
  const host = String(appSettings.get('image.host') || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!host) return res.json({ ok: false, error: 'NO_HOST', enabled });
  const apiKey = String(appSettings.get('image.api_key') || '').trim();
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${host}/v1/models`, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    return res.json({ ok: !!r.ok, status: r.status, latency_ms: Date.now() - t0, enabled });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message, latency_ms: Date.now() - t0, enabled });
  }
});

// POST /admin/settings/test-embed — Health-Probe des Embedding-Endpunkts.
// Embeddet einen Mini-String und meldet die tatsächlich gelieferte Dimension
// (Sanity gegen die konfigurierte embed.dim). ok wenn ein Vektor zurückkommt.
router.post('/test-embed', async (req, res) => {
  const embed = require('../lib/embed');
  const enabled = appSettings.get('embed.enabled') === true;
  const { host, dim: cfgDim } = embed.getConfig();
  if (!host) return res.json({ ok: false, error: 'NO_HOST', enabled });
  const t0 = Date.now();
  try {
    const vec = await embed.embedOne('Testsatz für die semantische Suche.');
    const dim = vec ? vec.length : 0;
    return res.json({ ok: dim > 0, dim, configured_dim: cfgDim, dim_mismatch: dim > 0 && dim !== cfgDim, latency_ms: Date.now() - t0, enabled });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message, latency_ms: Date.now() - t0, enabled });
  }
});

// POST /admin/settings/test-rerank — Health-Probe des Reranker-Endpunkts.
// Rerankt zwei Mini-Dokumente gegen eine Anfrage und meldet, ob eine sortierte
// Score-Liste zurückkommt. ok wenn >=1 Treffer.
router.post('/test-rerank', async (req, res) => {
  const rerank = require('../lib/rerank');
  const enabled = appSettings.get('rerank.enabled') === true;
  const { host } = rerank.getConfig();
  if (!host) return res.json({ ok: false, error: 'NO_HOST', enabled });
  const t0 = Date.now();
  try {
    const order = await rerank.rerank('Abschied am Bahnhof', [
      'Sie standen am Gleis und winkten dem Zug nach.',
      'Das Rezept braucht drei Eier und Mehl.',
    ]);
    const ok = Array.isArray(order) && order.length > 0;
    return res.json({ ok, count: order.length, latency_ms: Date.now() - t0, enabled });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message, latency_ms: Date.now() - t0, enabled });
  }
});

// POST /admin/settings/test-geocode — Health-Probe der konfigurierten
// Geocoding-Quelle. Fragt eine bekannte Stadt ab; ok wenn >=1 Treffer.
router.post('/test-geocode', async (req, res) => {
  const provider = appSettings.get('geocode.provider') === 'photon' ? 'photon' : 'nominatim';
  const t0 = Date.now();
  try {
    let url;
    if (provider === 'photon') {
      const base = String(appSettings.get('geocode.photon.url') || '')
        .replace(/\/+$/, '')
        .replace(/\/api$/i, '');
      if (!base) return res.json({ ok: false, error: 'NO_URL', provider });
      url = `${base}/api?q=Z%C3%BCrich&limit=1&lang=de`;
    } else {
      const base = String(appSettings.get('geocode.nominatim.url') || 'https://nominatim.openstreetmap.org/search');
      url = `${base}?q=Z%C3%BCrich&format=jsonv2&limit=1`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Schreibwerkstatt/1.0 (self-hosted book tool)', 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return res.json({ ok: false, status: r.status, provider, latency_ms: Date.now() - t0 });
    const j = await r.json().catch(() => null);
    const count = provider === 'photon'
      ? (Array.isArray(j?.features) ? j.features.length : 0)
      : (Array.isArray(j) ? j.length : 0);
    return res.json({ ok: count > 0, status: r.status, provider, result_count: count, latency_ms: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message, provider, latency_ms: Date.now() - t0 });
  }
});

// POST /admin/settings/test-tiles — Health-Probe des konfigurierten Tile-Servers.
// Laedt die Welt-Kachel z/x/y = 0/0/0 (existiert auf jedem OSM-kompatiblen
// Server) und prueft Status + image/*-Content-Type. {s}/{r} (Subdomain/Retina)
// werden auf konkrete Werte ersetzt.
router.post('/test-tiles', async (req, res) => {
  const tmpl = String(appSettings.get('geocode.tiles.url') || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
  const url = tmpl
    .replace(/\{s\}/g, 'a').replace(/\{r\}/g, '')
    .replace(/\{z\}/g, '0').replace(/\{x\}/g, '0').replace(/\{y\}/g, '0');
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Schreibwerkstatt/1.0 (self-hosted book tool)' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    await r.arrayBuffer().catch(() => {}); // Body draenen → Socket freigeben
    const ctype = r.headers.get('content-type') || '';
    const latency_ms = Date.now() - t0;
    if (!r.ok) return res.json({ ok: false, error: `HTTP_${r.status}`, status: r.status, latency_ms });
    if (!ctype.startsWith('image/')) return res.json({ ok: false, error: 'NOT_IMAGE', content_type: ctype, latency_ms });
    return res.json({ ok: true, status: r.status, content_type: ctype, latency_ms });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message, latency_ms: Date.now() - t0 });
  }
});

// POST /admin/settings/models { target, host? } — Modell-Liste des zum Target
// gehoerenden Hosts (Anthropic /v1/models, Ollama /api/tags, sonst
// OpenAI-kompatibles /v1/models). Fuellt die Modell-Combobox in den
// Settings-Feldern; `host` uebersteuert den gespeicherten Wert, damit ein
// gerade eingetippter, noch nicht gespeicherter Host schon abgefragt werden
// kann (Schluessel kommt immer aus app_settings — Secrets verlassen den
// Server nie und kommen daher auch nicht zurueck).
// Unerreichbarer Host ist kein Fehler der Route: 200 mit ok:false.
router.post('/models', express.json(), async (req, res) => {
  const target = String(req.body?.target || '');
  if (!modelList.isKnownTarget(target)) {
    return res.status(400).json({ error_code: 'UNKNOWN_TARGET', target });
  }
  const host = String(req.body?.host || '').slice(0, 500);
  const t0 = Date.now();
  const r = await modelList.listModels(target, { host });
  return res.json({ ...r, target, latency_ms: Date.now() - t0 });
});

// POST /admin/settings/smtp/test-send { to? } — sendet ein 'test'-Template
// an `to` (Default: Gmail-User des Mailers). Liefert { ok, latencyMs, error? }.
router.post('/smtp/test-send', express.json(), async (req, res) => {
  const mailer = require('../lib/mailer');
  const status = mailer.getStatus();
  const to = (req.body?.to || status.fromEmail || '').trim();
  if (!to) return res.json({ ok: false, error: 'NO_RECIPIENT' });
  if (!status.ready) {
    return res.json({ ok: false, error: 'INCOMPLETE_CONFIG', missing: status.missing });
  }
  const r = await mailer.send({
    to,
    template: 'test',
    ctx: { mode: status.mode, fromEmail: status.fromEmail },
    locale: 'de',
  });
  if (r.sent) {
    logger.info(`smtp/test-send: ok to=${to} latency=${r.latencyMs}ms`, { user: req.session.user.email });
    return res.json({ ok: true, latency_ms: r.latencyMs });
  }
  return res.json({ ok: false, error: r.reason, missing: r.missing, detail: r.error });
});

module.exports = router;
