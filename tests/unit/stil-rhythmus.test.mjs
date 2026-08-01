// Satzrhythmus-Band: die reinen Compute-Funktionen aus public/js/book/stil-rhythmus.js.
// Getestet wird, was ein Aggregat NICHT leisten kann — dass die Reihenfolge in
// den Wert eingeht — plus die Aggregation der Satzanfänge über Seiten hinweg.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSequenceStats,
  computeRhythmBands,
  computeOpeners,
} from '../../public/js/book/stil-rhythmus.js';

test('computeSequenceStats: leere Sequenz liefert null statt 0', () => {
  const s = computeSequenceStats([]);
  assert.equal(s.count, 0);
  assert.equal(s.mean, null);
  assert.equal(s.swing, null);
  assert.equal(s.longest, null);
});

test('computeSequenceStats: Mittelwert, P90 und längster Satz', () => {
  const s = computeSequenceStats([10, 10, 10, 10, 10, 10, 10, 10, 10, 40]);
  assert.equal(s.count, 10);
  assert.equal(s.mean, 13);
  assert.equal(s.p90, 10);
  assert.equal(s.longest, 40);
});

test('computeSequenceStats: swing ist reihenfolgeabhängig — genau der Punkt des Bands', () => {
  // Gleiche Multimenge, gleiche Streuung, gleicher Mittelwert.
  const monoton   = [5, 5, 5, 5, 25, 25, 25, 25];
  const wechselnd = [5, 25, 5, 25, 5, 25, 5, 25];

  const a = computeSequenceStats(monoton);
  const b = computeSequenceStats(wechselnd);

  assert.equal(a.mean, b.mean, 'Mittelwert unterscheidet die beiden nicht');
  assert.ok(b.swing > a.swing, 'der wechselnde Verlauf muss den höheren Swing haben');
  // 7 Nachbarpaare, davon 1× Sprung 20 → 20/7 / 15
  assert.equal(a.swing, Math.round(((20 / 7) / 15) * 100) / 100);
  // 7 Nachbarpaare à 20 → 20 / 15
  assert.equal(b.swing, Math.round((20 / 15) * 100) / 100);
});

test('computeSequenceStats: konstante Sequenz hat swing 0', () => {
  assert.equal(computeSequenceStats([12, 12, 12, 12]).swing, 0);
});

test('computeRhythmBands: gruppiert nach Kapitel und verkettet die Seiten in Reihenfolge', () => {
  const pages = [
    { chapter_id: 1, chapter_name: 'Eins', sentence_lens: [5, 6], opener_counts: { counts: { er: 2 }, repeats: 1 } },
    { chapter_id: 1, chapter_name: 'Eins', sentence_lens: [7],    opener_counts: { counts: { dann: 1 }, repeats: 0 } },
    { chapter_id: 2, chapter_name: 'Zwei', sentence_lens: [20],   opener_counts: { counts: { sie: 1 }, repeats: 0 } },
  ];
  const { rows } = computeRhythmBands(pages);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Eins');
  assert.equal(rows[0].count, 3, 'beide Seiten des Kapitels zählen in eine Sequenz');
  assert.equal(rows[0].repeats, 1);
  // 3 Satzanfänge im Kapitel → 2 Nachbarpaare möglich, davon 1 wiederholt.
  assert.equal(rows[0].repeatRatio, 1 / 2);
  assert.equal(rows[1].count, 1);
});

test('computeRhythmBands: Seiten ohne Sequenz-Feld kippen die Gruppe nicht', () => {
  const pages = [
    { chapter_id: 1, chapter_name: 'Eins', sentence_lens: null, opener_counts: null },
    { chapter_id: 1, chapter_name: 'Eins', sentence_lens: [4, 4], opener_counts: { counts: { und: 2 }, repeats: 1 } },
  ];
  const { rows } = computeRhythmBands(pages);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
});

