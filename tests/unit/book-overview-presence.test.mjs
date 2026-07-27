// Tests für den geteilten Kern der drei Präsenz-Matrizen der Buch-Übersicht
// (Figuren / Schauplätze / Motive). Bis zur Extraktion lag diese Mechanik
// dreimal fast identisch in figuren.js / orte.js / motiv.js — hier ist sie
// einmal abgesichert: Spaltenauswahl, Fallback, Skalierung, Zeilen-Shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPresenceMatrix, bucketByRoot, PRESENCE_MAX_COLS } from '../../public/js/book-overview/presence.js';

const CHAPTERS = [{ id: 1, name: 'Kap A' }, { id: 2, name: 'Kap B' }];

function cand(id, name, pairs) {
  const byRootId = new Map(pairs);
  let total = 0;
  for (const v of byRootId.values()) total += v;
  return { id, name, byRootId, total };
}

test('buildPresenceMatrix: leere Eingaben → leere Matrix', () => {
  assert.deepEqual(buildPresenceMatrix([], CHAPTERS), { cols: [], rows: [] });
  assert.deepEqual(buildPresenceMatrix([cand('a', 'A', [[1, 1]])], []), { cols: [], rows: [] });
  // Kandidaten ohne Treffer zählen nicht als Spalte.
  assert.deepEqual(buildPresenceMatrix([cand('a', 'A', [])], CHAPTERS), { cols: [], rows: [] });
});

test('buildPresenceMatrix: Zeilen folgen der Kapitel-Reihenfolge, Zellen den Spalten', () => {
  const out = buildPresenceMatrix([
    cand('x', 'Xaver', [[1, 3], [2, 1]]),
    cand('y', 'Yara', [[2, 5]]),
  ], CHAPTERS);

  assert.deepEqual(out.cols.map(c => c.id), ['y', 'x'], 'nach total absteigend');
  assert.deepEqual(out.rows.map(r => r.id), [1, 2], 'Kapitel-Reihenfolge bleibt');
  assert.deepEqual(out.rows[0].cells.map(c => c.value), [0, 3]);
  assert.deepEqual(out.rows[1].cells.map(c => c.value), [5, 1]);
  // Zell-Shape ist für alle drei Varianten gleich (das Partial ist geteilt).
  assert.deepEqual(Object.keys(out.rows[0].cells[0]).sort(), ['id', 'name', 'pct', 'value']);
  assert.equal(out.rows[1].cells[0].name, 'Yara');
});

test('buildPresenceMatrix: Skalierung global über alle Zellen, Minimum 8 %', () => {
  const out = buildPresenceMatrix([
    cand('gross', 'Gross', [[1, 40], [2, 20]]),
    cand('klein', 'Klein', [[1, 1], [2, 1]]),
  ], CHAPTERS);

  const byName = (row, name) => row.cells.find(c => c.name === name);
  assert.equal(byName(out.rows[0], 'Gross').pct, 100, 'globales Maximum → 100 %');
  assert.equal(byName(out.rows[1], 'Gross').pct, 50, '20/40');
  assert.equal(byName(out.rows[0], 'Klein').pct, 8, '1/40 wäre 3 % → Floor 8 %');
});

test('buildPresenceMatrix: leere Zelle bleibt bei 0 %', () => {
  const out = buildPresenceMatrix([cand('x', 'X', [[1, 4]])], CHAPTERS);
  assert.equal(out.rows[1].cells[0].value, 0);
  assert.equal(out.rows[1].cells[0].pct, 0, 'kein Floor für echte Leerstellen');
});

test('buildPresenceMatrix: Einmal-Treffer verdrängen wiederkehrende Entitäten nicht', () => {
  const out = buildPresenceMatrix([
    cand('wieder', 'Wiederkehrend', [[1, 1], [2, 1]]),
    cand('einmal1', 'Einmal 1', [[1, 1]]),
    cand('einmal2', 'Einmal 2', [[1, 1]]),
  ], CHAPTERS);
  assert.deepEqual(out.cols.map(c => c.id), ['wieder']);
});

test('buildPresenceMatrix: Fallback zeigt Einmal-Treffer, wenn nichts wiederkehrt', () => {
  const out = buildPresenceMatrix([
    cand('a', 'A', [[1, 1]]),
    cand('b', 'B', [[2, 1]]),
  ], CHAPTERS);
  assert.deepEqual(out.cols.map(c => c.id), ['a', 'b']);
});

test('buildPresenceMatrix: Spaltenzahl bei PRESENCE_MAX_COLS gekappt', () => {
  const many = Array.from({ length: PRESENCE_MAX_COLS + 5 }, (_, i) =>
    cand('c' + i, 'C' + i, [[1, i + 2]]));
  const out = buildPresenceMatrix(many, CHAPTERS);
  assert.equal(out.cols.length, PRESENCE_MAX_COLS);
  assert.equal(out.rows[0].cells.length, PRESENCE_MAX_COLS);
  // Gekappt wird am unteren Ende: die grössten Werte bleiben.
  assert.equal(out.cols[0].id, 'c' + (PRESENCE_MAX_COLS + 4));
});

test('bucketByRoot: aggregiert auf Wurzel-Kapitel, ignoriert Nullwerte + Unauflösbares', () => {
  const roots = { 10: { id: 1 }, 11: { id: 1 }, 20: { id: 2 } };
  const resolveRoot = (id) => roots[id] || null;
  const { byRootId, total } = bucketByRoot([
    { chapterId: 10, n: 2 },
    { chapterId: 11, n: 3 },   // Sub-Kapitel → selber Root
    { chapterId: 20, n: 4 },
    { chapterId: 99, n: 7 },   // unbekanntes Kapitel → fällt raus
    { chapterId: 10, n: 0 },   // Nullwert → ignoriert
  ], resolveRoot);

  assert.equal(byRootId.get(1), 5);
  assert.equal(byRootId.get(2), 4);
  assert.equal(total, 9, 'nur aufgelöste Treffer zählen');
});

test('bucketByRoot: Namens-Fallback greift, wenn keine chapter_id vorliegt', () => {
  const resolveRoot = (id, name) => (id == null && name === 'Kap A' ? { id: 1 } : null);
  const { byRootId, total } = bucketByRoot([{ chapterName: 'Kap A', n: 3 }], resolveRoot);
  assert.equal(byRootId.get(1), 3);
  assert.equal(total, 3);
});
