'use strict';
// Integration: die HTTP-Schicht der Lauf-Historie
// (routes/jobs/source-detect.js, /jobs/source-detect/runs[/:id]).
//
// Der Job selbst ist in source-detect.test.js abgedeckt — hier geht es um das,
// was nur an der Route sichtbar wird:
//   - die Liste kommt ohne Fundliste (Kopfzeilen), das Detail mit
//   - der Bibliotheks-Status wird beim LESEN gerechnet, nicht aus dem Lauf
//     zurueckgeholt (er altert)
//   - ein fremder Lauf ist ein 404, kein 403: die Existenz einer fremden
//     Historie ist nichts, was preisgegeben werden muesste
//   - ohne Buchzugriff kein Zugriff, auch auf den eigenen Lauf nicht
//
// Faehrt den echten Router unter Express hoch (Fake-Session liefert den User),
// ACL via grantAccess — dasselbe Muster wie sources-import.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser = 'autor@test.dev';

const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: sessionUser } }; next(); });
    app.use('/jobs', require('../../routes/jobs').router);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(method, urlPath, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${urlPath}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) { /* leerer Body ist erlaubt */ }
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  sessionUser = 'autor@test.dev';
  for (const t of ['source_detect_runs', 'source_citations', 'book_source_links', 'sources',
    'pages', 'chapters', 'book_access', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

function seedBook(bookId, user = 'autor@test.dev') {
  const { grantAccess } = require('../../db/book-access');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(bookId, 'Testbuch', NOW, NOW);
  grantAccess(bookId, user, 'editor', user);
  return bookId;
}

function seedRun(bookId, user, vorschlaege, extra = {}) {
  const { insertDetectRun } = require('../../db/sources');
  return insertDetectRun({
    bookId, userEmail: user,
    foundCount: vorschlaege.length,
    verifiedCount: vorschlaege.filter(v => v.verified).length,
    result: { vorschlaege },
    ...extra,
  });
}

const FUND = { csl_type: 'book', title: 'Der Prozess', authors: [{ family: 'Kafka' }], verified: true };

test('Liste liefert Kopfzeilen, Detail die Fundliste', async () => {
  seedBook(500);
  const runId = seedRun(500, 'autor@test.dev', [FUND]);

  const list = await api('GET', '/jobs/source-detect/runs?book_id=500');
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].id, runId);
  assert.equal(list.json[0].found_count, 1);
  assert.equal(list.json[0].verified_count, 1);
  // Kein result_json in der Liste — ein Buch-Lauf traegt hunderte Kilobyte.
  assert.ok(!('result_json' in list.json[0]));
  assert.ok(!list.json[0].result);

  const detail = await api('GET', `/jobs/source-detect/runs/${runId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.result.vorschlaege[0].title, 'Der Prozess');
});

test('Bibliotheks-Status kommt frisch, nicht aus dem gespeicherten Lauf', async () => {
  seedBook(501);
  const runId = seedRun(501, 'autor@test.dev', [FUND]);
  const { createSource, linkSource } = require('../../db/sources');

  let detail = await api('GET', `/jobs/source-detect/runs/${runId}`);
  assert.equal(detail.json.result.vorschlaege[0].existing_source_id, null);

  // Zwischen zwei Blicken uebernommen → derselbe Lauf sagt jetzt etwas anderes.
  const s = createSource('autor@test.dev', { csl_type: 'book', title: 'Der Prozess' });
  linkSource(501, s.id, 'autor@test.dev');

  detail = await api('GET', `/jobs/source-detect/runs/${runId}`);
  assert.equal(detail.json.result.vorschlaege[0].existing_source_id, s.id);
  assert.equal(detail.json.result.vorschlaege[0].existing_linked, true);
});

test('fremder Lauf im selben Buch ist ein 404', async () => {
  seedBook(502);
  const { grantAccess } = require('../../db/book-access');
  grantAccess(502, 'mitarbeit@test.dev', 'editor', 'autor@test.dev');
  const fremd = seedRun(502, 'mitarbeit@test.dev', [FUND]);

  // Sichtbar ist die eigene Historie — die des Co-Autors nicht, obwohl beide
  // am selben Buch arbeiten.
  const list = await api('GET', '/jobs/source-detect/runs?book_id=502');
  assert.deepEqual(list.json, []);

  const detail = await api('GET', `/jobs/source-detect/runs/${fremd}`);
  assert.equal(detail.status, 404);
  assert.equal(detail.json.error_code, 'RUN_NOT_FOUND');

  const del = await api('DELETE', `/jobs/source-detect/runs/${fremd}`);
  assert.equal(del.status, 404);
  const { getDetectRun } = require('../../db/sources');
  assert.ok(getDetectRun(fremd), 'fremder Lauf darf nicht geloescht worden sein');
});

test('ohne Buchzugriff auch kein Zugriff auf den eigenen Lauf', async () => {
  seedBook(503, 'owner@test.dev');
  const runId = seedRun(503, 'autor@test.dev', [FUND]);   // Lauf gehoert uns, das Buch nicht

  const detail = await api('GET', `/jobs/source-detect/runs/${runId}`);
  assert.equal(detail.status, 403);

  const list = await api('GET', '/jobs/source-detect/runs?book_id=503');
  assert.equal(list.status, 403);
});

test('loeschen entfernt nur den eigenen Lauf', async () => {
  seedBook(504);
  const a = seedRun(504, 'autor@test.dev', [FUND]);
  const b = seedRun(504, 'autor@test.dev', [FUND]);

  const del = await api('DELETE', `/jobs/source-detect/runs/${a}`);
  assert.equal(del.status, 200);

  const list = await api('GET', '/jobs/source-detect/runs?book_id=504');
  assert.deepEqual(list.json.map(r => r.id), [b]);
});

test('unbrauchbare Parameter werden abgewiesen', async () => {
  seedBook(505);
  assert.equal((await api('GET', '/jobs/source-detect/runs')).status, 400);
  assert.equal((await api('GET', '/jobs/source-detect/runs/abc')).status, 400);
  assert.equal((await api('GET', '/jobs/source-detect/runs/99999')).status, 404);
});
