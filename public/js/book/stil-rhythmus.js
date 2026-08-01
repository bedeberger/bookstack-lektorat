// Satzrhythmus-Band + Satzanfänge — zweiter Abschnitt der Stil-Karte.
// Liest dieselbe Quelle wie die Heatmap (page_stats via /history/style-stats),
// wertet aber die beiden SEQUENZ-Felder aus, die kein Aggregat ersetzen kann:
// `sentence_lens` (Satzlängen in Leserichtung) und `opener_counts` (erstes Wort
// je Satz + Nachbar-Wiederholungen).
//
// Warum das nicht in die Heatmap passt: dort steht pro Kapitel EIN Wert je
// Metrik. „Durchschnittliche Satzlänge 14" entsteht aber sowohl aus lauter
// 14ern als auch aus dem Wechsel 3/25/3/25 — der Unterschied ist der Rhythmus,
// und er ist aus dem Mittelwert nicht rekonstruierbar. Darum ein eigenes Band.
//
// Methoden werden in Alpine.data('stilCard') gespreadet; Root-Zugriffe via
// window.__app.

import { formatNumber } from '../utils.js';

// Spaltenzahl des gezeichneten Bands. Ein Kapitel hat schnell mehrere tausend
// Sätze; jenseits dieser Auflösung ist im Band nichts mehr unterscheidbar, und
// jeder zusätzliche Punkt kostet Polygon-Länge in jedem einzelnen Render.
const BAND_COLS = 120;
// Höhe des viewBox-Koordinatensystems. Die tatsächliche Pixelhöhe kommt aus dem
// CSS (`preserveAspectRatio="none"` streckt), hier zählt nur das Verhältnis.
const BAND_H = 32;
// Anzahl Satzanfänge in der Rangliste.
const OPENER_TOP = 15;
// Obergrenze der y-Achse: Perzentil über ALLE Satzlängen des Buchs. Nicht das
// Maximum — ein einzelner 90-Wort-Satz drückt sonst das ganze Buch flach an den
// Boden. Werte darüber werden gekappt (und sind als Vollausschlag lesbar).
const BAND_SCALE_PERCENTILE = 0.95;
// Untergrenze der Skala, damit ein Kapitel aus lauter Kurzsätzen nicht als
// Vollausschlag erscheint.
const BAND_SCALE_MIN = 10;

/** Perzentil einer UNSORTIERTEN Zahlenliste (kopiert + sortiert). */
function _percentileOf(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

/** Reduziert eine Satzlängen-Sequenz auf höchstens `cols` Mittelwerte.
 *  Bucket-Mittel, nicht Sampling: ein herausgegriffener Einzelwert würde je nach
 *  Kapitellänge zufällig mal einen Ausreisser, mal einen Kurzsatz treffen und das
 *  Band bei jedem Zuwachs neu würfeln. */
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

/** Polygon-Punkte für ein gefülltes Band über `values`, normalisiert auf `scaleMax`.
 *  Gefüllte Fläche statt Linie, weil das SVG mit `preserveAspectRatio="none"`
 *  gestreckt wird — eine Strichstärke würde dabei mitverzerrt, eine Fläche nicht. */
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

// Zwei Nachkommastellen reichen im 120×32-Koordinatensystem und halten den
// Polygon-String kurz.
function _r(n) {
  return Math.round(n * 100) / 100;
}

/** Kennzahlen einer Satzlängen-Sequenz.
 *
 *  `swing` ist die eigentliche Rhythmus-Zahl: der mittlere Sprung zwischen zwei
 *  BENACHBARTEN Sätzen, relativ zur mittleren Satzlänge. Die naheliegende
 *  Streuung (Standardabweichung) taugt dafür nicht — sie ist reihenfolgeblind
 *  und liefert für „100 kurze, dann 100 lange Sätze" denselben Wert wie für den
 *  ständigen Wechsel, obwohl sich das eine monoton liest und das andere nicht. */
export function computeSequenceStats(lens) {
  const n = lens.length;
  if (!n) return { count: 0, mean: null, p90: null, longest: null, swing: null };
  let sum = 0;
  for (const v of lens) sum += v;
  const mean = sum / n;
  let diffSum = 0;
  for (let i = 1; i < n; i++) diffSum += Math.abs(lens[i] - lens[i - 1]);
  const swing = (n > 1 && mean > 0) ? (diffSum / (n - 1)) / mean : null;
  return {
    count: n,
    mean: Math.round(mean * 10) / 10,
    p90: _percentileOf(lens, 0.9),
    longest: Math.max(...lens),
    swing: swing != null ? Math.round(swing * 100) / 100 : null,
  };
}

/** Baut die Kapitel-Zeilen des Rhythmus-Bands aus den Seiten-Rows.
 *  `pages` kommt bereits in Leserichtung (ORDER BY chapter_id, page_id in
 *  routes/history.js) — die Reihenfolge der Rows UND die Reihenfolge innerhalb
 *  von `sentence_lens` tragen zusammen die Sequenz.
 *
 *  Pure Funktion (kein `this`), damit sie ohne Alpine testbar ist. */
export function computeRhythmBands(pages, unassignedLabel = '—') {
  const groups = new Map();
  const all = [];
  for (const p of pages || []) {
    const lens = Array.isArray(p.sentence_lens) ? p.sentence_lens : null;
    const key = String(p.chapter_id ?? '__uncat__');
    if (!groups.has(key)) {
      groups.set(key, { key, name: p.chapter_name || unassignedLabel, lens: [], repeats: 0, openerTotal: 0 });
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
      // Wiederholungsquote über die Sätze, für die es überhaupt einen Vorgänger
      // gibt — bei einem einzigen Satz ist die Frage nicht gestellt.
      repeats: g.repeats,
      repeatRatio: g.openerTotal > 1 ? g.repeats / (g.openerTotal - 1) : null,
      points: bandPoints(downsampleLens(g.lens), scaleMax),
    });
  }
  return { rows, scaleMax, cols: BAND_COLS, height: BAND_H, viewBox: `0 0 ${BAND_COLS} ${BAND_H}` };
}

