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
  READ_SCOPE, FULL_SCOPE, CAPTURE_SCOPE, TOKEN_KINDS, DEFAULT_KIND,
  READ_ALLOW, CAPTURE_ALLOW, scopeMode, scopesForKind, isDeviceRequestAllowed,
} = require('../../lib/device-scopes');
const { DEFAULT_SCOPES } = require('../../db/device-tokens');

const allow = (method, path, scopes = TOKEN_KINDS.capture) =>
  isDeviceRequestAllowed({ scopes, method, path });

test('scopeMode: content:write schlaegt capture:write schlaegt content:read', () => {
  assert.equal(scopeMode('content:read,content:write'), 'full');
  assert.equal(scopeMode('content:read,capture:write'), 'capture');
  assert.equal(scopeMode(`${FULL_SCOPE},${CAPTURE_SCOPE}`), 'full');
  assert.equal(scopeMode('content:read'), 'read');
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

test('Allowlist enthaelt keine Phantom-Pfade (`/sources/:id/pdf` gibt es nicht)', () => {
  // Der Anhang-Endpunkt der Quellen heisst `doc` (routes/sources-doc.js). Ein
  // zusaetzlich gelisteter Aliasname kostet nicht nichts: die Allowlist ist der
  // kompakteste Pfad-Ueberblick, den ein Client-Autor findet, und ein Name
  // darin wird als Endpunkt gelesen und aufgerufen — der Router antwortet dann
  // 404, und der Fehler wird beim Client gesucht.
  assert.equal(allow('POST', '/sources/7/pdf'), false);
  assert.equal(allow('POST', '/sources/7/doc'), true);
});

test('capture-Token: kein DELETE, auch nicht auf erlaubten Pfaden', () => {
  for (const p of ['/research/9', '/sources/7', '/sources/7/link', '/sources/7/doc', '/capture']) {
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

test('capture-Token: nur die gelisteten Id-Unterpfade, nicht beliebige', () => {
  assert.equal(allow('POST', '/research/42/links'), false);
  assert.equal(allow('POST', '/sources/7/embed'), false);
  // Nicht-numerische Id greift die Allowlist nicht ab.
  assert.equal(allow('POST', '/sources/pool/link'), false);
});

test('Token ganz ohne bekannten Scope darf nichts (deny-by-default)', () => {
  for (const [m, p] of [['GET', '/content/books'], ['GET', '/research'],
    ['POST', '/capture'], ['POST', '/research']]) {
    assert.equal(allow(m, p, ''), false);
    assert.equal(allow(m, p, 'irgendwas:sonst'), false);
    assert.equal(allow(m, p, null), false);
  }
});

// ── Lese-Scope ───────────────────────────────────────────────────────────────
// Lesen haengt an content:read, nicht am Schreib-Scope: die Erweiterung fragt
// vor dem Erfassen „kenne ich diese Seite schon", und dafuer soll kein Token
// noetig sein, das auch anlegen darf.

test('content:read allein oeffnet die Lesepfade — und nur die', () => {
  const readOnly = READ_SCOPE;
  for (const [m, p] of [
    ['GET', '/content/books'],
    ['GET', '/research'],
    ['GET', '/research/tags'],
    ['GET', '/sources'],
    ['GET', '/sources/by-url'],
  ]) {
    assert.equal(allow(m, p, readOnly), true, `${m} ${p} sollte fuer content:read erlaubt sein`);
  }
  for (const [m, p] of [
    ['POST', '/research'],
    ['POST', '/capture'],
    ['POST', '/sources'],
    ['POST', '/sources/7/link'],
    ['POST', '/research/42/doc'],
    ['DELETE', '/research/9'],
    ['GET', '/content/books/7/pages/42'],
  ]) {
    assert.equal(allow(m, p, readOnly), false, `${m} ${p} darf ohne Schreib-Scope nicht gehen`);
  }
});

test('GET /research ohne content:read → verweigert, auch mit capture:write', () => {
  // Der Fall, den die getrennten Listen absichern: Schreiben allein oeffnet das
  // Lesen nicht. (Ausgestellte capture-Tokens tragen beide Scopes — hier geht es
  // um ein von Hand beschnittenes Token.)
  assert.equal(allow('GET', '/research', CAPTURE_SCOPE), false);
  assert.equal(allow('GET', '/research?book_id=7', CAPTURE_SCOPE), false);
  assert.equal(allow('POST', '/research', CAPTURE_SCOPE), true);
});

test('capture-Token traegt beide Scopes → liest und schreibt', () => {
  assert.equal(allow('GET', '/research'), true);
  assert.equal(allow('POST', '/research'), true);
  assert.ok(TOKEN_KINDS.capture.includes(READ_SCOPE));
  assert.ok(TOKEN_KINDS.device.includes(READ_SCOPE));
});

test('READ_ALLOW enthaelt ausschliesslich GET', () => {
  // Ein Schreib-Eintrag in der Leseliste wuerde am capture:write-Gate vorbei
  // schreiben lassen — die Trennung waere aufgehoben, ohne dass ein Test bricht.
  for (const [m, re] of READ_ALLOW) {
    assert.equal(m, 'GET', `READ_ALLOW-Eintrag ${m} ${re} ist kein GET`);
  }
  for (const [m, re] of CAPTURE_ALLOW) {
    assert.notEqual(m, 'GET', `CAPTURE_ALLOW-Eintrag ${m} ${re} gehoert nach READ_ALLOW`);
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
