'use strict';
// Integration test: die drei Import-/Uebernahme-Endpunkte von routes/sources.js.
// Der Parser selbst ist pure und in tests/unit/bib-parse.test.mjs abgedeckt —
// hier geht es um das, was nur an der HTTP-Schicht sichtbar wird:
//   - POST /sources/import: ein kaputter Eintrag bricht den Import NICHT ab,
//     Duplikate werden erkannt statt verdoppelt, ein zweiter Import in ein
//     zweites Buch ordnet die vorhandene Pool-Quelle zu (`linked`)
//   - GET  /sources/lookup: Validierung, Treffer, 404 vs. 502 (fetch gestubbt —
//     kein Test haengt an Crossref/OpenLibrary)
//   - POST /sources/from-research: Vorbelegung + ACL ueber das Buch des Items
//
// Faehrt den echten Router unter Express hoch (Fake-Session liefert den User),
// ACL via grantAccess — dasselbe Muster wie research-routes.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser = 'autor@test.dev';

const NOW = '2026-01-01T00:00:00.000Z';
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'bib');
const BIBTEX = readFileSync(path.join(FIXTURES, 'zotero-export.bib'), 'utf8');
const RIS = readFileSync(path.join(FIXTURES, 'endnote-export.ris'), 'utf8');

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: sessionUser } }; next(); });
    app.use('/sources', require('../../routes/sources'));
    app.use('/research', require('../../routes/research'));
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

