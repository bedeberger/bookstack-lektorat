'use strict';
// lib/model-list.js — Modell-Listen der konfigurierten Hosts (Datenquelle der
// Modell-Combobox in den Admin-Einstellungen). Geprueft werden das Parsen der
// drei Antwort-Schemata, die Host-Normalisierung, der URL-Bau je Host-Art
// (gegen einen lokalen Stub-Server) und die Fehlerpfade — ein toter Host darf
// nicht werfen, sondern muss als { ok: false } zurueckkommen.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tmpDb = path.join(os.tmpdir(), `model-list-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-crypto-derive';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appSettings = require('../../lib/app-settings');
const modelList = require('../../lib/model-list');

// Stub-Host: beantwortet beide Listen-Endpunkte und merkt sich den letzten Pfad.
const seen = { path: null, auth: null };
const stub = http.createServer((req, res) => {
  seen.path = req.url;
  seen.auth = req.headers.authorization || null;
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') {
    res.end(JSON.stringify({ data: [{ id: 'zeta-1' }, { id: 'alpha-2' }] }));
  } else if (req.url === '/api/tags') {
    res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { name: 'mistral' }] }));
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});
stub.listen(0);
const stubUrl = () => `http://127.0.0.1:${stub.address().port}`;

test.after(() => {
  stub.close();
  try { db.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
});

test('parseModels: OpenAI-Schema (data[].id), sortiert + dedupliziert', () => {
  const out = modelList.parseModels('openai', { data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'zeta' }] });
  assert.deepEqual(out, [{ id: 'alpha', label: 'alpha' }, { id: 'zeta', label: 'zeta' }]);
});

test('parseModels: nacktes Array (manche OpenAI-kompatiblen Server)', () => {
  const out = modelList.parseModels('openai', ['b-model', 'a-model']);
  assert.deepEqual(out.map(m => m.id), ['a-model', 'b-model']);
});

test('parseModels: Ollama-Schema (models[].name)', () => {
  const out = modelList.parseModels('ollama', { models: [{ name: 'mistral' }, { name: 'llama3.2' }] });
  assert.deepEqual(out.map(m => m.id), ['llama3.2', 'mistral']);
});

test('parseModels: Anthropic-Schema nutzt display_name als Label', () => {
  const out = modelList.parseModels('anthropic', {
    data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }, { id: 'claude-haiku-4-5' }],
  });
  assert.deepEqual(out, [
    { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
  ]);
});

test('parseModels: leere/kaputte Eintraege fallen raus statt zu werfen', () => {
  const out = modelList.parseModels('openai', { data: [{ id: '' }, null, { id: '  ok  ' }, 42] });
  assert.deepEqual(out.map(m => m.id), ['ok']);
});

test('parseModels: unbekanntes Schema → leere Liste', () => {
  assert.deepEqual(modelList.parseModels('openai', { unexpected: true }), []);
  assert.deepEqual(modelList.parseModels('openai', null), []);
});

test('normalizeHost: trailing Slash und angehaengtes /v1 fallen weg', () => {
  assert.equal(modelList.normalizeHost('http://h:8080/'), 'http://h:8080');
  assert.equal(modelList.normalizeHost('http://h:8080/v1'), 'http://h:8080');
  assert.equal(modelList.normalizeHost('http://h:8080/v1/'), 'http://h:8080');
  assert.equal(modelList.normalizeHost(''), '');
});

test('isKnownTarget: nur die deklarierten Ziele', () => {
  assert.equal(modelList.isKnownTarget('openai-compat'), true);
  assert.equal(modelList.isKnownTarget('embed'), true);
  assert.equal(modelList.isKnownTarget('nope'), false);
  assert.equal(modelList.isKnownTarget('constructor'), false);
});

test('MODEL_TARGETS: jeder Nicht-Anthropic-Eintrag nennt einen bekannten Host-Key', () => {
  for (const [target, cfg] of Object.entries(modelList.MODEL_TARGETS)) {
    if (cfg.kind === 'anthropic') continue;
    assert.ok(cfg.hostKey, `${target} ohne hostKey`);
    assert.ok(appSettings.isKnownKey(cfg.hostKey), `${target}: unbekannter Key ${cfg.hostKey}`);
    if (cfg.keyKey) assert.ok(appSettings.isKnownKey(cfg.keyKey), `${target}: unbekannter Key ${cfg.keyKey}`);
  }
});

test('listModels: unbekanntes Target → UNKNOWN_TARGET', async () => {
  const r = await modelList.listModels('nope');
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'UNKNOWN_TARGET');
});

test('listModels: leerer Host → NO_HOST (kein Request)', async () => {
  appSettings.set('embed.host', '', { updatedBy: 'test' });
  const r = await modelList.listModels('embed');
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'NO_HOST');
});

test('listModels: Host ohne Schema → BAD_HOST', async () => {
  const r = await modelList.listModels('embed', { host: 'localhost:8080' });
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'BAD_HOST');
});

test('listModels: Claude ohne API-Key → NO_API_KEY', async () => {
  appSettings.set('ai.claude.api_key', '', { updatedBy: 'test' });
  const r = await modelList.listModels('claude');
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'NO_API_KEY');
});

test('listModels: OpenAI-Ziel fragt /v1/models und schickt den Bearer', async () => {
  appSettings.set('embed.host', stubUrl(), { updatedBy: 'test' });
  appSettings.set('embed.api_key', 'secret-key', { updatedBy: 'test' });
  const r = await modelList.listModels('embed');
  assert.equal(r.ok, true);
  assert.equal(seen.path, '/v1/models');
  assert.equal(seen.auth, 'Bearer secret-key');
  assert.deepEqual(r.models.map(m => m.id), ['alpha-2', 'zeta-1']);
});

test('listModels: Ollama-Ziel fragt /api/tags', async () => {
  appSettings.set('ai.ollama.host', stubUrl(), { updatedBy: 'test' });
  const r = await modelList.listModels('ollama');
  assert.equal(r.ok, true);
  assert.equal(seen.path, '/api/tags');
  assert.deepEqual(r.models.map(m => m.id), ['llama3.2:latest', 'mistral']);
});

test('listModels: host-Override sticht den gespeicherten Wert', async () => {
  appSettings.set('image.host', 'http://127.0.0.1:1/', { updatedBy: 'test' });
  const r = await modelList.listModels('image', { host: `${stubUrl()}/v1` });
  assert.equal(r.ok, true);
  assert.equal(seen.path, '/v1/models');
});

test('listModels: toter Host wirft nicht, sondern meldet UNREACHABLE', async () => {
  const r = await modelList.listModels('image', { host: 'http://127.0.0.1:1', timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.ok(['UNREACHABLE', 'TIMEOUT'].includes(r.error_code), r.error_code);
  assert.deepEqual(r.models, []);
});

test('listModels: HTTP-Fehler → HTTP_<status>', async () => {
  const r = await modelList.listModels('rerank', { host: `${stubUrl()}/nope` });
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'HTTP_404');
});
