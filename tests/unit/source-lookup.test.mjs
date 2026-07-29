// DOI-/ISBN-Lookup (lib/source-lookup.js): Normalisierung + die beiden reinen
// Antwort-Mapper gegen echte Antwort-Ausschnitte von Crossref und OpenLibrary.
// Kein Netz — die Mapper sind absichtlich von fetch getrennt, damit genau das
// hier ohne Fremd-Dienst pruefbar ist.
//
// Mit gegated: die SSRF-Zusage des Moduls. Es darf keinen Pfad geben, auf dem
// eine User-URL zum Request-Ziel wird — die beiden Hosts stehen als Literal im
// Modul, und `fetch` wird ausschliesslich mit einem davon aufgerufen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeDoi, normalizeIsbn, mapCrossrefWork, mapOpenLibraryBook, CROSSREF_TYPES,
  lookupDoi, lookupIsbn, LookupUnavailableError,
} = require('../../lib/source-lookup.js');
const { CSL_TYPES } = require('../../db/sources.js');

// Ausschnitt einer echten Crossref-Antwort (`GET /works/<doi>` → `message`).
const CROSSREF_ARTICLE = {
  DOI: '10.1038/s41586-020-2649-2',
  type: 'journal-article',
  title: ['Array programming with NumPy'],
  'container-title': ['Nature'],
  publisher: 'Springer Science and Business Media LLC',
  volume: '585',
  issue: '7825',
  page: '357-362',
  issued: { 'date-parts': [[2020, 9, 16]] },
  ISSN: ['0028-0836', '1476-4687'],
  URL: 'http://dx.doi.org/10.1038/s41586-020-2649-2',
  author: [
    { given: 'Charles R.', family: 'Harris', sequence: 'first' },
    { given: 'K. Jarrod', family: 'Millman' },
    { name: 'The NumPy Consortium' },
  ],
};

const CROSSREF_BOOK = {
  DOI: '10.1017/cbo9780511812651',
  type: 'monograph',
  title: ['Speech Acts'],
  publisher: 'Cambridge University Press',
  'publisher-location': 'Cambridge',
  'edition-number': '2',
  ISBN: ['9780521096263', '9780511812651'],
  'published-print': { 'date-parts': [[1969]] },
  editor: [{ given: 'John R.', family: 'Searle' }],
};

// Ausschnitt einer echten OpenLibrary-Antwort (`jscmd=data`, Wert unter dem
// `ISBN:…`-Schluessel).
const OPENLIBRARY_BOOK = {
  title: 'Der Prozess',
  subtitle: 'Roman',
  authors: [{ name: 'Franz Kafka', url: 'https://openlibrary.org/authors/OL25291A/' }],
  publishers: [{ name: 'Fischer Taschenbuch Verlag' }],
  publish_places: [{ name: 'Frankfurt am Main' }],
  publish_date: 'August 1, 1994',
  number_of_pages: 264,
  identifiers: { isbn_13: ['9783596294367'], isbn_10: ['3596294367'] },
};

// ── Normalisierung ───────────────────────────────────────────────────────────

test('normalizeDoi akzeptiert die gaengigen Schreibweisen', () => {
  assert.equal(normalizeDoi('10.1000/xyz123'), '10.1000/xyz123');
  assert.equal(normalizeDoi('  doi:10.1000/xyz123 '), '10.1000/xyz123');
  assert.equal(normalizeDoi('https://doi.org/10.1000/xyz123'), '10.1000/xyz123');
  assert.equal(normalizeDoi('http://dx.doi.org/10.1000/xyz123'), '10.1000/xyz123');
});

test('normalizeDoi weist alles zurueck, was kein DOI ist', () => {
  for (const bad of ['', null, undefined, 'kafka1915', '10.1000', '10/xyz', 'https://example.org/a',
                     'http://169.254.169.254/latest/meta-data', '10.1000/' + 'x'.repeat(300)]) {
    assert.equal(normalizeDoi(bad), null, `‹${bad}› haette abgelehnt werden muessen`);
  }
});