// fetch nur fuer den Lookup-Pfad ersetzen — der Testserver selbst laeuft ueber
// dasselbe globale fetch, darum wird der Stub um den Aufruf herum gesetzt.
async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith(baseUrl)) return original(url, opts);
    return stub(u, opts);
  };
  try { return await fn(); } finally { globalThis.fetch = original; }
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});

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
  for (const t of ['source_citations', 'book_source_links', 'sources',
    'research_item_urls', 'research_items', 'pages', 'chapters', 'book_access', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

function seedBook(bookId, user = 'autor@test.dev', name = 'Testbuch') {
  const { grantAccess } = require('../../db/book-access');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(bookId, name, NOW, NOW);
  grantAccess(bookId, user, 'editor', user);
  return bookId;
}

const importBib = (bookId, format = 'bibtex', text = BIBTEX) =>
  api('POST', '/sources/import', { book_id: bookId, format, text });

// ── POST /sources/import ─────────────────────────────────────────────────────

test('import bibtex: legt alle brauchbaren Eintraege an und meldet den unbrauchbaren', async () => {
  const BOOK = seedBook(9401);
  const { status, json } = await importBib(BOOK);
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.total, 7);
  assert.equal(json.imported, 6);
  assert.equal(json.skipped, 0);
  // Der @misc-Eintrag der Fixture hat weder Titel noch Person.
  assert.deepEqual(json.errors, [{ index: 5, error_code: 'SOURCE_IDENTITY_REQ' }]);

  const rows = (await api('GET', `/sources?book_id=${BOOK}`)).json;
  assert.equal(rows.length, 6);
  const kafka = rows.find(r => r.citekey === 'kafka1915');
  assert.equal(kafka.title, 'Die Verwandlung');
  assert.deepEqual(kafka.authors, [{ family: 'Kafka', given: 'Franz' }]);
  assert.equal(kafka.csl_type, 'book');
});

test('import ris: BOM+CRLF-Datei landet vollstaendig im Buch', async () => {
  const BOOK = seedBook(9402);
  const { json } = await importBib(BOOK, 'ris', RIS);
  assert.equal(json.total, 5);
  assert.equal(json.imported, 4);
  const rows = (await api('GET', `/sources?book_id=${BOOK}`)).json;
  assert.deepEqual(
    rows.map(r => r.csl_type).sort(),
    ['article', 'book', 'chapter', 'website']
  );
});

test('import zweimal: keine Duplikate, egal ob mit oder ohne Zitierschluessel', async () => {
  const BOOK = seedBook(9403);
  await importBib(BOOK);
  await importBib(BOOK, 'ris', RIS);
  const after1 = (await api('GET', `/sources?book_id=${BOOK}`)).json.length;

  const again = await importBib(BOOK);
  assert.equal(again.json.imported, 0);
  assert.equal(again.json.skipped, 6);
  const againRis = await importBib(BOOK, 'ris', RIS);
  assert.equal(againRis.json.imported, 0);
  assert.equal(againRis.json.skipped, 4);

  assert.equal((await api('GET', `/sources?book_id=${BOOK}`)).json.length, after1);
});

test('import in ein zweites Buch ordnet die vorhandene Pool-Quelle zu', async () => {
  const A = seedBook(9404, 'autor@test.dev', 'Arbeit A');
  const B = seedBook(9405, 'autor@test.dev', 'Arbeit B');
  await importBib(A);

  const { json } = await importBib(B);
  assert.equal(json.imported, 0);
  assert.equal(json.skipped, 6);
  assert.equal(json.linked, 6, 'die Quellen muessen in Arbeit B sichtbar werden');
  assert.equal((await api('GET', `/sources?book_id=${B}`)).json.length, 6);
  // Der Pool waechst dabei NICHT — es ist dieselbe Bibliothek.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sources').get().n, 6);
});

test('import: Format, leerer Text und unlesbare Datei werden abgelehnt', async () => {
  const BOOK = seedBook(9406);
  assert.equal((await importBib(BOOK, 'endnote-xml', BIBTEX)).json.error_code, 'IMPORT_FORMAT_INVALID');
  assert.equal((await importBib(BOOK, 'bibtex', '   ')).json.error_code, 'IMPORT_TEXT_REQUIRED');
  assert.equal((await importBib(BOOK, 'bibtex', 'nur Prosa')).json.error_code, 'IMPORT_EMPTY');
  assert.equal((await api('POST', '/sources/import', { format: 'bibtex', text: BIBTEX })).json.error_code, 'INVALID_ID');
  // Nichts davon darf etwas angelegt haben.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sources').get().n, 0);
});

test('import: ohne Editor-Recht am Buch kein Import', async () => {
  const BOOK = seedBook(9407, 'owner@test.dev');
  sessionUser = 'eindringling@test.dev';
  const { status } = await importBib(BOOK);
  assert.ok(status === 403 || status === 404, `unerwarteter Status ${status}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sources').get().n, 0);
});

// ── GET /sources/lookup ──────────────────────────────────────────────────────

test('lookup: Parameter-Validierung', async () => {
  assert.equal((await api('GET', '/sources/lookup')).json.error_code, 'LOOKUP_PARAM_REQUIRED');
  assert.equal((await api('GET', '/sources/lookup?doi=10.1/x&isbn=9783596294367')).json.error_code, 'LOOKUP_PARAM_AMBIGUOUS');
  assert.equal((await api('GET', '/sources/lookup?doi=quatsch')).json.error_code, 'INVALID_DOI');
  assert.equal((await api('GET', '/sources/lookup?isbn=123')).json.error_code, 'INVALID_ISBN');
  // Eine durchgeschmuggelte URL ist kein DOI — SSRF-Zusage von lib/source-lookup.js.
  assert.equal((await api('GET', '/sources/lookup?doi=http://169.254.169.254/latest/meta-data')).json.error_code, 'INVALID_DOI');
});

test('lookup: Treffer liefert einen Entwurf und speichert nichts', async () => {
  const message = {
    DOI: '10.1000/xyz123', type: 'journal-article', title: ['Ein Aufsatz'],
    'container-title': ['Eine Zeitschrift'], issued: { 'date-parts': [[2021, 5]] },
    author: [{ family: 'Müller', given: 'Hans' }],
  };
  const { status, json } = await withFetch(
    async (url) => {
      assert.match(url, /^https:\/\/api\.crossref\.org\/works\//);
      return jsonResponse({ message });
    },
    () => api('GET', '/sources/lookup?doi=10.1000/xyz123')
  );
  assert.equal(status, 200);
  assert.equal(json.title, 'Ein Aufsatz');
  assert.equal(json.csl_type, 'article');
  assert.equal(json.year, '2021');
  assert.deepEqual(json.authors, [{ family: 'Müller', given: 'Hans' }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sources').get().n, 0, 'Lookup darf nichts anlegen');
});

test('lookup: kein Treffer → 404, Dienst weg → 502', async () => {
  const notFound = await withFetch(
    async () => jsonResponse(null, 404),
    () => api('GET', '/sources/lookup?doi=10.1000/gibtesnicht')
  );
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.error_code, 'LOOKUP_NOT_FOUND');

  const dead = await withFetch(
    async () => { throw new TypeError('fetch failed'); },
    () => api('GET', '/sources/lookup?doi=10.1000/xyz123')
  );
  assert.equal(dead.status, 502);
  assert.equal(dead.json.error_code, 'LOOKUP_UNAVAILABLE');
});

test('lookup: ISBN geht an OpenLibrary, leere Antwort ist kein Treffer', async () => {
  const isbn = '9783596294367';
  const hit = await withFetch(
    async (url) => {
      assert.match(url, /^https:\/\/openlibrary\.org\/api\/books\?/);
      assert.match(url, /bibkeys=ISBN%3A9783596294367/);
      return jsonResponse({ [`ISBN:${isbn}`]: { title: 'Der Prozess', authors: [{ name: 'Franz Kafka' }] } });
    },
    () => api('GET', `/sources/lookup?isbn=978-3-596-29436-7`)
  );
  assert.equal(hit.status, 200);
  assert.equal(hit.json.title, 'Der Prozess');
  assert.equal(hit.json.isbn, isbn);
  assert.deepEqual(hit.json.authors, [{ family: 'Kafka', given: 'Franz' }]);

  const miss = await withFetch(
    async () => jsonResponse({}),
    () => api('GET', `/sources/lookup?isbn=${isbn}`)
  );
  assert.equal(miss.status, 404);
});

// ── POST /sources/from-research ──────────────────────────────────────────────

async function makeItem(bookId, fields) {
  const { status, json } = await api('POST', '/research', { book_id: bookId, ...fields });
  assert.equal(status, 200, JSON.stringify(json));
  return json;
}

test('from-research: URL-Fund wird zur Website-Quelle mit Abrufdatum', async () => {
  const BOOK = seedBook(9408);
  const item = await makeItem(BOOK, {
    kind: 'link',
    title: 'Prozessakten im Landesarchiv',
    source: 'Landesarchiv Baden, Findbuch B 44',
    urls: [{ url: 'https://archiv.example.org/b44' }, { url: 'https://zweite.example.org/x' }],
  });

  const { status, json } = await api('POST', '/sources/from-research', { item_id: item.id });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.csl_type, 'website');
  assert.equal(json.title, 'Prozessakten im Landesarchiv');
  assert.equal(json.url, 'https://archiv.example.org/b44', 'die erste URL gewinnt');
  assert.equal(json.note, 'Landesarchiv Baden, Findbuch B 44');
  assert.match(json.accessed_at, /^\d{4}-\d{2}-\d{2}$/);

  // Dem Buch des Fundstuecks zugeordnet, und das Fundstueck bleibt unangetastet.
  assert.equal((await api('GET', `/sources?book_id=${BOOK}`)).json.length, 1);
  const board = (await api('GET', `/research?book_id=${BOOK}`)).json;
  assert.equal(board.find(i => i.id === item.id).title, 'Prozessakten im Landesarchiv');
});

test('from-research: Fund ohne URL laesst die Gattung offen und setzt kein Abrufdatum', async () => {
  const BOOK = seedBook(9409);
  const item = await makeItem(BOOK, { kind: 'quote', title: 'Randnotiz aus dem Findbuch' });
  const { json } = await api('POST', '/sources/from-research', { item_id: item.id });
  assert.equal(json.csl_type, 'other');
  assert.equal(json.url, null);
  assert.equal(json.accessed_at, null);
});

test('from-research: Fund ohne Titel wird abgelehnt', async () => {
  const BOOK = seedBook(9410);
  const item = await makeItem(BOOK, { kind: 'note', body: 'nur Fliesstext, kein Titel' });
  const { status, json } = await api('POST', '/sources/from-research', { item_id: item.id });
  assert.equal(status, 400);
  assert.equal(json.error_code, 'SOURCE_IDENTITY_REQ');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sources').get().n, 0);
});

test('from-research: unbekanntes Item und fremdes Buch', async () => {
  const BOOK = seedBook(9411, 'owner@test.dev');
  assert.equal((await api('POST', '/sources/from-research', { item_id: 999999 })).json.error_code, 'RESEARCH_ITEM_NOT_FOUND');
  assert.equal((await api('POST', '/sources/from-research', { item_id: 'abc' })).json.error_code, 'INVALID_ID');

  sessionUser = 'owner@test.dev';
  const item = await makeItem(BOOK, { title: 'Fremder Fund' });
  sessionUser = 'eindringling@test.dev';
  const { status } = await api('POST', '/sources/from-research', { item_id: item.id });
  assert.ok(status === 403 || status === 404, `unerwarteter Status ${status}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sources').get().n, 0);
});
