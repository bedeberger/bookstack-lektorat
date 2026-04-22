// Unit-Tests für Szenen-Kapitel- und Seiten-Filter.
//
// Modellannahme: der Komplett-Job normalisiert `seite`/`kapitel` (strippt
// «### »-Präfixe der KI) und löst die page_id gegen den BookStack-Baum auf.
// Darum kann das Seiten-Dropdown direkt aus `this.pages` (Tree) kommen und
// der Filter strikt per `page_id` arbeiten. Szenen ohne auflösbare page_id
// tauchen im Seiten-Filter nicht auf (wohl aber in der unfilterten Liste).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applySzenenFilters, appUiMethods } = await import('../../public/js/app-ui.js');

function makeCtx(overrides = {}) {
  return {
    szenen: [],
    pages: [],
    tree: [],
    szenenFilters: { wertung: '', figurId: '', kapitel: '', seite: '', ortId: '', suche: '' },
    _chapterOrderMap: new Map(),
    _pageOrderMap: new Map(),
    ...overrides,
    szenenKapitelListe: appUiMethods.szenenKapitelListe,
    szenenSeitenListe: appUiMethods.szenenSeitenListe,
    _deriveKapitel: appUiMethods._deriveKapitel,
    _sortByChapterOrder: appUiMethods._sortByChapterOrder,
    _sortByPageOrder: appUiMethods._sortByPageOrder,
    _chapterIdx: appUiMethods._chapterIdx,
    _pageIdx: appUiMethods._pageIdx,
  };
}

// Beispielbuch: 2 Kapitel, 4 Seiten, 4 Szenen.
// Kapitel-1 (chapter_id=10) hat Seite 100 ("Morgens") und 101 ("Mittags").
// Kapitel-2 (chapter_id=20) hat Seite 200 ("Abends") und 201 ("Nachts").
// Nur 100, 200, 201 haben Szenen. 101 ("Mittags") hat keine — soll aber
// trotzdem als Dropdown-Option angeboten werden (User sieht dann einfach
// „keine Szenen auf dieser Seite").
const BOOK = {
  tree: [
    { type: 'chapter', id: 10, name: 'Kapitel 1' },
    { type: 'chapter', id: 20, name: 'Kapitel 2' },
  ],
  pages: [
    { id: 100, name: 'Morgens', chapter_id: 10, chapterName: 'Kapitel 1' },
    { id: 101, name: 'Mittags', chapter_id: 10, chapterName: 'Kapitel 1' },
    { id: 200, name: 'Abends',  chapter_id: 20, chapterName: 'Kapitel 2' },
    { id: 201, name: 'Nachts',  chapter_id: 20, chapterName: 'Kapitel 2' },
  ],
  szenen: [
    { id: 1, kapitel: 'Kapitel 1', seite: 'Morgens', chapter_id: 10, page_id: 100, titel: 'Aufstehen', wertung: 'stark',   fig_ids: [], ort_ids: [] },
    { id: 2, kapitel: 'Kapitel 1', seite: 'Morgens', chapter_id: 10, page_id: 100, titel: 'Frühstück', wertung: 'mittel',  fig_ids: [], ort_ids: [] },
    { id: 3, kapitel: 'Kapitel 2', seite: 'Abends',  chapter_id: 20, page_id: 200, titel: 'Heimkehr',  wertung: 'stark',   fig_ids: [], ort_ids: [] },
    { id: 4, kapitel: 'Kapitel 2', seite: 'Nachts',  chapter_id: 20, page_id: 201, titel: 'Traum',     wertung: 'mittel',  fig_ids: [], ort_ids: [] },
  ],
};

// ── szenenKapitelListe ─────────────────────────────────────────────────────

test('szenenKapitelListe: liefert die Kapitel aller Szenen, dedupliziert', () => {
  const ctx = makeCtx({ szenen: BOOK.szenen });
  const kapitel = ctx.szenenKapitelListe();
  assert.deepEqual([...kapitel].sort(), ['Kapitel 1', 'Kapitel 2']);
});

test('szenenKapitelListe: leer bei leerem Szenen-Array', () => {
  const ctx = makeCtx({ szenen: [] });
  assert.deepEqual(ctx.szenenKapitelListe(), []);
});

// ── szenenSeitenListe ──────────────────────────────────────────────────────

test('szenenSeitenListe: leer ohne Kapitel-Filter', () => {
  const ctx = makeCtx({ ...BOOK });
  assert.deepEqual(ctx.szenenSeitenListe(), []);
});

test('szenenSeitenListe: alle Seiten des Kapitels aus dem Tree (auch ohne Szenen)', () => {
  const ctx = makeCtx({ ...BOOK, szenenFilters: { ...makeCtx().szenenFilters, kapitel: 'Kapitel 1' } });
  const opts = ctx.szenenSeitenListe();
  // Mittags (page_id=101) hat keine Szene, soll aber trotzdem angeboten werden —
  // das Dropdown soll die vollständige Struktur des Kapitels zeigen.
  assert.deepEqual(opts.map(o => o.label).sort(), ['Mittags', 'Morgens']);
  assert.deepEqual(opts.map(o => o.value).sort((a, b) => a - b), [100, 101]);
});

