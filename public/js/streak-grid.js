// Geteilte Mechanik der GitHub-Stil-Streak-Heatmap (52 Wochen × 7 Tage).
// Konsumenten:
//   - Buch-Uebersicht: geschriebene Zeichen pro Tag (book-overview/stats.js)
//   - „Meine Statistik": Schreibsekunden pro Tag (cards/my-stats-compute.js)
//
// Beide zeigten dasselbe Raster mit derselben Wochentags-Ausrichtung, demselben
// Quartil-Bucketing und derselben Serien-Zaehlung — sie unterschieden sich
// einzig im Wert pro Tag. Genau der ist hier ein Callback; alles andere lebt
// nur noch hier.
//
// Pure Funktion (Alpine-/DOM-frei) → direkt unit-testbar, siehe
// tests/unit/streak-grid.test.mjs.
import { localIsoDate, localIsoDaysAgo } from './utils.js';
import { quartileLevelFor } from './book/ymheatmap.js';

export const STREAK_WEEKS = 52;

/**
 * Streak-Raster + Serien-Kennzahlen aus einer Tageswert-Funktion bauen.
 *
 * Das Raster laeuft auf HEUTE zu: die rechte Spalte ist die laufende Woche,
 * Zeile 0 ist Montag. Zellen hinter heute sind `future` (leer gerendert, nie
 * eingefaerbt), Zellen ohne Datenlage bekommen `value: null` — das ist bewusst
 * von `0` unterschieden, denn „nichts geschrieben" und „nichts gemessen"
 * duerfen nicht gleich aussehen.
 *
 * Einfaerbung: Quartile ueber die POSITIVEN Tageswerte (geteilte Mechanik mit
 * der Jahr×Monat-Heatmap, siehe book/ymheatmap.js#quartileLevelFor).
 *
 * Serie: aufeinanderfolgende Tage mit Wert > 0. Ein heute noch leerer Tag
 * bricht die laufende Serie NICHT — der Tag ist noch nicht vorbei.
 *
 * @param {object} opts
 * @param {(iso: string) => number|null} opts.valueForIso  Tageswert.
 * @param {Date}   [opts.todayLocal]   Referenz-„heute" (Tests).
 * @param {number} [opts.weeks]        Spaltenzahl.
 * @param {(cell) => object} [opts.decorate]  Zusatzfelder pro Zelle
 *   (Tooltip, fachliche Aliase). Bekommt die Basiszelle inkl. `future`.
 * @returns {{weeks: Array, weeksCount: number, currentStreak: number,
 *            longestStreak: number, totalActiveDays: number}}
 */
export function buildStreakGrid({
  valueForIso,
  todayLocal = new Date(),
  weeks = STREAK_WEEKS,
  decorate = null,
} = {}) {
  // Mittag → DST-Drift-sicher beim ±n Tagen.
  const today = new Date(todayLocal);
  today.setHours(12, 0, 0, 0);
  const dowMon = (today.getDay() + 6) % 7; // Mo=0 ... So=6
  const startOffset = (weeks - 1) * 7 + dowMon;
  const isoToday = localIsoDate(today);

  // Tageswerte EINMAL ziehen — Raster und Serien-Zaehlung lesen dieselbe Reihe
  // statt jede fuer sich zu rechnen (das war die dritte Kopie der Regel).
  const series = []; // chronologisch, aeltester zuerst
  const valueByIso = new Map();
  for (let off = startOffset; off >= 0; off--) {
    const iso = localIsoDaysAgo(off, today);
    const value = valueForIso(iso);
    valueByIso.set(iso, value);
    series.push({ iso, value });
  }

  const active = (v) => v != null && v > 0;
  const levelFor = quartileLevelFor(series.filter(x => active(x.value)).map(x => x.value));

  const makeCell = (base) => (decorate ? { ...base, ...decorate(base) } : base);

  const grid = [];
  for (let w = 0; w < weeks; w++) grid.push([null, null, null, null, null, null, null]);
  for (let i = 0; i < weeks * 7; i++) {
    const col = Math.floor(i / 7);
    const row = i % 7;
    const offsetDays = ((weeks - 1) - col) * 7 + (dowMon - row);
    if (offsetDays < 0) {
      grid[col][row] = makeCell({ iso: null, value: null, level: 0, future: true });
      continue;
    }
    const iso = localIsoDaysAgo(offsetDays, today);
    const value = valueByIso.has(iso) ? valueByIso.get(iso) : null;
    grid[col][row] = makeCell({ iso, value, level: levelFor(value), future: false });
  }

  let longest = 0, run = 0;
  for (const x of series) {
    if (active(x.value)) { run++; if (run > longest) longest = run; }
    else run = 0;
  }

  let current = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    const x = series[i];
    // Heute noch offen (kein Wert / 0) bricht die Serie nicht.
    if (i === series.length - 1 && x.iso === isoToday && !active(x.value)) continue;
    if (active(x.value)) current++;
    else break;
  }

  return {
    weeks: grid,
    weeksCount: weeks,
    currentStreak: current,
    longestStreak: longest,
    totalActiveDays: series.filter(x => active(x.value)).length,
  };
}
