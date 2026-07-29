// Unit-Tests der Fund-Index-Gruppierung fuer das Quellen-Tab des Referenz-Slots
// (public/js/sources/cited-index.js, pure — kein Alpine, kein DOM).
//
// Geprueft wird das, was der Slot behauptet: „auf dieser Seite / in diesem
// Kapitel belegt", in Leserichtung, und dass der Kapitel-Scope nicht ueber
// Kapitelgrenzen hinaus greift.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { groupCitedSources, buildPageInfo } = await import('../../public/js/sources/cited-index.js');

// Buchtree-Reihenfolge = Array-Reihenfolge (siehe book/tree/load.js).
const PAGES = [
  { id: 10, name: 'Vorwort', chapter_id: null },
  { id: 20, name: 'Seite A', chapter_id: 1 },
  { id: 21, name: 'Seite B', chapter_id: 1 },
  { id: 22, name: 'Seite C', chapter_id: 1 },
  { id: 30, name: 'Seite D', chapter_id: 2 },
];

const SOURCES = [
  { id: 7, title: 'Mueller' },
  { id: 8, title: 'Schmidt' },
  { id: 9, title: 'Nie belegt' },
];

const CITES = [
  { source_id: 8, page_id: 10, count: 1, first_offset: 5 },
  { source_id: 7, page_id: 21, count: 2, first_offset: 3 },
  { source_id: 8, page_id: 21, count: 1, first_offset: 40 },
  { source_id: 7, page_id: 22, count: 1, first_offset: 7 },
  { source_id: 7, page_id: 30, count: 4, first_offset: 1 },
];

test('buildPageInfo liefert Name, Kapitel und Leseposition', () => {
  const m = buildPageInfo(PAGES);
  assert.equal(m.size, 5);
  assert.deepEqual(m.get(21), { name: 'Seite B', chapterId: 1, order: 2 });
  assert.equal(m.get(10).chapterId, null);
});

test('Buch-Scope: jede belegte Quelle einmal, Zaehler summiert, in Leserichtung', () => {
  const rows = groupCitedSources({ sources: SOURCES, citations: CITES, pages: PAGES, scope: 'book' });
  // Schmidt zuerst (erste Fundstelle im Vorwort), dann Mueller (Seite B).
  assert.deepEqual(rows.map(r => r.source.id), [8, 7]);
  assert.equal(rows.find(r => r.source.id === 7).count, 7);
  assert.equal(rows.find(r => r.source.id === 8).count, 2);
  // Nie belegte Quelle erscheint nicht — das Tab beantwortet „wo wird belegt".
  assert.equal(rows.some(r => r.source.id === 9), false);
  // Ohne Kontext ist keine Zeile „auf dieser Seite".
  assert.equal(rows.every(r => r.onPage === false), true);
  // Kein Leak der internen Sortier-Hilfe in die Zeile.
  assert.equal('_order' in rows[0], false);
});

test('Seiten-Scope: Seite + eigenes Kapitel, Seiten-Treffer zuerst', () => {
  // Bezugsseite ist Seite C (Kapitel 1) — Seite D liegt in Kapitel 2 und faellt raus.
  const rows = groupCitedSources({
    sources: SOURCES, citations: CITES, pages: PAGES,
    scope: 'page', pageId: 22, chapterId: 1,
  });
  assert.deepEqual(rows.map(r => r.source.id), [7, 8]);

  const mueller = rows[0];
  assert.equal(mueller.onPage, true);
  // Seite B (Kapitel) + Seite C (Seite) = 3; Seite D (Kapitel 2) ist nicht dabei.
  assert.equal(mueller.count, 3);
  assert.deepEqual(mueller.pages.map(p => p.pageId).sort(), [21, 22]);

  const schmidt = rows[1];
  assert.equal(schmidt.onPage, false);
  // Das Vorwort steht in keinem Kapitel und zaehlt hier nicht mit.
  assert.equal(schmidt.count, 1);
  assert.deepEqual(schmidt.pages.map(p => p.name), ['Seite B']);
});

test('Seiten-Scope ohne Kapitel: nur ebenfalls kapitellose Seiten', () => {
  const rows = groupCitedSources({
    sources: SOURCES, citations: CITES, pages: PAGES,
    scope: 'page', pageId: 10, chapterId: null,
  });
  assert.deepEqual(rows.map(r => r.source.id), [8]);
  assert.equal(rows[0].onPage, true);
  assert.equal(rows[0].count, 1);
});

test('Fundstelle ohne passende Quelle wird uebersprungen', () => {
  const rows = groupCitedSources({
    sources: [{ id: 7, title: 'Mueller' }],
    citations: [{ source_id: 99, page_id: 20, count: 3 }, { source_id: 7, page_id: 20, count: 1 }],
    pages: PAGES, scope: 'book',
  });
  assert.deepEqual(rows.map(r => r.source.id), [7]);
});

test('Leere Eingaben und unbekannte Seiten kippen nicht', () => {
  assert.deepEqual(groupCitedSources(), []);
  assert.deepEqual(groupCitedSources({ sources: SOURCES }), []);
  // Fundstelle auf einer Seite, die der Tree (noch) nicht kennt: im Buch-Scope
  // sichtbar, aber ans Ende sortiert und ohne Seitennamen.
  const rows = groupCitedSources({
    sources: SOURCES,
    citations: [{ source_id: 7, page_id: 999, count: 1 }],
    pages: PAGES, scope: 'book',
  });
  assert.deepEqual(rows.map(r => r.source.id), [7]);
  assert.equal(rows[0].pages[0].name, '');
});