test('computeRhythmBands: Kapitel ganz ohne Sätze erscheint nicht als leere Zeile', () => {
  const pages = [{ chapter_id: 9, chapter_name: 'Leer', sentence_lens: [], opener_counts: null }];
  assert.equal(computeRhythmBands(pages).rows.length, 0);
});

test('computeRhythmBands: Skala folgt dem 95. Perzentil, ein Ausreisser drückt das Band nicht flach', () => {
  const lens = Array(99).fill(12);
  lens.push(400);
  const { scaleMax } = computeRhythmBands([{ chapter_id: 1, sentence_lens: lens }]);
  assert.equal(scaleMax, 12, 'der einzelne 400-Wort-Satz darf die Skala nicht bestimmen');
});

test('computeRhythmBands: Skala hat eine Untergrenze', () => {
  const { scaleMax } = computeRhythmBands([{ chapter_id: 1, sentence_lens: [2, 3, 2] }]);
  assert.equal(scaleMax, 10);
});

test('computeRhythmBands: Band wird auf feste Spaltenzahl reduziert', () => {
  const lens = Array.from({ length: 5000 }, (_, i) => (i % 7) + 3);
  const { rows, cols } = computeRhythmBands([{ chapter_id: 1, sentence_lens: lens }]);
  // Punkte = cols Werte + zwei Basispunkte links/rechts.
  const pts = rows[0].points.split(' ');
  assert.equal(pts.length, cols + 2);
  assert.equal(pts[0], '0,32');
  assert.equal(pts[pts.length - 1], `${cols},32`);
  assert.equal(rows[0].count, 5000, 'die Kennzahlen rechnen weiter über alle Sätze');
});

test('computeRhythmBands: Band bleibt im viewBox — hohe Werte werden gekappt', () => {
  const { rows, height } = computeRhythmBands([{ chapter_id: 1, sentence_lens: [1, 200, 1] }]);
  for (const pt of rows[0].points.split(' ')) {
    const y = Number(pt.split(',')[1]);
    assert.ok(y >= 0 && y <= height, `y ausserhalb des viewBox: ${y}`);
  }
});

test('computeOpeners: summiert über Seiten, sortiert nach Häufigkeit', () => {
  const pages = [
    { opener_counts: { counts: { er: 5, sie: 2 }, repeats: 3 } },
    { opener_counts: { counts: { er: 3, dann: 4 }, repeats: 1 } },
  ];
  const o = computeOpeners(pages);
  assert.equal(o.total, 14);
  assert.equal(o.repeats, 4);
  assert.equal(o.distinct, 3);
  assert.deepEqual(o.top.map(t => t.word), ['er', 'dann', 'sie']);
  assert.equal(o.top[0].count, 8);
  assert.equal(o.top[0].bar, 1, 'häufigster Anfang füllt den Balken');
  assert.equal(o.top[0].share, 8 / 14);
});

test('computeOpeners: gleiche Häufigkeit wird alphabetisch stabilisiert', () => {
  const o = computeOpeners([{ opener_counts: { counts: { zeta: 2, alpha: 2 }, repeats: 0 } }]);
  assert.deepEqual(o.top.map(t => t.word), ['alpha', 'zeta']);
});

test('computeOpeners: ohne Daten kein Nullwert-Theater', () => {
  const o = computeOpeners([{ opener_counts: null }, {}]);
  assert.equal(o.total, 0);
  assert.equal(o.repeatRatio, null);
  assert.deepEqual(o.top, []);
});

test('computeOpeners: Rangliste ist gedeckelt', () => {
  const counts = {};
  for (let i = 0; i < 50; i++) counts['w' + i] = 50 - i;
  const o = computeOpeners([{ opener_counts: { counts, repeats: 0 } }]);
  assert.equal(o.top.length, 15);
  assert.equal(o.distinct, 50, 'der Deckel gilt für die Anzeige, nicht für die Zählung');
});
