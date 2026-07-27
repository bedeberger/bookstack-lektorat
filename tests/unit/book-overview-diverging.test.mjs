// Tests für den geteilten Diverging-Bar-Kern der Kapitel-Tiles
// (Verteilung / Lektorat-Findings / Lektoratszeit). Vorher lag Median +
// Balken-Geometrie dreimal parallel in kapitel.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { divergingRows, median, HALF_TRACK_PCT } from '../../public/js/book-overview/diverging.js';

const valueOf = r => r.v;
const rows = (...vals) => vals.map((v, i) => ({ id: i + 1, v }));

test('median: ungerade Länge → mittlerer Wert', () => {
  assert.equal(median([5, 1, 3]), 3);
});

test('median: gerade Länge → Mittel, optional gerundet', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([1, 2, 3, 4], { round: true }), 3, 'Math.round(2.5) = 3');
});

test('median: leere Reihe → 0', () => {
  assert.equal(median([]), 0);
});

test('divergingRows: leere Eingabe → leeres Array', () => {
  assert.deepEqual(divergingRows([], { valueOf }), []);
});

test('divergingRows: deltaPct gegen Median, Balken um die Track-Mitte', () => {
  const out = divergingRows(rows(50, 100, 200), { valueOf });
  assert.equal(out[1].median, 100);
  assert.deepEqual(out.map(r => r.deltaPct), [-50, 0, 100]);

  // Grösster Ausschlag (100 %) bekommt die volle halbe Trackbreite.
  assert.equal(out[2].barWidthPct, HALF_TRACK_PCT);
  assert.equal(out[2].barLeftPct, 50, 'über Median → wächst nach rechts');

  // Halber Ausschlag → halbe Länge, links der Mitte angesetzt.
  assert.equal(out[0].barWidthPct, HALF_TRACK_PCT / 2);
  assert.equal(out[0].barLeftPct, 50 - HALF_TRACK_PCT / 2);

  assert.deepEqual(out.map(r => r.isAbove), [false, false, true]);
});

test('divergingRows: Extrem-Marker auf höchstem/niedrigstem Wert', () => {
  const out = divergingRows(rows(50, 100, 200), { valueOf });
  assert.deepEqual(out.map(r => r.isMax), [false, false, true]);
  assert.deepEqual(out.map(r => r.isMin), [true, false, false]);
});

test('divergingRows: alle Werte gleich → kein Min-Marker, keine Balken', () => {
  const out = divergingRows(rows(7, 7, 7), { valueOf });
  assert.deepEqual(out.map(r => r.isMin), [false, false, false]);
  assert.deepEqual(out.map(r => r.isMax), [true, true, true]);
  assert.deepEqual(out.map(r => r.barWidthPct), [0, 0, 0]);
});

test('divergingRows: extremesNeedTwo unterdrückt Marker bei einer einzigen Zeile', () => {
  const solo = rows(42);
  assert.equal(divergingRows(solo, { valueOf })[0].isMax, true, 'Default: Marker gesetzt');
  assert.equal(
    divergingRows(solo, { valueOf, extremesNeedTwo: true })[0].isMax,
    false,
    '„schlechtestes Kapitel" bei genau einem Kapitel ist sinnlos',
  );
});

test('divergingRows: minForMedian unterdrückt Median + Balken unter der Schwelle', () => {
  const out = divergingRows(rows(10, 90), { valueOf, minForMedian: 3 });
  assert.equal(out[0].showMedian, false);
  assert.equal(out[0].median, 0);
  assert.deepEqual(out.map(r => r.deltaPct), [0, 0]);
  assert.deepEqual(out.map(r => r.barWidthPct), [0, 0]);
});

test('divergingRows: ab der Schwelle wieder aktiv, roundMedian greift', () => {
  const out = divergingRows(rows(10, 20, 30, 50), { valueOf, minForMedian: 3, roundMedian: true });
  assert.equal(out[0].showMedian, true);
  assert.equal(out[0].median, 25, '(20+30)/2');
});

test('divergingRows: Median 0 → keine Division durch null', () => {
  const out = divergingRows(rows(0, 0), { valueOf });
  assert.deepEqual(out.map(r => r.deltaPct), [0, 0]);
  assert.ok(out.every(r => Number.isFinite(r.barWidthPct)));
});

test('divergingRows: Ursprungsfelder bleiben erhalten', () => {
  const out = divergingRows([{ id: 9, name: 'Kap', v: 5, extra: 'x' }], { valueOf });
  assert.equal(out[0].name, 'Kap');
  assert.equal(out[0].extra, 'x');
  assert.equal(out[0].id, 9);
});
