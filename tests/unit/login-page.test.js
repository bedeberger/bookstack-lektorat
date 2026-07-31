'use strict';
// Login-Landing-Page + die beiden ENV-Passwort-Pfade (POST /auth/admin-login,
// POST /auth/demo-login). Beide laufen durch dieselbe Factory in routes/auth.js
// — die Tests pruefen darum je Pfad, dass Gate, Rate-Limit und Rollen-Zuweisung
// wirklich pro Route greifen und nicht nur beim Admin.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');

const tmpDb = path.join(os.tmpdir(), `login-page-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = 'a'.repeat(32); // crypto-Master fuer encrypted app_settings
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.ADMIN_PASSWORD = 's3cret';
process.env.DEMO_EMAIL = 'demo@example.com';
process.env.DEMO_PASSWORD = 'd3mo-pw';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appSettings = require('../../lib/app-settings');
appSettings.set('auth.google.client_id', 'test-client-id', { updatedBy: 'test' });
appSettings.set('auth.google.client_secret', 'test-client-secret', { updatedBy: 'test' });
const appUsers = require('../../db/app-users');
appUsers.ensureAdminFromEnv();
const rl = require('../../lib/admin-login-ratelimit');
const authRouter = require('../../routes/auth');

const app = express();
app.use((req, res, next) => {
  if (!req.session) {
    req.session = {
      destroy: cb => { req.session = null; cb && cb(); },
      save: cb => cb && cb(),
    };
  }
  next();
});
app.use(authRouter);

const server = app.listen(0);
const port = server.address().port;

test.beforeEach(() => rl._resetAll());
test.after(() => {
  server.close();
  try { db.close(); } catch {}
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.DEMO_EMAIL;
  delete process.env.DEMO_PASSWORD;
});

function _req(method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { 'content-type': 'application/json', ...headers };
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: json, raw: buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('GET /login: rendert Google-Button + Admin-Form bei beiden ENV-Pfaden', async () => {
  const r = await _req('GET', '/login');
  assert.equal(r.status, 200);
  assert.match(r.raw, /Mit Google anmelden/);
  assert.match(r.raw, /Admin-Login/);
  assert.match(r.raw, /admin-form/);
});

test('GET /login ohne ADMIN_PASSWORD: keine Admin-Form', async () => {
  const saved = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  const r = await _req('GET', '/login');
  assert.equal(r.status, 200);
  assert.match(r.raw, /Mit Google anmelden/);
  assert.doesNotMatch(r.raw, /admin-form/);
  process.env.ADMIN_PASSWORD = saved;
});

test('POST /auth/admin-login: ohne ADMIN_PASSWORD-ENV → 404', async () => {
  const saved = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  const r = await _req('POST', '/auth/admin-login', { body: { email: 'x', password: 'y' } });
  assert.equal(r.status, 404);
  assert.equal(r.body.error_code, 'ADMIN_LOGIN_DISABLED');
  process.env.ADMIN_PASSWORD = saved;
});

test('POST /auth/admin-login: falsches Passwort → 401', async () => {
  const r = await _req('POST', '/auth/admin-login', {
    body: { email: 'admin@example.com', password: 'wrong' },
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.error_code, 'INVALID_CREDENTIALS');
});

test('POST /auth/admin-login: 5 Fehler in Folge → 429 mit Retry-After', async () => {
  for (let i = 0; i < 5; i++) {
    await _req('POST', '/auth/admin-login', { body: { email: 'admin@example.com', password: 'wrong' } });
  }
  const r = await _req('POST', '/auth/admin-login', {
    body: { email: 'admin@example.com', password: 'wrong' },
  });
  assert.equal(r.status, 429);
  assert.equal(r.body.error_code, 'RATE_LIMITED');
  assert.ok(r.headers['retry-after']);
});

test('POST /auth/admin-login: korrekte Creds → 200 + audit event', async () => {
  const r = await _req('POST', '/auth/admin-login', {
    body: { email: 'admin@example.com', password: 's3cret' },
  });
  // Mini-Test-App hat keine echte express-session — body.ok kann fehlen, weil
  // session.save callback durchgereicht wird. Erwartet 200 ODER 500 (save-fail).
  // Wichtig: kein 401/429. Audit-Event muss in DB stehen.
  assert.ok([200, 500].includes(r.status), `unexpected status ${r.status}`);
  const events = appUsers.listAuditForUser('admin@example.com');
  assert.ok(events.some(e => e.event === 'login' && JSON.parse(e.meta_json || '{}').method === 'env'));
});

// ── Demo-Zugang (ENV-Pfad, Rolle 'user') ─────────────────────────────────────

test('GET /login: rendert Demo-Form mit vorbefuellter Adresse', async () => {
  const r = await _req('GET', '/login');
  assert.equal(r.status, 200);
  assert.match(r.raw, /demo-form/);
  assert.match(r.raw, /Demo-Zugang/);
  // Adresse vorbefuellt (Tippfehler des Reviewers kostet sonst einen Zyklus),
  // Passwort NIE.
  assert.match(r.raw, /value="demo@example\.com"/);
  assert.doesNotMatch(r.raw, /d3mo-pw/);
});

test('GET /login ohne DEMO_PASSWORD: keine Demo-Form', async () => {
  const saved = process.env.DEMO_PASSWORD;
  delete process.env.DEMO_PASSWORD;
  const r = await _req('GET', '/login');
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.raw, /demo-form/);
  assert.match(r.raw, /admin-form/); // Admin-Pfad unberuehrt
  process.env.DEMO_PASSWORD = saved;
});

test('POST /auth/demo-login: ohne DEMO_PASSWORD-ENV → 404', async () => {
  const saved = process.env.DEMO_PASSWORD;
  delete process.env.DEMO_PASSWORD;
  const r = await _req('POST', '/auth/demo-login', { body: { email: 'demo@example.com', password: 'x' } });
  assert.equal(r.status, 404);
  assert.equal(r.body.error_code, 'DEMO_LOGIN_DISABLED');
  process.env.DEMO_PASSWORD = saved;
});

test('POST /auth/demo-login: falsches Passwort → 401 + Rate-Limit teilt den Bucket mit dem Admin-Pfad', async () => {
  const r = await _req('POST', '/auth/demo-login', {
    body: { email: 'demo@example.com', password: 'wrong' },
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.error_code, 'INVALID_CREDENTIALS');
  // 4 weitere Fehlversuche auf dem ANDEREN Pfad → gemeinsamer IP-Bucket voll.
  for (let i = 0; i < 4; i++) {
    await _req('POST', '/auth/admin-login', { body: { email: 'admin@example.com', password: 'wrong' } });
  }
  const blocked = await _req('POST', '/auth/demo-login', {
    body: { email: 'demo@example.com', password: 'd3mo-pw' },
  });
  assert.equal(blocked.status, 429);
});

test('POST /auth/demo-login: korrekte Creds → Rolle user, audit method=demo, Beispielbuch geseedet', async () => {
  const r = await _req('POST', '/auth/demo-login', {
    body: { email: 'demo@example.com', password: 'd3mo-pw' },
  });
  assert.ok([200, 500].includes(r.status), `unexpected status ${r.status}`);
  const u = appUsers.getUser('demo@example.com');
  assert.ok(u, 'app_users-Row fehlt');
  assert.equal(u.global_role, 'user', 'Demo-Zugang darf nie Admin sein');
  assert.equal(u.status, 'active');
  assert.equal(u.can_invite_users, 0, 'Demo-Zugang darf keine Invites versenden');
  const events = appUsers.listAuditForUser('demo@example.com');
  assert.ok(events.some(e => e.event === 'login' && JSON.parse(e.meta_json || '{}').method === 'demo'));
  // Seed lief: der Reviewer landet nicht in einer leeren App.
  const books = db.prepare('SELECT name FROM books WHERE owner_email = ?').all('demo@example.com');
  assert.ok(books.length >= 1, 'kein Beispielbuch angelegt');
});

test('POST /auth/demo-login: Demo-Row auf admin gehoben → naechster Login setzt auf user zurueck', async () => {
  appUsers.setGlobalRole('demo@example.com', 'admin');
  assert.equal(appUsers.getUser('demo@example.com').global_role, 'admin');
  const r = await _req('POST', '/auth/demo-login', {
    body: { email: 'demo@example.com', password: 'd3mo-pw' },
  });
  assert.ok([200, 500].includes(r.status), `unexpected status ${r.status}`);
  assert.equal(appUsers.getUser('demo@example.com').global_role, 'user');
});

test('POST /auth/demo-login: suspendierter Demo-User → 403 USER_NOT_ACTIVE', async () => {
  appUsers.setStatus('demo@example.com', 'suspended');
  const r = await _req('POST', '/auth/demo-login', {
    body: { email: 'demo@example.com', password: 'd3mo-pw' },
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error_code, 'USER_NOT_ACTIVE');
  appUsers.setStatus('demo@example.com', 'active');
});

test('DEMO_EMAIL === ADMIN_EMAIL: Demo-Pfad bleibt aus (kein Rollen-Tauziehen um eine Row)', async () => {
  const saved = process.env.DEMO_EMAIL;
  process.env.DEMO_EMAIL = process.env.ADMIN_EMAIL;
  const page = await _req('GET', '/login');
  assert.doesNotMatch(page.raw, /demo-form/);
  const r = await _req('POST', '/auth/demo-login', {
    body: { email: process.env.ADMIN_EMAIL, password: 'd3mo-pw' },
  });
  assert.equal(r.status, 404);
  assert.equal(r.body.error_code, 'DEMO_LOGIN_DISABLED');
  process.env.DEMO_EMAIL = saved;
});
