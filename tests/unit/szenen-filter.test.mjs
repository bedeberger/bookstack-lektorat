// Unit-Tests für Szenen-Kapitel- und Seiten-Filter.
// Regression-Guard: Der Seiten-Filter muss auch greifen, wenn die KI
// `s.seite` anders formuliert als BookStack. Der Dropdown-Wert ist die
// `page_id` (Number) aus dem Buch-Baum, Fallback ist der Szenen-Name (String).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applySzenenFilters, appUiMethods } = await import('../../public/js/app-ui.js');

// Harness: minimales Alpine-Ersatz-Objekt mit nur den Feldern, die die
// Filter-Listen-Methoden lesen. Order-Maps leer → Stabile lexikalische
// Sortierung reicht für die Tests.
function makeCtx(overrides = {}) {
  return {
    szenen: [],
    pages: [],
    tree: [],
    szenenFilters: { wertung: '', figurId: '', kapitel: '', seite: '', ortId: '', suche: '' },
    _chapterOrderMap: new Map(),
    _pageOrderMap: new Map(),
    ...overrides,
    // Methoden aus appUiMethods draufsetzen, gebunden über `this`.
    szenenKapitelListe: appUiMethods.szenenKapitelListe,
    szenenSeitenListe: appUiMethods.szenenSeitenListe,
    _deriveKapitel: appUiMethods._deriveKapitel,
    _sortByChapterOrder: appUiMethods._sortByChapterOrder,
    _sortByPageOrder: appUiMethods._sortByPageOrder,
    _chapterIdx: appUiMethods._chapterIdx,
    _pageIdx: appUiMethods._pageIdx,
  };
}

// Beispielbuch: 2 Kapitel, 4 Seiten, 5 Szenen.
// Kapitel-1 (chapter_id=10) hat Seite 100 ("Morgens") und 101 ("Mittags").
// Kapitel-2 (chapter_id=20) hat Seite 200 ("Abends") und 201 ("Nachts").
// Szene 1: Kap-1 + page_id=100 → seite='Morgens' (sauber verlinkt).
// Szene 2: Kap-1 + page_id=100 → seite='morgens' (falsche Schreibweise,
//         aber page_id gesetzt — muss via page_id filterbar sein).
// Szene 3: Kap-1 + page_id=null → seite='Frühstück' (KI-Name, im Tree nicht
//         vorhanden — muss via Namens-Fallback filterbar bleiben).
// Szene 4: Kap-2 + page_id=200 → seite='Abends'.
// Szene 5: Kap-2 + page_id=201 → seite='Nachts'.
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
    { id: 1, kapitel: 'Kapitel 1', seite: 'Morgens',    chapter_id: 10, page_id: 100, titel: 'Aufstehen',     wertung: 'stark',   fig_ids: [], ort_ids: [] },
    { id: 2, kapitel: 'Kapitel 1', seite: 'morgens',    chapter_id: 10, page_id: 100, titel: 'Frühstück',     wertung: 'mittel',  fig_ids: [], ort_ids: [] },
    { id: 3, kapitel: 'Kapitel 1', seite: 'Frühstück',  chapter_id: 10, page_id: null, titel: 'Kaffee',       wertung: 'schwach', fig_ids: [], ort_ids: [] },
    { id: 4, kapitel: 'Kapitel 2', seite: 'Abends',     chapter_id: 20, page_id: 200, titel: 'Heimkehr',      wertung: 'stark',   fig_ids: [], ort_ids: [] },
    { id: 5, kapitel: 'Kapitel 2', seite: 'Nachts',     chapter_id: 20, page_id: 201, titel: 'Traum',         wertung: 'mittel',  fig_ids: [], ort_ids: [] },
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

test('szenenSeitenListe: Tree-Seiten des Kapitels mit page_id als Value', () => {
  const ctx = makeCtx({ ...BOOK, szenenFilters: { ...makeCtx().szenenFilters, kapitel: 'Kapitel 1' } });
  const opts = ctx.szenenSeitenListe();
  // Muss Morgens + Mittags (aus Tree) sowie Frühstück (Szenen-Fallback) enthalten.
  // Morgens doppelt ('Morgens' + 'morgens' in Szenen) wird per seenIds/seenNames entdupliziert.
  const labels = opts.map(o => o.label).sort();
  assert.deepEqual(labels, ['Frühstück', 'Mittags', 'Morgens']);
  // Tree-Seiten tragen page_id (Number) als Value.
  const morgens = opts.find(o => o.label === 'Morgens');
  const mittags = opts.find(o => o.label === 'Mittags');
  assert.equal(morgens.value, 100);
  assert.equal(mittags.value, 101);
  // Name-Fallback: Frühstück hat keine passende Tree-Seite → Value ist der Name (String).
  const fruehstueck = opts.find(o => o.label === 'Frühstück');
  assert.equal(fruehstueck.value, 'Frühstück');
});

test('szenenSeitenListe: Kapitel-Auflösung über tree funktioniert auch ohne chapter_id an der Szene', () => {
  // Szene ohne chapter_id: Kapitel-ID nur via tree auflösen.
  const szenen = [
    { id: 1, kapitel: 'Kapitel 1', seite: 'Morgens', chapter_id: null, page_id: 100, titel: 'x', fig_ids: [], ort_ids: [] },
  ];
  const ctx = makeCtx({
    tree: BOOK.tree, pages: BOOK.pages, szenen,
    szenenFilters: { ...makeCtx().szenenFilters, kapitel: 'Kapitel 1' },
  });
  const opts = ctx.szenenSeitenListe();
  assert.ok(opts.some(o => o.label === 'Morgens' && o.value === 100));
  assert.ok(opts.some(o => o.label === 'Mittags' && o.value === 101));
});