test('normalizeIsbn raeumt Bindestriche weg und prueft die Form', () => {
  assert.equal(normalizeIsbn('978-3-596-29436-7'), '9783596294367');
  assert.equal(normalizeIsbn('3 596 29436 7'), '3596294367');
  assert.equal(normalizeIsbn('080442957x'), '080442957X');
  for (const bad of ['', null, '12345', '97835962943670', 'ISBN', 'X123456789']) {
    assert.equal(normalizeIsbn(bad), null, `‹${bad}› haette abgelehnt werden muessen`);
  }
});

// ── Crossref-Mapper ──────────────────────────────────────────────────────────

test('jeder gemappte Crossref-Typ existiert in CSL_TYPES', () => {
  for (const [key, csl] of Object.entries(CROSSREF_TYPES)) {
    assert.ok(CSL_TYPES.includes(csl), `CROSSREF_TYPES['${key}'] → '${csl}' ist kein CSL_TYPES-Wert`);
  }
});

test('Crossref-Aufsatz → Entwurf', () => {
  const d = mapCrossrefWork(CROSSREF_ARTICLE);
  assert.equal(d.csl_type, 'article');
  assert.equal(d.title, 'Array programming with NumPy');
  assert.equal(d.container_title, 'Nature');
  assert.equal(d.publisher, 'Springer Science and Business Media LLC');
  assert.equal(d.volume, '585');
  assert.equal(d.issue, '7825');
  assert.equal(d.pages, '357-362');
  assert.equal(d.year, '2020');
  assert.equal(d.doi, '10.1038/s41586-020-2649-2');
  assert.equal(d.issn, '0028-0836');
  assert.deepEqual(d.authors, [
    { family: 'Harris', given: 'Charles R.' },
    { family: 'Millman', given: 'K. Jarrod' },
    { literal: 'The NumPy Consortium' },
  ]);
  assert.deepEqual(d.editors, []);
});

test('Crossref-Monographie → book, published-print als Jahres-Rueckfall', () => {
  const d = mapCrossrefWork(CROSSREF_BOOK);
  assert.equal(d.csl_type, 'book');
  assert.equal(d.title, 'Speech Acts');
  assert.equal(d.place, 'Cambridge');
  assert.equal(d.edition, '2');
  assert.equal(d.year, '1969');
  assert.equal(d.isbn, '9780521096263');
  assert.deepEqual(d.editors, [{ family: 'Searle', given: 'John R.' }]);
});

test('Crossref: unbekannter Typ → other, leere Antwort → null', () => {
  assert.equal(mapCrossrefWork({ type: 'component', title: ['X'] }).csl_type, 'other');
  assert.equal(mapCrossrefWork(null), null);
  assert.equal(mapCrossrefWork({}), null);                       // ohne Titel/Person: kein Entwurf
  assert.equal(mapCrossrefWork({ type: 'book', title: [] }), null);
});

// ── OpenLibrary-Mapper ───────────────────────────────────────────────────────

test('OpenLibrary-Buch → Entwurf', () => {
  const d = mapOpenLibraryBook(OPENLIBRARY_BOOK, '9783596294367');
  assert.equal(d.csl_type, 'book');
  assert.equal(d.title, 'Der Prozess: Roman');
  assert.deepEqual(d.authors, [{ family: 'Kafka', given: 'Franz' }]);
  assert.equal(d.publisher, 'Fischer Taschenbuch Verlag');
  assert.equal(d.place, 'Frankfurt am Main');
  assert.equal(d.year, '1994');
  assert.equal(d.isbn, '9783596294367');
});

test('OpenLibrary: Verlag als blosser String, ISBN aus der Antwort', () => {
  const d = mapOpenLibraryBook({ title: 'T', publishers: ['Suhrkamp'], identifiers: { isbn_13: ['9781234567897'] } });
  assert.equal(d.publisher, 'Suhrkamp');
  assert.equal(d.isbn, '9781234567897');
  assert.equal(d.place, null);
});

test('OpenLibrary: leere Antwort → null', () => {
  assert.equal(mapOpenLibraryBook(null), null);
  assert.equal(mapOpenLibraryBook({}), null);
});

