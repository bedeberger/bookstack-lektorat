// Tests fuer das geteilte Streak-Raster (public/js/streak-grid.js).
// Es traegt zwei Heatmaps mit verschiedenen Tageswerten (Zeichen in der
// Buch-Uebersicht, Schreibsekunden in „Meine Statistik") — die Regeln, die
// hier gelten, gelten damit fuer beide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStreakGrid, STREAK_WEEKS } from '../../public/js/streak-grid.js';
import { localIsoDaysAgo } from '../../public/js/utils.js';

// Fester Bezugstag: ein Mittwoch, damit die Wochentags-Ausrichtung pruefbar ist.
const TODAY = new Date(2026, 4, 20, 12, 0, 0); // 2026-05-20 ist ein Mittwoch
const iso = (n) => localIsoDaysAgo(n, TODAY);

function grid(valuesByIso, opts = {}) {
  return buildStreakGrid({
    valueForIso: (i) => (i in valuesByIso ? valuesByIso[i] : null),
    todayLocal: TODAY,
    ...opts,
  });
}

test('Raster: 52 Spalten × 7 Zeilen, heute in der letzten Spalte', () => {
  const out = grid({});
  assert.equal(out.weeksCount, STREAK_WEEKS);
  assert.equal(out.weeks.length, STREAK_WEEKS);
  assert.ok(out.weeks.every(w => w.length === 7));
  // Mittwoch → Zeile 2 (Mo=0). Letzte Spalte, Zeile 2 ist heute.
  assert.equal(out.weeks[STREAK_WEEKS - 1][2].iso, iso(0));
});

test('Zellen hinter heute sind future und nie eingefaerbt', () => {
  const out = grid({ [iso(0)]: 5000 });
  const lastWeek = out.weeks[STREAK_WEEKS - 1];
  // Do/Fr/Sa/So dieser Woche liegen hinter dem Mittwoch.
  for (const row of [3, 4, 5, 6]) {
    assert.equal(lastWeek[row].future, true, `Zeile ${row} muesste future sein`);
    assert.equal(lastWeek[row].level, 0);
    assert.equal(lastWeek[row].iso, null);
  }
  assert.equal(lastWeek[2].future, false);
});

test('null (keine Datenlage) und 0 (nichts geschrieben) bleiben unterscheidbar', () => {
  const out = grid({ [iso(1)]: 0 });
  const cellOf = (n) => out.weeks.flat().find(c => c.iso === iso(n));
  assert.equal(cellOf(1).value, 0, 'gemessener Nulltag');
  assert.equal(cellOf(2).value, null, 'keine Datenlage');
  assert.equal(cellOf(1).level, 0);
  assert.equal(cellOf(2).level, 0);
});

test('Serie: aufeinanderfolgende aktive Tage, heute offen bricht nicht', () => {
  // Gestern/vorgestern/vorvorgestern geschrieben, heute noch nichts.
  const out = grid({ [iso(1)]: 100, [iso(2)]: 100, [iso(3)]: 100 });
  assert.equal(out.currentStreak, 3);
  assert.equal(out.longestStreak, 3);
  assert.equal(out.totalActiveDays, 3);
});

test('Serie: Luecke vor heute bricht die laufende Serie', () => {
  const out = grid({ [iso(0)]: 100, [iso(2)]: 100, [iso(3)]: 100 });
  assert.equal(out.currentStreak, 1, 'nur heute');
  assert.equal(out.longestStreak, 2);
  assert.equal(out.totalActiveDays, 3);
});

test('Serie: gestern leer bricht, auch wenn heute geschrieben wurde', () => {
  const out = grid({ [iso(0)]: 100, [iso(1)]: 0, [iso(2)]: 100 });
  assert.equal(out.currentStreak, 1);
});

test('Einfaerbung: Quartile ueber die positiven Tageswerte', () => {
  // Acht aufsteigende Tageswerte → alle vier Stufen kommen vor, und die
  // Zuordnung ist monoton (mehr geschrieben heisst nie eine hellere Zelle).
  const vals = {};
  for (let i = 1; i <= 8; i++) vals[iso(i)] = i;
  const out = grid(vals);
  const lvl = (n) => out.weeks.flat().find(c => c.iso === iso(n)).level;
  const levels = [1, 2, 3, 4, 5, 6, 7, 8].map(lvl); // iso(n) traegt den Wert n
  assert.deepEqual(levels, [1, 1, 1, 2, 2, 3, 3, 4]);
  assert.deepEqual([...levels].sort((a, b) => a - b), levels, 'monoton');
});

test('Negative Tageswerte gelten nicht als aktiv', () => {
  const out = grid({ [iso(0)]: -500, [iso(1)]: 200 });
  // Heute negativ → „noch offen", die Serie zaehlt ab gestern weiter.
  assert.equal(out.currentStreak, 1);
  assert.equal(out.weeks.flat().find(c => c.iso === iso(0)).level, 0);
});

test('decorate ergaenzt Zellfelder und sieht die future-Zellen', () => {
  const out = grid({ [iso(0)]: 300 }, {
    decorate: (cell) => cell.future ? { tip: null } : { tip: `${cell.iso}:${cell.value}` },
  });
  const today = out.weeks[STREAK_WEEKS - 1][2];
  assert.equal(today.tip, `${iso(0)}:300`);
  assert.equal(out.weeks[STREAK_WEEKS - 1][6].tip, null);
});

test('valueForIso wird pro Kalendertag genau einmal gefragt', () => {
  // Raster und Serien-Zaehlung lesen dieselbe Reihe — die Regel darf nicht
  // zweimal ausgewertet werden (das war die Doppelung, die hier verschwand).
  const seen = new Map();
  buildStreakGrid({
    valueForIso: (i) => { seen.set(i, (seen.get(i) || 0) + 1); return 0; },
    todayLocal: TODAY,
  });
  assert.ok([...seen.values()].every(n => n === 1), 'kein Tag doppelt abgefragt');
  assert.equal(seen.size, (STREAK_WEEKS - 1) * 7 + 2 + 1, 'genau die Tage bis heute');
});
