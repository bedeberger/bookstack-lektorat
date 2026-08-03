'use strict';
// /admin/settings-Endpoints.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tmpDb = path.join(os.tmpdir(), `admin-settings-routes-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-crypto-derive';
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const appSettings = require('../../lib/app-settings');
appUsers.createUser({ email: 'alice@example.com', displayName: 'Alice', globalRole: 'admin' });
appUsers.createUser({ email: 'bob@example.com',   displayName: 'Bob',   globalRole: 'user' });

const express = require('express');
const adminSettingsRouter = require('../../routes/admin-settings');

const app = express();
app.use((req, res, next) => {
  const email = req.headers['x-test-user-email'];
  if (email) {
    req.session = { user: { email, name: email, role: req.headers['x-test-user-role'] || 'user' } };
  } else {
    req.session = {};
  }
  next();
});
app.use('/admin/settings', adminSettingsRouter);

const server = app.listen(0);
const port = server.address().port;

test.after(() => {
  server.close();
  try { db.close(); } catch {}
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
});

function _req(method, urlPath, { user = null, role = 'user', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (user) {
      headers['x-test-user-email'] = user;
      headers['x-test-user-role'] = role;
    }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('GET /admin/settings ohne Login → 401', async () => {
  const r = await _req('GET', '/admin/settings');
  assert.equal(r.status, 401);
});

test('GET /admin/settings als User → 403', async () => {
  const r = await _req('GET', '/admin/settings', { user: 'bob@example.com' });
  assert.equal(r.status, 403);
});

test('GET /admin/settings als Admin → 200 + Liste', async () => {
  const r = await _req('GET', '/admin/settings', { user: 'alice@example.com', role: 'admin' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.settings));
  // Defaults sind enthalten
  const provider = r.body.settings.find(s => s.key === 'ai.provider');
  assert.ok(provider);
  assert.equal(provider.value, 'claude');
});

test('PUT /admin/settings/:key (non-encrypted) → 200 + persistiert', async () => {
  const r = await _req('PUT', '/admin/settings/ai.provider', {
    user: 'alice@example.com', role: 'admin',
    body: { value: 'ollama' },
  });
  assert.equal(r.status, 200);
  assert.equal(appSettings.get('ai.provider'), 'ollama');
});

test('PUT /admin/settings/:key (encrypted) → 200 + maskiert in Response', async () => {
  const r = await _req('PUT', '/admin/settings/ai.claude.api_key', {
    user: 'alice@example.com', role: 'admin',
    body: { value: 'sk-ant-fresh-key-9999' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.value, '__masked__');
  assert.equal(appSettings.get('ai.claude.api_key'), 'sk-ant-fresh-key-9999');
});

test('PUT /admin/settings/:key mit __unchanged__-Sentinel (encrypted) → keine Aenderung', async () => {
  appSettings.set('ai.claude.api_key', 'sk-original-value', { updatedBy: 'test' });
  const r = await _req('PUT', '/admin/settings/ai.claude.api_key', {
    user: 'alice@example.com', role: 'admin',
    body: { value: '__unchanged__' },
  });
  assert.equal(r.status, 200);
  assert.equal(appSettings.get('ai.claude.api_key'), 'sk-original-value');
});

test('DELETE /admin/settings/:key → Default greift', async () => {
  appSettings.set('cron.stale_days', 99, { updatedBy: 'test' });
  const r = await _req('DELETE', '/admin/settings/cron.stale_days', {
    user: 'alice@example.com', role: 'admin',
  });
  assert.equal(r.status, 200);
  assert.equal(appSettings.get('cron.stale_days'), 7); // Default
});

test('PUT ohne value-Feld → 400', async () => {
  const r = await _req('PUT', '/admin/settings/ai.provider', {
    user: 'alice@example.com', role: 'admin',
    body: {},
  });
  assert.equal(r.status, 400);
});

test('PUT /admin/settings/:key mit ungueltigem Range → 400 INVALID_VALUE', async () => {
  const r = await _req('PUT', '/admin/settings/app.page_revision_limit', {
    user: 'alice@example.com', role: 'admin',
    body: { value: -1 },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'INVALID_VALUE');
  assert.equal(r.body.key, 'app.page_revision_limit');
  assert.ok(r.body.reason);
  // DB-Wert blieb auf Default
  assert.equal(appSettings.has('app.page_revision_limit'), false);
});

test('PUT /admin/settings/:key mit ungueltigem Enum → 400', async () => {
  const r = await _req('PUT', '/admin/settings/ai.provider', {
    user: 'alice@example.com', role: 'admin',
    body: { value: 'openai' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'INVALID_VALUE');
});

test('POST /admin/settings/models als User → 403', async () => {
  const r = await _req('POST', '/admin/settings/models', {
    user: 'bob@example.com', body: { target: 'openai-compat' },
  });
  assert.equal(r.status, 403);
});

test('POST /admin/settings/models mit unbekanntem Target → 400', async () => {
  const r = await _req('POST', '/admin/settings/models', {
    user: 'alice@example.com', role: 'admin', body: { target: 'nope' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'UNKNOWN_TARGET');
});

test('POST /admin/settings/models ohne Host → 200 mit ok:false (kein 500)', async () => {
  appSettings.set('image.host', '', { updatedBy: 'test' });
  const r = await _req('POST', '/admin/settings/models', {
    user: 'alice@example.com', role: 'admin', body: { target: 'image' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error_code, 'NO_HOST');
  assert.deepEqual(r.body.models, []);
});

test('GET /admin/settings/:key (encrypted) → maskiert', async () => {
  appSettings.set('ai.claude.api_key', 'sk-ant-secret', { updatedBy: 'test' });
  const r = await _req('GET', '/admin/settings/ai.claude.api_key', {
    user: 'alice@example.com', role: 'admin',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.setting.value, '__masked__');
  assert.match(r.body.setting.masked, /\*\*\*/);
});