test('szenenSeitenListe: chapter_id-Auflösung fällt auf Szenen zurück, wenn Tree leer ist', () => {
  const ctx = makeCtx({
    ...BOOK, tree: [],
    szenenFilters: { ...makeCtx().szenenFilters, kapitel: 'Kapitel 2' },
  });
  const opts = ctx.szenenSeitenListe();
  assert.deepEqual(opts.map(o => o.label).sort(), ['Abends', 'Nachts']);
});

test('szenenSeitenListe: «Sonstige Seiten» (chapter_id=null) greift auf chapterName-Fallback', () => {
  const pages = [
    { id: 500, name: 'Vorwort',  chapter_id: null, chapterName: 'Sonstige Seiten' },
    { id: 501, name: 'Widmung',  chapter_id: null, chapterName: 'Sonstige Seiten' },
    { id: 100, name: 'Morgens',  chapter_id: 10,   chapterName: 'Kapitel 1' },
  ];
  const ctx = makeCtx({
    tree: [], pages, szenen: [],
    szenenFilters: { ...makeCtx().szenenFilters, kapitel: 'Sonstige Seiten' },
  });
  const opts = ctx.szenenSeitenListe();
  assert.deepEqual(opts.map(o => o.label).sort(), ['Vorwort', 'Widmung']);
});

// ── applySzenenFilters ─────────────────────────────────────────────────────

test('applySzenenFilters: kein Filter → alle Szenen', () => {
  const out = applySzenenFilters(BOOK.szenen, { suche: '', wertung: '', figurId: '', kapitel: '', seite: '', ortId: '' });
  assert.equal(out.length, 4);
});

test('applySzenenFilters: Kapitel-Filter beschränkt auf Kapitel-Szenen', () => {
  const out = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 1' });
  assert.deepEqual(out.map(s => s.id).sort(), [1, 2]);
});

test('applySzenenFilters: Seite-Filter per page_id findet nur Szenen mit passender page_id', () => {
  const out = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 1', seite: 100 });
  assert.deepEqual(out.map(s => s.id).sort(), [1, 2]);
});

test('applySzenenFilters: Seite-Filter auf Seite ohne Szenen → leere Liste', () => {
  // User wählt Mittags (page_id=101); keine Szene hat diese page_id → leer.
  const out = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 1', seite: 101 });
  assert.deepEqual(out, []);
});

test('applySzenenFilters: Szenen ohne page_id werden vom Seiten-Filter nicht erfasst', () => {
  const szenen = [
    { id: 1, kapitel: 'K1', page_id: 100, titel: 't1' },
    { id: 2, kapitel: 'K1', page_id: null, titel: 't2' },
  ];
  const out = applySzenenFilters(szenen, { seite: 100 });
  assert.deepEqual(out.map(s => s.id), [1]);
});

test('applySzenenFilters: Kapitel + Seite kombiniert', () => {
  const out = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 2', seite: 200 });
  assert.deepEqual(out.map(s => s.id), [3]);
});

test('applySzenenFilters: Wertungs-Filter', () => {
  const out = applySzenenFilters(BOOK.szenen, { wertung: 'stark' });
  assert.deepEqual(out.map(s => s.id).sort(), [1, 3]);
});

test('applySzenenFilters: Such-Filter matcht Titel case-insensitive', () => {
  const out = applySzenenFilters(BOOK.szenen, { suche: 'TRAUM' });
  assert.deepEqual(out.map(s => s.id), [4]);
});

test('applySzenenFilters: Figur-Filter matcht fig_ids', () => {
  const szenen = [
    { id: 1, fig_ids: [10, 20], titel: 'a' },
    { id: 2, fig_ids: [20],     titel: 'b' },
    { id: 3, fig_ids: [],       titel: 'c' },
  ];
  const out = applySzenenFilters(szenen, { figurId: 10 });
  assert.deepEqual(out.map(s => s.id), [1]);
});

test('applySzenenFilters: Ort-Filter matcht ort_ids', () => {
  const szenen = [
    { id: 1, ort_ids: ['L1'], titel: 'a' },
    { id: 2, ort_ids: ['L2'], titel: 'b' },
  ];
  const out = applySzenenFilters(szenen, { ortId: 'L1' });
  assert.deepEqual(out.map(s => s.id), [1]);
});

// ── E2E: Dropdown-Value → Filter findet Szene ──────────────────────────────

test('E2E: jede Option mit Szenen aus szenenSeitenListe findet diese Szenen', () => {
  const ctx = makeCtx({ ...BOOK, szenenFilters: { ...makeCtx().szenenFilters, kapitel: 'Kapitel 1' } });
  const opts = ctx.szenenSeitenListe();
  // Szenen 1+2 liegen auf page_id=100 ("Morgens").
  const morgens = opts.find(o => o.label === 'Morgens');
  const filtered = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 1', seite: morgens.value });
  assert.deepEqual(filtered.map(s => s.id).sort(), [1, 2]);
});
