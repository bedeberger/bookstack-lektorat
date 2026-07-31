'use strict';
// Lexikalische Diversitätsmasse. Pure Mathematik über eine Token-Sequenz aus
// tokenize.js — keine DB, kein Netz, kein State (tests/unit/lexicon-measures.test.mjs).
//
// Warum nicht einfach TTR (Types/Tokens): TTR fällt mit der Textlänge monoton,
// weil jeder weitere Token die Chance auf einen neuen Type senkt. Ein 300-Seiten-
// Roman hat darum immer eine „schlechtere" TTR als ein Kapitel daraus — die Zahl
// misst dann Länge, nicht Wortschatz. Genau dieser Fehler steckt in der bisherigen
// `unique_words`-Kennzahl. Die Masse hier sind alle gegen diesen Effekt gebaut.

// MATTR-Standardfenster. 1000 Token ist die in der Korpuslinguistik übliche Wahl
// (Covington & McFall) — gross genug, um Satz-Rauschen zu glätten, klein genug,
// dass auch ein einzelnes Kapitel mehrere Fenster liefert.
const MATTR_WINDOW = 1000;

// MTLD-Schwelle nach McCarthy & Jarvis. Nicht justieren: der Wert ist empirisch
// kalibriert, und ein anderer macht die Zahl mit publizierten Werten unvergleichbar.
const MTLD_THRESHOLD = 0.72;

// Unter dieser Länge ist MTLD nicht aussagekräftig (der Rest-Faktor dominiert).
const MTLD_MIN_TOKENS = 100;

// Unter dieser Länge ist die Heaps-Regression Rauschen.
const HEAPS_MIN_TOKENS = 200;
const HEAPS_SAMPLE_POINTS = 24;

const { round } = require('./round');

// Hapax legomena (genau 1×) und dislegomena (genau 2×) aus einer Häufigkeits-
// tabelle. Die Hapax-Quote ist das robusteste Einzelsignal für „reicher
// Wortschatz", weil sie nicht von der Type-Zahl selbst abhängt.
function hapaxStats(freq) {
  let hapax = 0, dislegomena = 0, types = 0;
  for (const c of freq.values()) {
    types++;
    if (c === 1) hapax++;
    else if (c === 2) dislegomena++;
  }
  return {
    types,
    hapax,
    dislegomena,
    hapax_ratio: types > 0 ? round(hapax / types, 4) : null,
  };
}

// MATTR: Mittel der TTR über ein gleitendes Fenster (Schrittweite 1). Inkrementell
// gezählt — ein Token rein, ein Token raus, kein Neuaufbau pro Fenster, also O(N).
//
// Ist die Sequenz kürzer als das Fenster, liefert die Funktion die einfache TTR
// über den ganzen Text und meldet das über `window` (= Textlänge) zurück. Der Wert
// ist dann NICHT längenrobust — der Aufrufer muss das sichtbar machen, nicht
// verschweigen.
function mattr(tokens, windowSize = MATTR_WINDOW) {
  const n = tokens.length;
  if (n === 0) return { value: null, window: 0, windows: 0 };
  const w = Math.min(windowSize, n);
  const counts = new Map();
  let distinct = 0;
  for (let i = 0; i < w; i++) {
    const t = tokens[i];
    const c = counts.get(t) || 0;
    if (c === 0) distinct++;
    counts.set(t, c + 1);
  }
  let sum = distinct / w;
  let windows = 1;
  for (let i = w; i < n; i++) {
    const out = tokens[i - w];
    const co = counts.get(out);
    if (co === 1) { counts.delete(out); distinct--; }
    else counts.set(out, co - 1);
    const inn = tokens[i];
    const ci = counts.get(inn) || 0;
    if (ci === 0) distinct++;
    counts.set(inn, ci + 1);
    sum += distinct / w;
    windows++;
  }
  return { value: round(sum / windows, 4), window: w, windows };
}

// Ein MTLD-Durchlauf in einer Richtung: die Sequenz wird in Faktoren zerlegt, in
// denen die laufende TTR über die Schwelle bleibt. Der angebrochene Restfaktor
// wird anteilig gewichtet.
function _mtldRun(tokens, threshold) {
  let factors = 0;
  let types = new Set();
  let count = 0;
  let ttr = 1;
  for (const t of tokens) {
    count++;
    types.add(t);
    ttr = types.size / count;
    if (ttr <= threshold) {
      factors++;
      types = new Set();
      count = 0;
      ttr = 1;
    }
  }
  if (count > 0) {
    const denom = 1 - threshold;
    if (denom > 0) factors += (1 - ttr) / denom;
  }
  if (factors <= 0) return null;
  return tokens.length / factors;
}

