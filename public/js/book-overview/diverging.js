// Geteilte Mechanik der drei Kapitel-Balken-Tiles der Buch-Übersicht
// (Verteilung, Lektorat-Findings, Lektoratszeit). Alle drei zeigen dasselbe
// Layout: Track-Mitte = Median über alle Kapitel, Balken wachsen nach rechts
// (über Median) oder links (darunter), Länge = |deltaPct| relativ zum grössten
// Ausschlag. Nur die Kennzahl unterscheidet sich (Zeichen / Findings / Sekunden).
//
// Pure Funktionen (Alpine-/DOM-frei) → direkt unit-testbar, siehe
// tests/unit/book-overview-diverging.test.mjs.

// Halbe Track-Breite in Prozent. Cap bei 48 statt 50, damit der längste Balken
// nicht am Track-Rand klebt.
export const HALF_TRACK_PCT = 48;

// Median einer Zahlenreihe. `round` betrifft nur den geraden Fall (Mittel aus
// den beiden mittleren Werten) — Zähl-Kennzahlen wie Findings/Sekunden wollen
// eine ganze Zahl, Zeichen-Mengen dürfen die halbe behalten.
export function median(values, { round = false } = {}) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted[mid];
  const avg = (sorted[mid - 1] + sorted[mid]) / 2;
  return round ? Math.round(avg) : avg;
}

/**
 * Zeilen um ihren Median herum als Diverging-Bar anreichern.
 *
 * @param {Array<object>} items  Zeilen in der gewünschten Reihenfolge.
 * @param {object} opts
 * @param {(item) => number} opts.valueOf     Kennzahl der Zeile.
 * @param {number} [opts.minForMedian=0]      Mindestzahl Zeilen für einen
 *   aussagekräftigen Median. Darunter `showMedian=false` und Balkenlänge 0 —
 *   bei zwei Kapiteln ist „50 % über dem Median" kein Signal, sondern Rauschen.
 * @param {boolean} [opts.roundMedian=false]  Median ganzzahlig runden.
 * @param {boolean} [opts.extremesNeedTwo=false]  Extrem-Marker (isMax/isMin)
 *   erst ab zwei Zeilen setzen. Bei Tiles mit Wertungs-Semantik (Findings,
 *   Lektoratszeit) wäre „schlechtestes Kapitel" bei genau einem Kapitel absurd.
 * @returns {Array<object>} `items` + { median, showMedian, deltaPct,
 *   barWidthPct, barLeftPct, isAbove, isMax, isMin }.
 */
export function divergingRows(items, {
  valueOf,
  minForMedian = 0,
  roundMedian = false,
  extremesNeedTwo = false,
  half = HALF_TRACK_PCT,
} = {}) {
  const rows = items || [];
  if (rows.length === 0) return [];

  const values = rows.map(valueOf);
  const showMedian = rows.length >= minForMedian;
  const med = showMedian ? median(values, { round: roundMedian }) : 0;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const spread = max !== min;
  const extremesOk = !extremesNeedTwo || (rows.length >= 2 && spread);

  const deltas = values.map(v => (med > 0 ? Math.round(((v - med) / med) * 100) : 0));
  const maxAbsDelta = Math.max(1, ...deltas.map(Math.abs));

  return rows.map((item, i) => {
    const v = values[i];
    const deltaPct = deltas[i];
    const halfPct = showMedian ? (Math.abs(deltaPct) / maxAbsDelta) * half : 0;
    return {
      ...item,
      median: med,
      showMedian,
      deltaPct,
      barWidthPct: halfPct,
      barLeftPct: deltaPct >= 0 ? 50 : 50 - halfPct,
      isAbove: deltaPct > 0,
      isMax: extremesOk && max > 0 && v === max,
      isMin: extremesOk && spread && v === min,
    };
  });
}
