'use strict';
// Demo-Zugang: ENV-Gate, app_users-Row und die fixen Device-Tokens
// (lib/demo-user.js). Der Login selbst liegt in tests/unit/login-page.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Eigene Test-DB pro Lauf (Statement-Cache-Kollision bei paralleler Suite).
const tmp = path.join('/tmp', `demo-user-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

require('../../db/schema'); // Connection + Migrationen
const appUsers = require('../../db/app-users');
const deviceTokens = require('../../db/device-tokens');
const { tryDeviceAuth } = require('../../lib/device-auth');
const demoUser = require('../../lib/demo-user');

const DEMO = 'demo@x.test';
const TOK_NATIVE = 'swd_' + '1'.repeat(64);
const TOK_CAPTURE = 'swd_' + '2'.repeat(64);

function setEnv({ email = DEMO, password = 'pw', device, capture, admin } = {}) {
  if (email) process.env.DEMO_EMAIL = email; else delete process.env.DEMO_EMAIL;
  if (password) process.env.DEMO_PASSWORD = password; else delete process.env.DEMO_PASSWORD;
  if (device) process.env.DEMO_DEVICE_TOKEN = device; else delete process.env.DEMO_DEVICE_TOKEN;
  if (capture) process.env.DEMO_CAPTURE_TOKEN = capture; else delete process.env.DEMO_CAPTURE_TOKEN;
  if (admin) process.env.ADMIN_EMAIL = admin; else delete process.env.ADMIN_EMAIL;
}

function fakeReq(token) {
  return { headers: { authorization: `Bearer ${token}` }, ip: '127.0.0.1' };
}

test.beforeEach(() => setEnv());
test.after(() => {
  setEnv({ email: null, password: null });
  delete process.env.ADMIN_EMAIL;
});

test('isEnabled: nur mit beiden ENV-Werten', () => {
  setEnv();
  assert.equal(demoUser.isEnabled(), true);
  setEnv({ password: null });
  assert.equal(demoUser.isEnabled(), false);
  setEnv({ email: null });
  assert.equal(demoUser.isEnabled(), false);
});

test('isEnabled: DEMO_EMAIL === ADMIN_EMAIL → aus (kein Rollen-Tauziehen um eine Row)', () => {
  setEnv({ admin: DEMO });
  assert.equal(demoUser.isEnabled(), false);
  // Gross-/Kleinschreibung darf den Guard nicht umgehen.
  setEnv({ admin: DEMO.toUpperCase() });
  assert.equal(demoUser.isEnabled(), false);
});

test('ensureDemoAccess: legt User mit Rolle user an und registriert beide Token-Slots', () => {
  setEnv({ device: TOK_NATIVE, capture: TOK_CAPTURE });
  const r = demoUser.ensureDemoAccess();
  assert.equal(r.tokens.length, 2);

  const u = appUsers.getUser(DEMO);
  assert.equal(u.global_role, 'user');
  assert.equal(u.can_invite_users, 0);

  // Beide Tokens authentisieren — und tragen die Scopes ihrer Art.
  const nativeAuth = tryDeviceAuth(fakeReq(TOK_NATIVE));
  assert.equal(nativeAuth.email, DEMO);
  assert.equal(nativeAuth.scopes, 'content:read,content:write');

  const captureAuth = tryDeviceAuth(fakeReq(TOK_CAPTURE));
  assert.equal(captureAuth.email, DEMO);
  assert.equal(captureAuth.scopes, 'content:read,capture:write');
});

test('ensureDemoAccess: zweiter Lauf (Serverneustart) legt keine Duplikate an', () => {
  setEnv({ device: TOK_NATIVE, capture: TOK_CAPTURE });
  demoUser.ensureDemoAccess();
  demoUser.ensureDemoAccess();
  assert.equal(deviceTokens.listDeviceTokens(DEMO).length, 2);
});

test('ensureDemoTokens: ungueltiges Format wird NICHT registriert (fail closed)', () => {
  setEnv({ device: 'swd_test' });
  const done = demoUser.ensureDemoTokens();
  assert.equal(done.length, 0);
  assert.equal(deviceTokens.findActiveTokenByPlain('swd_test'), null);
});

test('ensureDemoTokens: derselbe Wert in beiden Slots → zweiter wird abgelehnt', () => {
  // Sonst trifft der zweite Upsert dieselbe Row (token_hash ist UNIQUE) und
  // ueberschreibt die Scopes des ersten — der native Client verlöre content:write.
  const shared = 'swd_' + '3'.repeat(64);
  setEnv({ device: shared, capture: shared });
  const done = demoUser.ensureDemoTokens();
  assert.equal(done.length, 1);
  assert.equal(done[0].env, 'DEMO_DEVICE_TOKEN');
  assert.equal(tryDeviceAuth(fakeReq(shared)).scopes, 'content:read,content:write');
});

test('ensureDemoAccess: suspendierter Demo-User → keine Tokens', () => {
  setEnv({ device: TOK_NATIVE });
  demoUser.ensureDemoAccess();
  appUsers.setStatus(DEMO, 'suspended');
  const r = demoUser.ensureDemoAccess();
  assert.equal(r.tokens.length, 0);
  appUsers.setStatus(DEMO, 'active');
});

test('isFixedDemoToken: nur die ENV-Slots, nicht selbst gemintete Tokens desselben Users', () => {
  setEnv({ device: TOK_NATIVE });
  const r = demoUser.ensureDemoAccess();
  const fixedId = r.tokens[0].id;
  assert.equal(demoUser.isFixedDemoToken(fixedId), true);

  const own = deviceTokens.createDeviceToken({ userEmail: DEMO, deviceName: 'Mein iPhone' });
  assert.equal(demoUser.isFixedDemoToken(own.id), false);

  // Ohne aktiven Demo-Pfad ist nichts geschuetzt (sonst blockiert der Guard
  // auf einer Prod-Instanz Tokens, die zufaellig so heissen).
  setEnv({ password: null });
  assert.equal(demoUser.isFixedDemoToken(fixedId), false);
});
