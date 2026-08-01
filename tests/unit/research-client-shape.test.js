'use strict';
// Unit-Tests fuer die Client-Ausgabeform der Recherche-Liste
// (lib/research-validate: clampListLimit / bodySnippet / toClientItem).
//
// Testgegenstand ist ein Vertrag, den ein fremdes Repo (die Browser-Erweiterung)
// nachbaut: welche Felder kommen an, was passiert mit einem unsinnigen `limit`,
// und vor allem — der volle `body` (bis 20 000 Zeichen Seitentext) darf NICHT
// mitgehen. Genau das ist der Fehler, der beim naechsten Feld-Zusatz an der
// Item-Form lautlos zurueckkehrt.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clampListLimit, bodySnippet, toClientItem,
  CLIENT_LIST_LIMIT, LIST_LIMIT_MAX, SNIPPET_MAX, BODY_MAX,
} = require('../../lib/research-validate');

// ── clampListLimit ───────────────────────────────────────────────────────────

test('clampListLimit: gueltige Zahl bleibt, Obergrenze greift', () => {
  assert.equal(clampListLimit('10', CLIENT_LIST_LIMIT), 10);
  assert.equal(clampListLimit(10, CLIENT_LIST_LIMIT), 10);
  assert.equal(clampListLimit(String(LIST_LIMIT_MAX), CLIENT_LIST_LIMIT), LIST_LIMIT_MAX);
  assert.equal(clampListLimit('999', CLIENT_LIST_LIMIT), LIST_LIMIT_MAX);
  assert.equal(clampListLimit('999999999999', CLIENT_LIST_LIMIT), LIST_LIMIT_MAX);
});

test('clampListLimit: unbrauchbare Eingabe faellt auf den Default, wirft nicht', () => {
  // Ein Lesepfad soll an einem vertippten Query-Parameter nicht scheitern.
  for (const bad of ['', '  ', 'abc', '0', '-5', null, undefined, {}, [], NaN]) {
    assert.equal(clampListLimit(bad, CLIENT_LIST_LIMIT), CLIENT_LIST_LIMIT,
      `Eingabe ${JSON.stringify(bad)} sollte auf den Default fallen`);
  }
});

test('clampListLimit: fallback null heisst „kein LIMIT" (SPA-Verhalten)', () => {
  assert.equal(clampListLimit(undefined, null), null);
  assert.equal(clampListLimit('', null), null);
  // Die SPA darf trotzdem eins setzen — dann gilt es samt Deckel.
  assert.equal(clampListLimit('20', null), 20);
  assert.equal(clampListLimit('5000', null), LIST_LIMIT_MAX);
});

test('clampListLimit: Default ist kleiner als das Maximum', () => {
  assert.ok(CLIENT_LIST_LIMIT < LIST_LIMIT_MAX);
  assert.equal(CLIENT_LIST_LIMIT, 50);
  assert.equal(LIST_LIMIT_MAX, 200);
});

// ── bodySnippet ──────────────────────────────────────────────────────────────

test('bodySnippet: kurzer Text bleibt unveraendert, Whitespace kollabiert', () => {
  assert.equal(bodySnippet('Kurz und knapp.'), 'Kurz und knapp.');
  assert.equal(bodySnippet('  mehrere\n\nZeilen\tund   Spaces '), 'mehrere Zeilen und Spaces');
  assert.equal(bodySnippet(''), '');
  assert.equal(bodySnippet(null), '');
  assert.equal(bodySnippet(undefined), '');
});

test('bodySnippet: langer Text wird gedeckelt und markiert', () => {
  const long = 'a'.repeat(BODY_MAX);
  const s = bodySnippet(long);
  assert.equal(s.length, SNIPPET_MAX);
  assert.ok(s.endsWith('…'));
  assert.ok(s.length < long.length / 10);
});

// ── toClientItem ─────────────────────────────────────────────────────────────

function fullRow(over = {}) {
  return {
    id: 7,
    book_id: 42,
    user_email: 'autor@test.dev',
    kind: 'link',
    title: 'Titel',
    body: 'x'.repeat(BODY_MAX),
    source: 'example.com',
    image_mime: null,
    doc_mime: 'application/pdf',
    doc_name: 'paper.pdf',
    doc_pages: 12,
    doc_chars: 40000,
    pinned: 0,
    archived: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    urls: [{ url_id: 3, url: 'https://example.com/a', label: 'A' }],
    tags: ['recherche'],
    links: [{ link_id: 1, target_kind: 'page', target_id: 5, label: 'Seite 1' }],
    ...over,
  };
}

test('toClientItem: genau der vereinbarte Feldsatz, nichts darueber hinaus', () => {
  const out = toClientItem(fullRow());
  assert.deepEqual(Object.keys(out).sort(), [
    'body_snippet', 'created_at', 'id', 'kind', 'source', 'title', 'updated_at', 'urls',
  ]);
  assert.equal(out.id, 7);
  assert.equal(out.kind, 'link');
  assert.equal(out.title, 'Titel');
  assert.equal(out.source, 'example.com');
  assert.equal(out.created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(out.updated_at, '2026-01-02T00:00:00.000Z');
});

test('toClientItem: der volle body geht NICHT mit', () => {
  const out = toClientItem(fullRow());
  assert.equal(out.body, undefined);
  assert.ok(out.body_snippet.length <= SNIPPET_MAX);
  // Der Manuskript-/Seitentext darf die Antwort nicht dominieren.
  assert.ok(JSON.stringify(out).length < 500);
});

test('toClientItem: Board-Zubehoer faellt raus, urls bleiben', () => {
  const out = toClientItem(fullRow());
  // urls sind der Grund fuer den Lesepfad (Dublettenpruefung nach Seite).
  assert.deepEqual(out.urls, [{ url: 'https://example.com/a', label: 'A' }]);
  for (const k of ['tags', 'links', 'book_id', 'user_email', 'pinned', 'archived',
    'doc_mime', 'doc_name', 'doc_pages', 'doc_chars', 'image_mime']) {
    assert.equal(out[k], undefined, `${k} gehoert nicht in die Client-Form`);
  }
});

test('toClientItem: fehlende Felder werden zu null/leer, nicht undefined', () => {
  const out = toClientItem({
    id: 1, kind: 'note', title: null, source: null, body: null,
    created_at: 'x', updated_at: 'y',
  });
  assert.equal(out.title, null);
  assert.equal(out.source, null);
  assert.equal(out.body_snippet, '');
  assert.deepEqual(out.urls, []);
});

test('toClientItem: Label-loses url bekommt leeren String', () => {
  const out = toClientItem(fullRow({ urls: [{ url_id: 9, url: 'https://a.test/', label: null }] }));
  assert.deepEqual(out.urls, [{ url: 'https://a.test/', label: '' }]);
});
