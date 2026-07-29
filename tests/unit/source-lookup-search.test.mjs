// Bibliografische Suche (lib/source-lookup.js#searchWork und ihre reinen
// Bausteine). Getestet wird vor allem das ABLEHNEN: die Suche bekommt keinen
// eindeutigen Schluessel, sondern einen Titel, wie ihn ein Fliesstext nennt
// (Job `source-detect`). Ein danebengegriffener Treffer waere schlimmer als
// keiner — er traegt fremde Metadaten mit dem Anschein von Registerdaten in die
// Bibliothek. Kein Netz: die Mapper und die Annahmeregel sind bewusst von
// `fetch` getrennt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  titleTokens, titleMatch, acceptMatch, mapOpenLibrarySearchDoc, searchWork,
} = require('../../lib/source-lookup.js');
const { CSL_TYPES } = require('../../db/sources.js');

// ── Titel-Tokenisierung ──────────────────────────────────────────────────────

test('Tokenisierung wirft Fuellwoerter, Satzzeichen und Diakritika weg', () => {
  assert.deepEqual([...titleTokens('Die Struktur wissenschaftlicher Revolutionen')],
    ['struktur', 'wissenschaftlicher', 'revolutionen']);
  assert.deepEqual([...titleTokens('  ')], []);
});

test('scharfes S zerreisst das Wort nicht', () => {
  // Alte Rechtschreibung im Manuskript, neue im Register (und umgekehrt) —
  // ohne die Ersetzung blieben davon zwei verschiedene Tokens uebrig.
  assert.deepEqual([...titleTokens('Über den Prozeß!')], ['uber', 'prozess']);
  assert.equal(titleMatch('Der Prozeß', 'Der Prozess').sim, 1);
});

test('Untertitel kippt die Aehnlichkeit nicht', () => {
  const { sim, shared } = titleMatch(
    'Die Struktur wissenschaftlicher Revolutionen',
    'Die Struktur wissenschaftlicher Revolutionen. Mit einem Postskriptum von 1969',
  );
  assert.equal(shared, 3);
  assert.equal(sim, 1);   // alle Tokens des kuerzeren stecken im laengeren
});

test('ein gemeinsames Wort ist keine Uebereinstimmung', () => {
  const { sim, shared } = titleMatch('Faust', 'Faust und die Welt');
  assert.equal(sim, 1);      // Containment allein wuerde das durchwinken …
  assert.equal(shared, 1);   // … deshalb zaehlt acceptMatch die Tokens mit
});

// ── Annahmeregel ─────────────────────────────────────────────────────────────

const KUHN = { title: 'Die Struktur wissenschaftlicher Revolutionen', authors: ['Thomas Kuhn'], year: '1962' };

test('Treffer mit Autor und passendem Jahr wird angenommen', () => {
  const v = acceptMatch(KUHN, {
    title: 'Die Struktur wissenschaftlicher Revolutionen',
    authors: [{ family: 'Kuhn', given: 'Thomas S.' }],
    year: '1962',
  });
  assert.equal(v.ok, true);
  assert.equal(v.authorHit, true);
});

test('Auflage zwei Jahre spaeter zaehlt noch als dasselbe Werk', () => {
  const v = acceptMatch(KUHN, {
    title: 'Die Struktur wissenschaftlicher Revolutionen',
    authors: [{ family: 'Kuhn' }], year: '1964',
  });
  assert.equal(v.ok, true);
});

test('anderes Jahrzehnt ist ein anderes Werk', () => {
  const v = acceptMatch(KUHN, {
    title: 'Die Struktur wissenschaftlicher Revolutionen',
    authors: [{ family: 'Kuhn' }], year: '1995',
  });
  assert.equal(v.ok, false);
});

test('Ein-Wort-Titel traegt die Entscheidung nicht allein', () => {
  // „Faust" steckt vollstaendig in „Faust und die Welt" — ohne uebereinstimmenden
  // Nachnamen ist das trotzdem kein Treffer.
  const gesucht = { title: 'Faust', authors: ['Johann Wolfgang von Goethe'] };
  assert.equal(acceptMatch(gesucht, { title: 'Faust und die Welt', authors: [{ family: 'Schmidt' }] }).ok, false);
  assert.equal(acceptMatch(gesucht, { title: 'Faust und die Welt', authors: [] }).ok, false);
});

test('kurzer Titel mit Autoren-Treffer wird angenommen', () => {
  // Der haeufigste echte Fall: das Register haengt einen Untertitel an.
  const v = acceptMatch(
    { title: 'Der Prozess', authors: ['Franz Kafka'], year: '1925' },
    { title: 'Der Prozess: Roman', authors: [{ family: 'Kafka', given: 'Franz' }], year: '1925' },
  );
  assert.equal(v.ok, true);
});