test('Entwuerfe tragen genau die Spalten von sources', () => {
  const expected = [
    'csl_type', 'citekey', 'authors', 'editors', 'title', 'container_title',
    'publisher', 'place', 'year', 'edition', 'volume', 'issue', 'pages',
    'doi', 'isbn', 'issn', 'url', 'accessed_at', 'note',
  ].sort();
  for (const d of [mapCrossrefWork(CROSSREF_ARTICLE), mapCrossrefWork(CROSSREF_BOOK),
                   mapOpenLibraryBook(OPENLIBRARY_BOOK, '9783596294367')]) {
    assert.deepEqual(Object.keys(d).sort(), expected);
  }
});

// ── Fehlerkanaele ────────────────────────────────────────────────────────────
// Die Route muss „kein Treffer" (404) von „Dienst weg" (502) unterscheiden
// koennen — sonst sieht der User bei einem Crossref-Ausfall „Quelle unbekannt"
// und legt sie doppelt an. Darum: null vs. Wurf, mit gestubbtem fetch.

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});

test('Treffer → Entwurf, 404 → null, Netzfehler → LookupUnavailableError', async () => {
  const doi = '10.1038/s41586-020-2649-2';

  const hit = await withFetch(async () => jsonResponse({ message: CROSSREF_ARTICLE }), () => lookupDoi(doi));
  assert.equal(hit.title, 'Array programming with NumPy');

  assert.equal(await withFetch(async () => jsonResponse(null, 404), () => lookupDoi(doi)), null);

  await assert.rejects(
    withFetch(async () => { throw new TypeError('fetch failed'); }, () => lookupDoi(doi)),
    (e) => e instanceof LookupUnavailableError && e.code === 'LOOKUP_UNAVAILABLE'
  );
  await assert.rejects(
    withFetch(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, () => lookupDoi(doi)),
    (e) => e.code === 'LOOKUP_UNAVAILABLE'
  );
  await assert.rejects(
    withFetch(async () => jsonResponse({}, 503), () => lookupDoi(doi)),
    (e) => e.code === 'LOOKUP_UNAVAILABLE'
  );
});

test('OpenLibrary antwortet auf Unbekanntes mit {} statt 404 — trotzdem null', async () => {
  const isbn = '9783596294367';
  assert.equal(await withFetch(async () => jsonResponse({}), () => lookupIsbn(isbn)), null);
  const hit = await withFetch(
    async () => jsonResponse({ [`ISBN:${isbn}`]: OPENLIBRARY_BOOK }),
    () => lookupIsbn(isbn)
  );
  assert.equal(hit.title, 'Der Prozess: Roman');
  assert.equal(hit.isbn, isbn);
});

test('unbrauchbare Eingabe fragt gar nicht erst nach', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return jsonResponse({}); }, async () => {
    assert.equal(await lookupDoi('kein-doi'), null);
    assert.equal(await lookupIsbn('123'), null);
  });
  assert.equal(calls, 0);
});

// ── SSRF ─────────────────────────────────────────────────────────────────────

test('nur die zwei festen Hosts sind Request-Ziele', () => {
  const src = readFileSync(fileURLToPath(new URL('../../lib/source-lookup.js', import.meta.url)), 'utf8');
  const hosts = [...src.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map(m => m[0]);
  const targets = new Set(hosts.filter(h => !/doi\.org$/.test(h)));   // doi.org nur als Praefix-Strip
  assert.deepEqual([...targets].sort(), ['https://api.crossref.org', 'https://openlibrary.org']);
  // fetch bekommt ausschliesslich eine der beiden Basis-Konstanten.
  const fetchArgs = [...src.matchAll(/_fetchJson\(([^)]*)\)/g)].map(m => m[1]).filter(a => !a.startsWith('url'));
  assert.ok(fetchArgs.length >= 2);
  for (const arg of fetchArgs) {
    assert.match(arg, /^`\$\{(CROSSREF_BASE|OPENLIBRARY_BASE)\}/);
  }
});
