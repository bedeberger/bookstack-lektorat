'use strict';
// Satzrhythmus-Band + Satzanfaenge: die reinen Sequenz-Funktionen der Stil-Karte.
// Bewusst ohne DB- und ohne HTTP-Bezug — die Zeilen liefert
// [db/style-stats.js](../db/style-stats.js), zusammengesetzt werden sie in
// [lib/stil-heatmap.js](./stil-heatmap.js) (Gegenstueck: lib/fehler-heatmap.js).
//
// Ausgewertet werden die beiden SEQUENZ-Felder aus `page_stats`, die kein
// Aggregat ersetzen kann: `sentence_lens` (Satzlaengen in Leserichtung) und
// `opener_counts` (erstes Wort je Satz + Nachbar-Wiederholungen).
//
// Warum das nicht in die Heatmap passt: dort steht pro Kapitel EIN Wert je
// Metrik. „Durchschnittliche Satzlaenge 14" entsteht aber sowohl aus lauter
// 14ern als auch aus dem Wechsel 3/25/3/25 — der Unterschied ist der Rhythmus,
// und er ist aus dem Mittelwert nicht rekonstruierbar. Darum ein eigenes Band.
//
// Gerechnet wird serverseitig, weil `sentence_lens` pro Seite bis zu 2000 Zahlen
// traegt: bei einem Buch mit tausenden Seiten ist die Sequenz um Groessenordnungen
// groesser als das Band, das daraus wird. Der Client bekommt nur noch die
// Polygon-Punkte.

// Spaltenzahl des gezeichneten Bands. Ein Kapitel hat schnell mehrere tausend
// Saetze; jenseits dieser Aufloesung ist im Band nichts mehr unterscheidbar, und
// jeder zusaetzliche Punkt kostet Polygon-Laenge in jedem einzelnen Render.
const BAND_COLS = 120;
// Hoehe des viewBox-Koordinatensystems. Die tatsaechliche Pixelhoehe kommt aus dem
// CSS (`preserveAspectRatio="none"` streckt), hier zaehlt nur das Verhaeltnis.
const BAND_H = 32;
// Anzahl Satzanfaenge in der Rangliste.
const OPENER_TOP = 15;
// Obergrenze der y-Achse: Perzentil ueber ALLE Satzlaengen des Buchs. Nicht das
// Maximum — ein einzelner 90-Wort-Satz drueckt sonst das ganze Buch flach an den
// Boden. Werte darueber werden gekappt (und sind als Vollausschlag lesbar).
const BAND_SCALE_PERCENTILE = 0.95;
// Untergrenze der Skala, damit ein Kapitel aus lauter Kurzsaetzen nicht als
// Vollausschlag erscheint.
const BAND_SCALE_MIN = 10;