test('ohne Autoren-Treffer muss der Titel praktisch stehen', () => {
  // Zwei von drei Tokens (sim 0.67) — reicht mit Autor, nicht ohne.
  const teil = { title: 'Struktur wissenschaftlicher Umbrueche', authors: [] };
  const hit = { title: 'Struktur wissenschaftlicher Revolutionen', authors: [{ family: 'Kuhn' }] };
  assert.equal(acceptMatch(teil, hit).ok, false);
  assert.equal(acceptMatch({ ...teil, authors: ['Thomas Kuhn'] }, hit).ok, true);
});

test('fehlendes Jahr auf einer Seite blockiert nicht', () => {
  assert.equal(acceptMatch({ ...KUHN, year: null }, {
    title: 'Die Struktur wissenschaftlicher Revolutionen',
    authors: [{ family: 'Kuhn' }], year: '1962',
  }).ok, true);
});

// ── OpenLibrary-Suchtreffer ──────────────────────────────────────────────────

test('search.json-Doc wird zum Entwurf, Untertitel angehaengt', () => {
  const d = mapOpenLibrarySearchDoc({
    title: 'Der Prozess', subtitle: 'Roman',
    author_name: ['Franz Kafka'], first_publish_year: 1925,
    publisher: ['Verlag Die Schmiede'], place: ['Berlin'], isbn: ['9783150094440'],
  });
  assert.equal(d.title, 'Der Prozess: Roman');
  assert.deepEqual(d.authors, [{ family: 'Kafka', given: 'Franz' }]);
  assert.equal(d.year, '1925');
  assert.equal(d.publisher, 'Verlag Die Schmiede');
  assert.ok(CSL_TYPES.includes(d.csl_type));
});

test('Doc ohne Titel und Person ist kein Entwurf', () => {
  assert.equal(mapOpenLibrarySearchDoc({ first_publish_year: 1925 }), null);
  assert.equal(mapOpenLibrarySearchDoc(null), null);
});

// ── searchWork ───────────────────────────────────────────────────────────────

function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = orig; });
}

const json = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

test('ohne Titel wird gar nicht erst gefragt', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return json({}); }, async () => {
    assert.equal(await searchWork({ title: '', authors: ['Kafka'], csl_type: 'book' }), null);
  });
  assert.equal(calls, 0);
});

test('Buch fragt zuerst OpenLibrary und liefert den bestaetigten Entwurf', async () => {
  const urls = [];
  const hit = await withFetch(async (url) => {
    urls.push(String(url));
    return json({ docs: [{ title: 'Der Prozess', author_name: ['Franz Kafka'], first_publish_year: 1925 }] });
  }, () => searchWork({ title: 'Der Prozess', authors: ['Franz Kafka'], year: '1925', csl_type: 'book' }));

  assert.equal(urls.length, 1);                       // Treffer → kein zweites Register
  assert.match(urls[0], /^https:\/\/openlibrary\.org\/search\.json\?/);
  assert.equal(hit.register, 'openlibrary');
  assert.equal(hit.draft.title, 'Der Prozess');
  assert.equal(hit.authorHit, true);
});

test('kein brauchbarer Treffer → beide Register befragt, dann null', async () => {
  const urls = [];
  const hit = await withFetch(async (url) => {
    urls.push(String(url));
    // Beide Register antworten mit einem Werk, das nicht passt.
    return json({
      docs: [{ title: 'Ganz anderes Buch', author_name: ['Jemand Anders'] }],
      message: { items: [{ title: ['Ganz anderes Buch'], author: [{ family: 'Anders' }], type: 'book' }] },
    });
  }, () => searchWork({ title: 'Der Prozess', authors: ['Franz Kafka'], csl_type: 'book' }));

  assert.equal(hit, null);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /^https:\/\/api\.crossref\.org\/works\?/);
});

test('ausgefallenes Register reisst das andere nicht mit', async () => {
  const hit = await withFetch(async (url) => {
    if (String(url).includes('openlibrary')) throw new Error('Netz weg');
    return json({ message: { items: [{
      title: ['Die Struktur wissenschaftlicher Revolutionen'],
      author: [{ family: 'Kuhn', given: 'Thomas S.' }],
      issued: { 'date-parts': [[1962]] },
      type: 'book',
      DOI: '10.7208/chicago/9780226458144.001.0001',
    }] } });
  }, () => searchWork(KUHN));

  assert.equal(hit.register, 'crossref');
  assert.equal(hit.draft.doi, '10.7208/chicago/9780226458144.001.0001');
});