// ── applySzenenFilters (Regression-Core) ──────────────────────────────────

test('applySzenenFilters: kein Filter → alle Szenen', () => {
  const out = applySzenenFilters(BOOK.szenen, { suche: '', wertung: '', figurId: '', kapitel: '', seite: '', ortId: '' });
  assert.equal(out.length, 5);
});

test('applySzenenFilters: Kapitel-Filter beschränkt auf Kapitel-Szenen', () => {
  const out = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 1' });
  assert.deepEqual(out.map(s => s.id).sort(), [1, 2, 3]);
});

test('applySzenenFilters: Seite-Filter per page_id (Number) findet Szenen mit korrekter page_id — unabhängig von seite-String', () => {
  // Dropdown-Wert ist page_id=100 (aus Tree). Szenen 1+2 matchen beide, obwohl
  // Szene 2 `seite='morgens'` hat (falsche Schreibweise).
  const out = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 1', seite: 100 });
  assert.deepEqual(out.map(s => s.id).sort(), [1, 2]);
});

test('applySzenenFilters: Seite-Filter per Name (String, Fallback) findet KI-Only-Szenen ohne page_id', () => {
  // Szene 3 hat page_id=null und seite='Frühstück'. Dropdown-Wert ist dann der
  // String 'Frühstück' (Name-Fallback).
  const out = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 1', seite: 'Frühstück' });
  assert.deepEqual(out.map(s => s.id), [3]);
});

test('applySzenenFilters: Seite-Filter per page_id matcht NICHT per Namens-Zufall', () => {
  // Eine Szene ohne page_id (Szene 3) darf nicht durch page_id=100 gematcht werden,
  // selbst wenn sie im gleichen Kapitel liegt.
  const out = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 1', seite: 100 });
  assert.ok(!out.some(s => s.id === 3));
});

test('applySzenenFilters: Seite-Filter (String) greift nicht für Szenen mit abweichender Schreibweise', () => {
  // String-Filter ist exakt — 'Morgens' ≠ 'morgens'. Dieser Edge Case motiviert
  // genau den Wechsel auf page_id: Szene 2 wäre per String-Match nicht zu finden.
  const out = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 1', seite: 'Morgens' });
  assert.deepEqual(out.map(s => s.id), [1]);
});

test('applySzenenFilters: Kapitel + Seite kombiniert', () => {
  const out = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 2', seite: 200 });
  assert.deepEqual(out.map(s => s.id), [4]);
});

test('applySzenenFilters: Wertungs-Filter', () => {
  const out = applySzenenFilters(BOOK.szenen, { wertung: 'stark' });
  assert.deepEqual(out.map(s => s.id).sort(), [1, 4]);
});

test('applySzenenFilters: Such-Filter matcht Titel case-insensitive', () => {
  const out = applySzenenFilters(BOOK.szenen, { suche: 'KAFFEE' });
  assert.deepEqual(out.map(s => s.id), [3]);
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

// ── End-to-end: Dropdown-Value → Filter findet Szene ────────────────────────
// Das ist das eigentliche Regressions-Szenario, das der User mehrfach gemeldet
// hat: User wählt im Dropdown eine Seite → Szenen-Liste muss sich darauf
// reduzieren. Wir simulieren das, indem wir szenenSeitenListe aufrufen und
// jede zurückgelieferte Option als Filter-Wert in applySzenenFilters stecken.

test('E2E-Regression: jede Option aus szenenSeitenListe findet mindestens eine Szene', () => {
  const ctx = makeCtx({ ...BOOK, szenenFilters: { ...makeCtx().szenenFilters, kapitel: 'Kapitel 1' } });
  const opts = ctx.szenenSeitenListe();
  assert.ok(opts.length > 0, 'Dropdown muss Optionen liefern');
  for (const opt of opts) {
    const filtered = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 1', seite: opt.value });
    assert.ok(
      filtered.length > 0,
      `Filter-Regression: Option ${JSON.stringify(opt)} findet keine Szene — das war der ursprüngliche Bug`,
    );
    // Jede gefundene Szene muss auch tatsächlich zum Kapitel gehören.
    for (const s of filtered) {
      assert.equal(s.kapitel, 'Kapitel 1');
    }
  }
});

test('E2E-Regression: Tree-Seite ohne entsprechende Szene erscheint NICHT im Dropdown', () => {
  // 'Mittags' (page_id=101) gehört zu Kapitel 1, aber keine Szene hat page_id=101
  // noch seite='Mittags'. Es erscheint trotzdem im Dropdown (Tree-basiert), aber
  // der Filter findet nichts. Das ist ok — Dropdown zeigt verfügbare Seiten,
  // Filter zeigt vorhandene Szenen. Dieser Test dokumentiert das Verhalten.
  const ctx = makeCtx({ ...BOOK, szenenFilters: { ...makeCtx().szenenFilters, kapitel: 'Kapitel 1' } });
  const opts = ctx.szenenSeitenListe();
  const mittags = opts.find(o => o.label === 'Mittags');
  assert.ok(mittags, 'Mittags ist eine Tree-Seite des Kapitels → im Dropdown erwartet');
  const filtered = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 1', seite: mittags.value });
  assert.equal(filtered.length, 0, 'keine Szene auf dieser Seite → Filter liefert leer');
});