/** Perzentil einer UNSORTIERTEN Zahlenliste (kopiert + sortiert). */
function _percentileOf(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

/** Reduziert eine Satzlaengen-Sequenz auf hoechstens `cols` Mittelwerte.
 *  Bucket-Mittel, nicht Sampling: ein herausgegriffener Einzelwert wuerde je nach
 *  Kapitellaenge zufaellig mal einen Ausreisser, mal einen Kurzsatz treffen und das
 *  Band bei jedem Zuwachs neu wuerfeln. */
function downsampleLens(lens, cols = BAND_COLS) {
  if (!lens.length) return [];
  if (lens.length <= cols) return lens.slice();
  const out = new Array(cols);
  for (let i = 0; i < cols; i++) {
    const from = Math.floor((i * lens.length) / cols);
    const to = Math.max(from + 1, Math.floor(((i + 1) * lens.length) / cols));
    let sum = 0;
    for (let j = from; j < to; j++) sum += lens[j];
    out[i] = sum / (to - from);
  }
  return out;
}

// Zwei Nachkommastellen reichen im 120x32-Koordinatensystem und halten den
// Polygon-String kurz.
function _r(n) {
  return Math.round(n * 100) / 100;
}

/** Polygon-Punkte fuer ein gefuelltes Band ueber `values`, normalisiert auf `scaleMax`.
 *  Gefuellte Flaeche statt Linie, weil das SVG mit `preserveAspectRatio="none"`
 *  gestreckt wird — eine Strichstaerke wuerde dabei mitverzerrt, eine Flaeche nicht. */
function bandPoints(values, scaleMax, cols = BAND_COLS, height = BAND_H) {
  if (!values.length || !scaleMax) return '';
  const n = values.length;
  const xAt = (i) => (n === 1 ? cols : (i / (n - 1)) * cols);
  const yAt = (v) => height - Math.min(1, Math.max(0, v / scaleMax)) * height;
  const pts = [`0,${height}`];
  for (let i = 0; i < n; i++) pts.push(`${_r(xAt(i))},${_r(yAt(values[i]))}`);
  pts.push(`${cols},${height}`);
  return pts.join(' ');
}

/** Kennzahlen einer Satzlaengen-Sequenz.
 *
 *  `swing` ist die eigentliche Rhythmus-Zahl: der mittlere Sprung zwischen zwei
 *  BENACHBARTEN Saetzen, relativ zur mittleren Satzlaenge. Die naheliegende
 *  Streuung (Standardabweichung) taugt dafuer nicht — sie ist reihenfolgeblind
 *  und liefert fuer „100 kurze, dann 100 lange Saetze" denselben Wert wie fuer den
 *  staendigen Wechsel, obwohl sich das eine monoton liest und das andere nicht. */
function computeSequenceStats(lens) {
  const n = lens.length;
  if (!n) return { count: 0, mean: null, p90: null, longest: null, swing: null };
  let sum = 0;
  for (const v of lens) sum += v;
  const mean = sum / n;
  let diffSum = 0;
  for (let i = 1; i < n; i++) diffSum += Math.abs(lens[i] - lens[i - 1]);
  const swing = (n > 1 && mean > 0) ? (diffSum / (n - 1)) / mean : null;
  let longest = lens[0];
  for (const v of lens) if (v > longest) longest = v;
  return {
    count: n,
    mean: Math.round(mean * 10) / 10,
    p90: _percentileOf(lens, 0.9),
    longest,
    swing: swing != null ? Math.round(swing * 100) / 100 : null,
  };
}

/** Baut die Kapitel-Zeilen des Rhythmus-Bands aus den Seiten-Rows.
 *  `pages` kommt bereits in Leserichtung (ORDER BY chapter_id, page_id in
 *  db/style-stats.js) — die Reihenfolge der Rows UND die Reihenfolge innerhalb
 *  von `sentence_lens` tragen zusammen die Sequenz.
 *
 *  `name` bleibt `null`, wenn die Seite keinem Kapitel zugeordnet ist: das Label
 *  dafuer ist UI-Text und gehoert in die Locale-Datei, nicht in die Antwort. */
function computeRhythmBands(pages) {
  const groups = new Map();
  const all = [];
  for (const p of pages || []) {
    const lens = Array.isArray(p.sentence_lens) ? p.sentence_lens : null;
    const key = String(p.chapter_id ?? '__uncat__');
    if (!groups.has(key)) {
      groups.set(key, { key, name: p.chapter_name || null, lens: [], repeats: 0, openerTotal: 0 });
    }
    const g = groups.get(key);
    if (lens) {
      for (const v of lens) { g.lens.push(v); all.push(v); }
    }
    const oc = p.opener_counts;
    if (oc && typeof oc === 'object') {
      g.repeats += Number(oc.repeats) || 0;
      for (const c of Object.values(oc.counts || {})) g.openerTotal += Number(c) || 0;
    }
  }

  const scaleMax = Math.max(BAND_SCALE_MIN, _percentileOf(all, BAND_SCALE_PERCENTILE) || 0);
  const rows = [];
  for (const g of groups.values()) {
    if (!g.lens.length) continue;
    const stats = computeSequenceStats(g.lens);
    rows.push({
      key: g.key,
      name: g.name,
      ...stats,
      // Wiederholungsquote ueber die Saetze, fuer die es ueberhaupt einen Vorgaenger
      // gibt — bei einem einzigen Satz ist die Frage nicht gestellt.
      repeats: g.repeats,
      repeatRatio: g.openerTotal > 1 ? g.repeats / (g.openerTotal - 1) : null,
      points: bandPoints(downsampleLens(g.lens), scaleMax),
    });
  }
  return { rows, scaleMax, cols: BAND_COLS, height: BAND_H, viewBox: `0 0 ${BAND_COLS} ${BAND_H}` };
}

/** Buchweite Rangliste der Satzanfaenge.
 *  Summiert die Pro-Seiten-Maps; `total` ist die Zahl aller gezaehlten Saetze,
 *  `repeats` die Zahl der Nachbarpaare mit gleichem Anfang. */
function computeOpeners(pages, limit = OPENER_TOP) {
  const counts = new Map();
  let total = 0;
  let repeats = 0;
  for (const p of pages || []) {
    const oc = p.opener_counts;
    if (!oc || typeof oc !== 'object') continue;
    repeats += Number(oc.repeats) || 0;
    for (const [word, c] of Object.entries(oc.counts || {})) {
      const n = Number(c) || 0;
      if (!n) continue;
      counts.set(word, (counts.get(word) || 0) + n);
      total += n;
    }
  }
  if (!total) return { top: [], total: 0, repeats: 0, repeatRatio: null, distinct: 0 };
  const sorted = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  const maxCount = sorted[0][1];
  return {
    top: sorted.slice(0, limit).map(([word, count]) => ({
      word,
      count,
      share: count / total,
      // Balkenlaenge relativ zum haeufigsten Anfang, nicht zum Gesamtanteil —
      // sonst sind alle Balken kurz, weil kein einzelnes Wort viel Anteil hat.
      bar: count / maxCount,
    })),
    total,
    repeats,
    repeatRatio: total > 1 ? repeats / (total - 1) : null,
    distinct: counts.size,
  };
}

module.exports = {
  computeSequenceStats,
  computeRhythmBands,
  computeOpeners,
  downsampleLens,
  bandPoints,
  BAND_COLS,
  BAND_H,
  OPENER_TOP,
};
