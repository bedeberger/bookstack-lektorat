'use strict';
// Integration test: der Demo-Seed ueber HTTP, so wie ihn die Browser-Erweiterung
// mit einem `capture`-Token sieht.
//
// Der Punkt des zweiten Demo-Buchs ist ein VORFUEHRBARER Fehlerfall: Lesen geht,
// Schreiben nicht, und der Server sagt warum. Genau diese drei Aussagen werden
// hier gegen die echten Router geprueft (Scope-Gate wie in server.js davor):
//   GET  /content/books  → beide Buecher, mit `role` und `owner_email`
//   POST /capture Buch 1 → 200 (eigenes Buch, Rolle owner)
//   POST /capture Buch 2 → 403 INSUFFICIENT_ROLE + detail { actual, required }
//
// Der Seed selbst (Idempotenz, Besitzer-Konto, Grants) liegt in
// tests/unit/demo-foreign-book.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let server;
let baseUrl;
// Zusatzfelder am Session-User: `via`/`scopes` sind die zwei Felder, aus denen
// deviceScopeGate seine Entscheidung zieht (lib/device-auth#tryDeviceAuth
// fuellt sie im Betrieb).
let sessionExtra = null;

const DEMO = 'demo@x.test';
let ownBookId = 0;
let foreignBookId = 0;
let FOREIGN_OWNER = '';

function startServer() {
  return new Promise((resolve, reject) => {
    const { deviceScopeGate } = require('../../lib/device-scopes');
    const app = express();
    app.use((req, _res, next) => {
      req.session = { user: { email: DEMO, ...(sessionExtra || {}) } };
      next();
    });
    app.use(deviceScopeGate);
    app.use('/content', require('../../routes/content'));
    app.use('/sources', require('../../routes/sources'));
    app.use('/capture', require('../../routes/capture'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  const appUsers = require('../../db/app-users');
  if (!appUsers.getUser(DEMO)) {
    appUsers.createUser({ email: DEMO, displayName: 'Demo', globalRole: 'user', status: 'active' });
  }

  const demoBook = require('../../lib/demo-book');
  FOREIGN_OWNER = demoBook.FOREIGN_OWNER_EMAIL;
  ownBookId = (await demoBook.createDemoBook(DEMO)).bookId;
  foreignBookId = (await demoBook.createForeignDemoBook(DEMO)).bookId;

  await startServer();
});

test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  // Standardfall dieser Datei: die Browser-Erweiterung, also ein capture-Token.
  const { TOKEN_KINDS } = require('../../lib/device-scopes');
  sessionExtra = { via: 'device_token', scopes: TOKEN_KINDS.capture, tokenId: 1 };
});

test('GET /content/books: beide Buecher, mit Rolle und Besitzer', async () => {
  const { status, json } = await api('GET', '/content/books');
  assert.equal(status, 200);

  const own = json.find(b => b.id === ownBookId);
  const foreign = json.find(b => b.id === foreignBookId);
  assert.ok(own, 'eigenes Buch fehlt in der Liste');
  assert.ok(foreign, 'Fremdbuch fehlt in der Liste');

  assert.equal(own.role, 'owner');
  assert.equal(own.owner_email, DEMO);

  assert.equal(foreign.role, 'viewer');
  assert.equal(foreign.owner_email, FOREIGN_OWNER);
  // Der Store-Pruefer sieht diese Antwort — keine echte Adresse darin.
  assert.match(foreign.owner_email, /@example\.org$/);
});

test('POST /capture ins eigene Buch: erfasst', async () => {
  const { status, json } = await api('POST', '/capture', {
    book_id: ownBookId,
    mode: 'research',
    url: 'https://example.com/artikel',
    title: 'Ein Fund',
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.research_created, true);
  assert.ok(json.research_item?.id > 0);
});

test('POST /capture ins Fremdbuch: 403 INSUFFICIENT_ROLE mit Begruendung', async () => {
  const { status, json } = await api('POST', '/capture', {
    book_id: foreignBookId,
    mode: 'research',
    url: 'https://example.com/artikel',
    title: 'Ein Fund',
  });
  assert.equal(status, 403);
  assert.equal(json.error_code, 'INSUFFICIENT_ROLE');
  // Ohne dieses Detail kann der Client nur „verboten" sagen statt „du darfst
  // dieses Buch nur lesen".
  assert.deepEqual(json.detail, { actual: 'viewer', required: 'editor' });
});

test('POST /capture ins Fremdbuch schreibt nichts', async () => {
  const { db } = require('../../db/schema');
  const before = db.prepare('SELECT COUNT(*) AS n FROM research_items WHERE book_id = ?').get(foreignBookId).n;
  await api('POST', '/capture', {
    book_id: foreignBookId, mode: 'both', url: 'https://example.com/x', title: 'Nope',
  });
  const after = db.prepare('SELECT COUNT(*) AS n FROM research_items WHERE book_id = ?').get(foreignBookId).n;
  assert.equal(after, before);
  // Auch keine Quelle im Pool: die ACL greift vor der Transaktion.
  const src = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE title = ?').get('Nope').n;
  assert.equal(src, 0);
});

test('Fremdbuch bleibt lesbar: GET /sources reicht mit viewer', async () => {
  // Der Gegenbeweis zum 403 oben: dieselbe Rolle, aber ein Lesepfad, dem
  // `viewer` genuegt — das Buch ist nicht gesperrt, nur schreibgeschuetzt.
  const { status, json } = await api('GET', `/sources?book_id=${foreignBookId}`);
  assert.equal(status, 200, JSON.stringify(json));
  assert.ok(Array.isArray(json));
});

test('Buch-Detail ist fuer ein capture-Token nicht freigegeben (nur die Liste)', async () => {
  // GET /content/books/:id steht bewusst NICHT in READ_ALLOW — die Erweiterung
  // braucht die Buchwahl, nicht das Buch. Das Gate greift vor der ACL, die
  // Antwort ist darum DEVICE_SCOPE_FORBIDDEN und nicht die Buch-Rolle.
  const own = await api('GET', `/content/books/${ownBookId}`);
  assert.equal(own.status, 403);
  assert.equal(own.json.error_code, 'DEVICE_SCOPE_FORBIDDEN');
});