/** Buchweite Rangliste der Satzanfänge.
 *  Summiert die Pro-Seiten-Maps; `total` ist die Zahl aller gezählten Sätze,
 *  `repeats` die Zahl der Nachbarpaare mit gleichem Anfang. */
export function computeOpeners(pages, limit = OPENER_TOP) {
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
      // Balkenlänge relativ zum häufigsten Anfang, nicht zum Gesamtanteil —
      // sonst sind alle Balken kurz, weil kein einzelnes Wort viel Anteil hat.
      bar: count / maxCount,
    })),
    total,
    repeats,
    repeatRatio: total > 1 ? repeats / (total - 1) : null,
    distinct: counts.size,
  };
}

export const stilRhythmusMethods = {
  // Einziger Memo-Helper der Karte (siehe CLAUDE.md „Memo-Pattern"). Deps werden
  // flach per === verglichen.
  _memo(key, deps, compute) {
    const memos = (this._memos ||= {});
    const hit = memos[key];
    if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])) {
      return hit.value;
    }
    const value = compute();
    memos[key] = { deps: [...deps], value };
    return value;
  },

  stilRhythmData() {
    const pages = this.stilData?.pages || [];
    const label = window.__app.t('stil.unassigned');
    return this._memo('rhythm', [pages, label], () => computeRhythmBands(pages, label));
  },

  stilOpenerData() {
    const pages = this.stilData?.pages || [];
    return this._memo('openers', [pages], () => computeOpeners(pages));
  },

  // Das Band braucht die neuen Sequenz-Felder. Bis der Sync durch ist (oder bei
  // Büchern, deren Seiten noch auf einer älteren metrics_version stehen), gibt es
  // nichts zu zeichnen — dann zeigt die Karte den Sync-Hinweis statt eines
  // leeren Rahmens.
  stilHasRhythm() {
    return this.stilRhythmData().rows.length > 0;
  },

  stilNum(value, decimals = 1) {
    if (value == null) return '–';
    return formatNumber(value, Alpine.store('shell').uiLocale, decimals);
  },

  stilPercent(ratio, decimals = 1) {
    if (ratio == null) return '–';
    return formatNumber(ratio * 100, Alpine.store('shell').uiLocale, decimals) + ' %';
  },

  // Einordnung des Wechsel-Werts in drei Stufen. Die Schwellen sind Erfahrungs-
  // werte aus deutscher Erzählprosa: unter 0,45 liest sich ein Abschnitt
  // gleichförmig, über 0,85 sprunghaft. Reine Anzeige-Hilfe — es gibt kein
  // „richtig", ein Sachtext DARF monoton sein.
  stilSwingKind(swing) {
    if (swing == null) return 'neutral';
    if (swing < 0.45) return 'low';
    if (swing > 0.85) return 'high';
    return 'mid';
  },

  stilSwingLabel(swing) {
    const kind = this.stilSwingKind(swing);
    if (kind === 'neutral') return '';
    return window.__app.t('stil.rhythm.swing.' + kind);
  },
};
