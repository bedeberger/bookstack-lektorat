// Unit-Tests für Szenen-Kapitel-Filter.
//
// Modellannahme: der Komplett-Job normalisiert `kapitel` (strippt
// «### »-Präfixe der KI). Der Seiten-Filter wurde entfernt, weil er
// in der Praxis zu oft leer blieb — Kapitel reicht als Granularität.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applySzenenFilters, appUiMethods } = await import('../../public/js/app-ui.js');

function makeCtx(overrides = {}) {
  return {
    szenen: [],
    szenenFilters: { wertung: '', figurId: '', kapitel: '', ortId: '', suche: '' },
    _chapterOrderMap: new Map(),
    ...overrides,
    szenenKapitelListe: appUiMethods.szenenKapitelListe,
    _deriveKapitel: appUiMethods._deriveKapitel,
    _sortByChapterOrder: appUiMethods._sortByChapterOrder,
    _chapterIdx: appUiMethods._chapterIdx,
  };
}

const BOOK = {
  szenen: [
    { id: 1, kapitel: 'Kapitel 1', titel: 'Aufstehen', wertung: 'stark',   fig_ids: [], ort_ids: [] },
    { id: 2, kapitel: 'Kapitel 1', titel: 'Frühstück', wertung: 'mittel',  fig_ids: [], ort_ids: [] },
    { id: 3, kapitel: 'Kapitel 2', titel: 'Heimkehr',  wertung: 'stark',   fig_ids: [], ort_ids: [] },
    { id: 4, kapitel: 'Kapitel 2', titel: 'Traum',     wertung: 'mittel',  fig_ids: [], ort_ids: [] },
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

// ── applySzenenFilters ─────────────────────────────────────────────────────

test('applySzenenFilters: kein Filter → alle Szenen', () => {
  const out = applySzenenFilters(BOOK.szenen, { suche: '', wertung: '', figurId: '', kapitel: '', ortId: '' });
  assert.equal(out.length, 4);
});

test('applySzenenFilters: Kapitel-Filter beschränkt auf Kapitel-Szenen', () => {
  const out = applySzenenFilters(BOOK.szenen, { kapitel: 'Kapitel 1' });
  assert.deepEqual(out.map(s => s.id).sort(), [1, 2]);
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
