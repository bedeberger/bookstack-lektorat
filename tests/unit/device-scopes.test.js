'use strict';
// Unit-Tests fuer lib/device-scopes.js — das Rechte-Gate der Device-Tokens.
// Lauf: `node --test tests/unit/`
//
// Der Testgegenstand ist die Frage „was darf ein capture-Token": ein zu weites
// Gate gibt einer Browser-Erweiterung Schreibrechte am Manuskript, ein zu enges
// bricht die nativen Clients. Beide Richtungen sind hier festgenagelt.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FULL_SCOPE, CAPTURE_SCOPE, TOKEN_KINDS, DEFAULT_KIND,
  scopeMode, scopesForKind, isDeviceRequestAllowed,
} = require('../../lib/device-scopes');
const { DEFAULT_SCOPES } = require('../../db/device-tokens');

const allow = (method, path, scopes = TOKEN_KINDS.capture) =>
  isDeviceRequestAllowed({ scopes, method, path });

test('scopeMode: content:write schlaegt capture:write', () => {
  assert.equal(scopeMode('content:read,content:write'), 'full');
  assert.equal(scopeMode('content:read,capture:write'), 'capture');
  assert.equal(scopeMode(`${FULL_SCOPE},${CAPTURE_SCOPE}`), 'full');
  assert.equal(scopeMode('content:read'), 'none');
  assert.equal(scopeMode(''), 'none');
  assert.equal(scopeMode(null), 'none');
});

test('Bestandsschutz: content:write-Token bleibt ungegated', () => {
  const full = TOKEN_KINDS.device;
  for (const [m, p] of [
    ['PUT', '/content/books/7/pages/42'],
    ['POST', '/book-editor/save'],
    ['DELETE', '/research/9'],
    ['POST', '/jobs/lektorat'],
    ['GET', '/admin/users'],
    ['POST', '/me/device-tokens'],
  ]) {
    assert.equal(allow(m, p, full), true, `${m} ${p} muss fuer content:write erlaubt bleiben`);
  }
});

test('capture-Token: die Erfassungs-Endpunkte sind erlaubt', () => {
  const ok = [
    ['GET', '/content/books'],
    ['GET', '/research'],
    ['GET', '/research/tags'],
    ['POST', '/research'],
    ['POST', '/research/42/image'],
    ['POST', '/research/42/doc'],
    ['GET', '/sources'],
    ['GET', '/sources/pool'],
    ['GET', '/sources/stats'],
    ['GET', '/sources/lookup'],
    ['GET', '/sources/by-url'],
    ['POST', '/sources'],
    ['POST', '/sources/7/link'],
    ['POST', '/sources/7/pdf'],
    ['POST', '/sources/7/doc'],
    ['POST', '/capture'],
  ];
  for (const [m, p] of ok) assert.equal(allow(m, p), true, `${m} ${p} sollte erlaubt sein`);
});

test('capture-Token: Manuskript, Editor, Jobs, Admin und Self-Minting sind gesperrt', () => {
  const denied = [
    ['GET', '/content/books/7/pages/42'],
    ['PUT', '/content/books/7/pages/42'],
    ['POST', '/content/books'],
    ['POST', '/book-editor/save'],
    ['POST', '/jobs/lektorat'],
    ['POST', '/jobs/book-chat'],
    ['GET', '/admin/devices'],
    ['GET', '/me/device-tokens'],
    ['POST', '/me/device-tokens'],
    ['GET', '/config'],
    ['POST', '/chat'],
    ['GET', '/export/7'],
  ];
  for (const [m, p] of denied) assert.equal(allow(m, p), false, `${m} ${p} muss gesperrt sein`);
});

test('capture-Token: kein DELETE, auch nicht auf erlaubten Pfaden', () => {
  for (const p of ['/research/9', '/sources/7', '/sources/7/link', '/sources/7/pdf', '/capture']) {
    assert.equal(allow('DELETE', p), false, `DELETE ${p} muss gesperrt sein`);
  }
  // PUT/PATCH aendern Bestehendes — die Erweiterung legt nur an.
  assert.equal(allow('PATCH', '/research/9'), false);
  assert.equal(allow('PUT', '/sources/7'), false);
});

test('capture-Token: Pfad-Normalisierung schliesst keine Umgehung auf', () => {
  // Express routet case-insensitiv und toleriert Trailing-Slash — beides muss
  // dieselbe Entscheidung ergeben wie die kanonische Form.
  assert.equal(allow('PUT', '/CONTENT/Books/7/pages/42'), false);
  assert.equal(allow('POST', '/Me/Device-Tokens'), false);
  assert.equal(allow('POST', '/capture/'), true);
  assert.equal(allow('GET', '/content/books/'), true);
  // /content/books ist EXAKT erlaubt — das Buch-Detail darunter nicht.
  assert.equal(allow('GET', '/content/books/7'), false);
});

test('capture-Token: nur die vier Id-Unterpfade, nicht beliebige', () => {
  assert.equal(allow('POST', '/research/42/links'), false);
  assert.equal(allow('POST', '/sources/7/embed'), false);
  // Nicht-numerische Id greift die Allowlist nicht ab.
  assert.equal(allow('POST', '/sources/pool/link'), false);
});

test('Token ohne Schreib-Scope darf nichts (deny-by-default)', () => {
  for (const [m, p] of [['GET', '/content/books'], ['POST', '/capture'], ['POST', '/research']]) {
    assert.equal(allow(m, p, 'content:read'), false);
    assert.equal(allow(m, p, ''), false);
  }
});

test('scopesForKind: unbekannte Art faellt auf den Default zurueck', () => {
  assert.equal(scopesForKind('device'), TOKEN_KINDS.device);
  assert.equal(scopesForKind('capture'), TOKEN_KINDS.capture);
  assert.equal(scopesForKind('quatsch'), TOKEN_KINDS[DEFAULT_KIND]);
  assert.equal(scopesForKind(undefined), TOKEN_KINDS[DEFAULT_KIND]);
  // Der Default MUSS die volle Art sein: bestehende Clients stellen ohne `kind`
  // aus und wuerden sonst schlagartig entrechtet.
  assert.equal(DEFAULT_KIND, 'device');
});

test('Drift: db/device-tokens.DEFAULT_SCOPES == TOKEN_KINDS.device', () => {
  // Bewusste Kopie (die DB-Schicht greift nicht in lib/). Laufen die beiden
  // auseinander, traegt ein ohne `kind` ausgestelltes Token andere Rechte als
  // die Tabelle in docs/clients.md behauptet.
  assert.equal(DEFAULT_SCOPES, TOKEN_KINDS.device);
});