// MTLD, bidirektional (Mittel aus Vorwärts- und Rückwärtslauf). Die Richtung
// beeinflusst die Faktor-Grenzen; der Mittelwert nimmt die Asymmetrie heraus.
function mtld(tokens, threshold = MTLD_THRESHOLD) {
  if (tokens.length < MTLD_MIN_TOKENS) return null;
  const fwd = _mtldRun(tokens, threshold);
  const bwd = _mtldRun([...tokens].reverse(), threshold);
  if (fwd == null || bwd == null) return null;
  return round((fwd + bwd) / 2, 2);
}

// Yule's K: 10^4 · (Σ i²·V_i − N) / N², mit V_i = Zahl der Types mit Häufigkeit i.
// Frequenzverteilungs-basiert und darum längenstabil. Niedriger = reicher
// (weniger Konzentration auf wenige Wörter) — die einzige Kennzahl hier, bei der
// klein besser ist.
function yuleK(freq, tokenCount) {
  const n = tokenCount;
  if (!n) return null;
  const vi = new Map();
  for (const c of freq.values()) vi.set(c, (vi.get(c) || 0) + 1);
  let sum = 0;
  for (const [i, v] of vi) sum += i * i * v;
  return round((10000 * (sum - n)) / (n * n), 2);
}

// Heaps' Law: V = K · N^β. β aus einer Kleinste-Quadrate-Regression von log V über
// log N an geometrisch verteilten Präfix-Punkten (dichter am Anfang, wo sich die
// Kurve stärker krümmt). β ~0.5 heisst „Wortschatz wächst noch kräftig", β gegen 0
// heisst „der Autor wiederholt ab hier nur noch bekannte Wörter".
function heaps(tokens, samplePoints = HEAPS_SAMPLE_POINTS) {
  const n = tokens.length;
  if (n < HEAPS_MIN_TOKENS) return { beta: null, k: null, points: 0 };
  const start = 50;
  const xs = [];
  const ys = [];
  const counts = new Map();
  let distinct = 0;
  // Geometrisch verteilte Messpunkte, aufsteigend — dadurch reicht ein Durchlauf.
  const marks = [];
  for (let p = 0; p < samplePoints; p++) {
    const frac = (p + 1) / samplePoints;
    const at = Math.round(start * Math.pow(n / start, frac));
    if (at > start && (marks.length === 0 || at > marks[marks.length - 1])) marks.push(Math.min(at, n));
  }
  let mi = 0;
  for (let i = 0; i < n; i++) {
    const t = tokens[i];
    const c = counts.get(t) || 0;
    if (c === 0) distinct++;
    counts.set(t, c + 1);
    while (mi < marks.length && i + 1 === marks[mi]) {
      xs.push(Math.log(i + 1));
      ys.push(Math.log(distinct));
      mi++;
    }
  }
  if (xs.length < 3) return { beta: null, k: null, points: xs.length };
  const m = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < m; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const denom = m * sxx - sx * sx;
  if (denom === 0) return { beta: null, k: null, points: m };
  const beta = (m * sxy - sx * sy) / denom;
  const intercept = (sy - beta * sx) / m;
  return { beta: round(beta, 4), k: round(Math.exp(intercept), 2), points: m };
}

// Lexikalische Dichte (Ure/Halliday): Inhaltswörter / Gesamttoken. `isContent` ist
// ein Prädikat, damit das Modul die Stoppwortliste nicht kennen muss (pure).
function lexicalDensity(tokens, isContent) {
  if (!tokens.length) return null;
  let content = 0;
  for (const t of tokens) if (isContent(t)) content++;
  return round(content / tokens.length, 4);
}

module.exports = {
  MATTR_WINDOW, MTLD_THRESHOLD, MTLD_MIN_TOKENS, HEAPS_MIN_TOKENS, HEAPS_SAMPLE_POINTS,
  hapaxStats, mattr, mtld, yuleK, heaps, lexicalDensity,
};
