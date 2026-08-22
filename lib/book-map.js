'use strict';
// Buchlandkarte: die Punktwolke des Embedding-Index als Geometrie lesen, statt
// sie nur abzufragen. Reiner Ableitungs-Schritt über `semantic_chunks` — kein
// Embedding-Call, kein KI-Call, keine DB-/Netz-Abhängigkeit (→ unit-testbar,
// tests/unit/book-map.test.mjs).
//
// Alle bisherigen Konsumenten des Index stellen dieselbe Frage: „gib mir die k
// nächsten Nachbarn zu diesem Text". Hier wird die Wolke als GANZES ausgewertet,
// und das beantwortet drei Fragen, für die eine Trefferliste das falsche Werkzeug
// ist:
//
//   1. WO LIEGEN DIE KAPITEL ZUEINANDER — zwei Kapitel, deren Wolken
//      übereinanderliegen, erzählen dasselbe.
//   2. HÄLT EIN KAPITEL ZUSAMMEN — ein Kapitel, das in zwei Wolken zerfällt, ist
//      ein Teilungsvorschlag, den kein anderes Feature machen kann.
//   3. WAS PASST NICHT INS BUCH — die Seite mit dem grössten Abstand zum
//      Buch-Zentroid ist der eingeschobene Exkurs, der Blindtext, die vergessene
//      Notizseite.
//
// ── Warum PCA und kein t-SNE/UMAP ──────────────────────────────────────────
// PCA ist eine LINEARE Projektion und damit deterministisch, parameterfrei und
// in ~40 Zeilen selbst gerechnet (Power-Iteration mit Deflation). Nachbarschafts-
// Verfahren wie t-SNE/UMAP sähen hübscher aus, brauchen aber eine Vendor-Lib,
// haben Hyperparameter (Perplexity), sind zufallsinitialisiert — und ihre
// ABSTÄNDE sind bedeutungslos: sie erhalten lokale Nachbarschaft und erfinden
// dafür globale Struktur. Genau die globale Struktur ist hier aber die Frage.
// Zusätzlich zählt Determinismus: dieselbe Analyse muss beim zweiten Öffnen
// dasselbe Bild zeigen (gleiche Regel wie bei der Wortwolke).
//
// ── Was die Karte NICHT ist ────────────────────────────────────────────────
// Die zwei Achsen haben keine Bedeutung und bekommen darum auch keine
// Beschriftung — nur die relative Lage zählt. Die erklärte Varianz
// (`explainedVariance`) sagt, wie viel von der Wolke die Projektion überhaupt
// zeigt; bei einem kleinen Wert ist die Karte eine schwache Skizze und muss das
// zugeben, statt Nähe zu behaupten, die im Vollraum nicht existiert. Alle
// Kennzahlen (Kohäsion, Nachbarschaft, Ausreisser) werden deshalb im VOLLRAUM
// gerechnet, nie auf den 2D-Koordinaten.

const POWER_ITERS = 60;
// Abbruch, wenn sich der Eigenvektor kaum mehr dreht — bei gut getrennten
// Eigenwerten ist das nach wenigen Runden erreicht.
const POWER_EPS = 1e-7;
// Sehr kurze Chunks (blosse Überschrift, ein Satz) liegen im Vektorraum
// verrauscht und würden die Wolke ausbeulen, ohne Inhalt zu tragen. Gleiche
// Schwelle und gleiche Begründung wie im Redundanz-Radar.
const MIN_CHARS = 40;

// ── Vorbereitung ────────────────────────────────────────────────────────────

/**
 * Chunks zu Entitäts-Vektoren verdichten: ein Punkt je Seite (Mittel über ihre
 * Chunks), auf Einheitslänge normiert. Chunks unter `minChars` oder mit
 * Nullvektor fallen heraus; eine Seite, von der nichts übrig bleibt, ebenso.
 *
 * WARUM EIN PUNKT JE SEITE und nicht je Chunk: die Karte soll navigierbar sein
 * — ein Punkt muss ein Sprungziel haben. Zehn Punkte derselben Seite wären
 * zehnmal dasselbe Ziel und würden ausserdem lange Seiten überrepräsentieren.
 *
 * @param {Array<{entity_id:number, chapter_id:number|null, text:string, vector:Float32Array}>} chunks
 * @returns {{ points: Array<{id:number, chapterId:number|null, chunks:number, vector:Float32Array}> }}
 */
function preparePoints(chunks, { minChars = MIN_CHARS } = {}) {
  const acc = new Map(); // entity_id → { chapterId, sum, count, dim }
  for (const c of chunks || []) {
    const text = String(c.text == null ? '' : c.text);
    if (text.trim().length < minChars) continue;
    const v = c.vector;
    if (!v || !v.length) continue;
    let e = acc.get(c.entity_id);
    if (!e) {
      e = { chapterId: c.chapter_id ?? null, sum: new Float64Array(v.length), count: 0 };
      acc.set(c.entity_id, e);
    }
    if (v.length !== e.sum.length) continue; // Fremdmodell-Rest überspringen
    for (let i = 0; i < v.length; i++) e.sum[i] += v[i];
    e.count++;
  }

  const points = [];
  for (const [id, e] of acc) {
    if (!e.count) continue;
    const unit = _unit(e.sum);
    if (!unit) continue;
    points.push({ id, chapterId: e.chapterId, chunks: e.count, vector: unit });
  }
  // Stabile Reihenfolge: die Projektion soll bei gleicher Eingabe gleich
  // herauskommen, und Map-Iteration hängt an der Einfüge-Reihenfolge der Query.
  points.sort((a, b) => a.id - b.id);
  return { points };
}

// Vektor auf Einheitslänge; null bei Nullvektor.
function _unit(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  if (!(norm > 0)) return null;
  const inv = 1 / Math.sqrt(norm);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

// Skalarprodukt. Auf Einheitsvektoren IST das der Cosinus — die Normierung in
// `preparePoints`/`_unit` ist die Voraussetzung dafür, dass hier keine Norm mehr
// pro Paar gerechnet werden muss.
function _dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ── Projektion ──────────────────────────────────────────────────────────────

// Deterministischer Startvektor der Power-Iteration. KEIN Math.random(): die
// Karte muss bei gleicher Eingabe gleich herauskommen, und im Workflow-Kontext
// ist Math.random ohnehin verboten. Ein konstanter Vektor (alle 1) kann exakt im
// Nullraum liegen; das gestreute Muster unten ist gegen diesen Sonderfall robust
// und hängt nur von der Dimension ab.
function _seed(dim) {
  const v = new Float64Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin((i + 1) * 0.7391) + 0.1;
  return v;
}

/**
 * Grösste Eigenrichtung der Kovarianz von `rows` (zentriert) per Power-Iteration.
 * `rows` wird nicht verändert. Gibt `{ dir, eigen }` — `dir` normiert.
 */
function _topComponent(rows, dim) {
  let v = _seed(dim);
  let eigen = 0;
  const next = new Float64Array(dim);
  for (let it = 0; it < POWER_ITERS; it++) {
    next.fill(0);
    // next = Σ_i row_i · (row_i · v)  — Kovarianz-Produkt ohne die d×d-Matrix
    // je aufzubauen (bei dim=1024 wären das 1M Zellen pro Komponente).
    for (const row of rows) {
      let p = 0;
      for (let i = 0; i < dim; i++) p += row[i] * v[i];
      if (p === 0) continue;
      for (let i = 0; i < dim; i++) next[i] += row[i] * p;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += next[i] * next[i];
    norm = Math.sqrt(norm);
    if (!(norm > 0)) return { dir: null, eigen: 0 };
    let drift = 0;
    for (let i = 0; i < dim; i++) {
      const nv = next[i] / norm;
      drift += Math.abs(nv - v[i]);
      v[i] = nv;
    }
    eigen = norm;
    if (drift < POWER_EPS) break;
  }
  return { dir: v, eigen };
}

/**
 * Zwei-Komponenten-PCA der Punkte.
 *
 * @returns {{ coords: Array<[number, number]>, explainedVariance: number }}
 *   `coords[i]` gehört zu `points[i]`, skaliert auf [-1, 1] (die Achsen haben
 *   keine Einheit, nur die relative Lage zählt). `explainedVariance` ist der
 *   Anteil der Gesamtstreuung, den die zwei Achsen zeigen — 0 bei zu wenigen
 *   Punkten.
 */
function project2d(points) {
  const n = points.length;
  if (n < 3) return { coords: points.map(() => [0, 0]), explainedVariance: 0 };
  const dim = points[0].vector.length;

  // Zentrieren (PCA ohne Zentrierung findet die Richtung zum Schwerpunkt, nicht
  // die Richtung der grössten Streuung).
  const mean = new Float64Array(dim);
  for (const p of points) for (let i = 0; i < dim; i++) mean[i] += p.vector[i];
  for (let i = 0; i < dim; i++) mean[i] /= n;
  const rows = points.map(p => {
    const r = new Float64Array(dim);
    for (let i = 0; i < dim; i++) r[i] = p.vector[i] - mean[i];
    return r;
  });

  let total = 0;
  for (const r of rows) for (let i = 0; i < dim; i++) total += r[i] * r[i];

  const first = _topComponent(rows, dim);
  if (!first.dir) return { coords: points.map(() => [0, 0]), explainedVariance: 0 };

  // Deflation: erste Komponente aus den Zeilen entfernen, dann dieselbe
  // Iteration erneut → zweite Komponente, orthogonal zur ersten.
  for (const r of rows) {
    let p = 0;
    for (let i = 0; i < dim; i++) p += r[i] * first.dir[i];
    for (let i = 0; i < dim; i++) r[i] -= p * first.dir[i];
  }
  const second = _topComponent(rows, dim);

  const xs = [];
  const ys = [];
  for (const p of points) {
    let x = 0;
    let y = 0;
    for (let i = 0; i < dim; i++) {
      const c = p.vector[i] - mean[i];
      x += c * first.dir[i];
      if (second.dir) y += c * second.dir[i];
    }
    xs.push(x);
    ys.push(y);
  }

  const coords = _scaleToUnitBox(xs, ys);
  const explained = total > 0 ? Math.min(1, (first.eigen + (second.eigen || 0)) / total) : 0;
  return { coords, explainedVariance: explained };
}

// Beide Achsen mit DEMSELBEN Faktor auf [-1,1] bringen. Getrennt skaliert wären
// die Abstände verzerrt und eine gestreckte Wolke sähe rund aus — genau die
// Aussage, die die Karte machen soll, wäre dahin.
function _scaleToUnitBox(xs, ys) {
  let max = 0;
  for (let i = 0; i < xs.length; i++) {
    max = Math.max(max, Math.abs(xs[i]), Math.abs(ys[i]));
  }
  const f = max > 0 ? 1 / max : 0;
  return xs.map((x, i) => [x * f, ys[i] * f]);
}

// ── Kennzahlen (alle im Vollraum) ───────────────────────────────────────────

/**
 * Je Kapitel: Kohäsion (mittlere Ähnlichkeit seiner Seiten zum eigenen
 * Kapitel-Zentroid) und der nächste Nachbar (das Kapitel mit dem ähnlichsten
 * Zentroid).
 *
 * KOHÄSION IST KEIN GÜTEMASS. Ein niedriger Wert heisst „thematisch breit", und
 * das ist im Sachbuch-Übersichtskapitel richtig und im Szenen-Kapitel ein
 * Hinweis. Darum liefert die Funktion Zahlen und keine Urteile; die Deutung
 * bleibt beim Autor.
 *
 * Kapitel mit weniger als zwei Seiten haben keine Streuung und bekommen
 * `cohesion: null` — ein Wert von 1.0 wäre die Behauptung perfekter Geschlossen-
 * heit, wo einfach nichts zu vergleichen war.
 *
 * @returns {Array<{chapterId, pages, cohesion, spread, nearestChapterId, nearestScore}>}
 */
function chapterStats(points) {
  const byChapter = new Map();
  for (const p of points) {
    if (p.chapterId == null) continue; // kapitellose Seite: kein Kapitel-Befund
    let g = byChapter.get(p.chapterId);
    if (!g) { g = []; byChapter.set(p.chapterId, g); }
    g.push(p);
  }

  const centroids = new Map();
  for (const [cid, group] of byChapter) {
    const dim = group[0].vector.length;
    const sum = new Float64Array(dim);
    for (const p of group) for (let i = 0; i < dim; i++) sum[i] += p.vector[i];
    const c = _unit(sum);
    if (c) centroids.set(cid, c);
  }

  const out = [];
  for (const [cid, group] of byChapter) {
    const centroid = centroids.get(cid);
    if (!centroid) continue;
    let cohesion = null;
    let spread = null;
    if (group.length >= 2) {
      const sims = group.map(p => _dot(p.vector, centroid));
      cohesion = sims.reduce((a, b) => a + b, 0) / sims.length;
      // Streuung als Abstand des entlegensten Mitglieds vom Zentroid: das ist
      // die Zahl, die „zerfällt in zwei Hälften" sichtbar macht — ein Mittelwert
      // allein verwischt sie.
      spread = 1 - Math.min(...sims);
    }
    let nearestChapterId = null;
    let nearestScore = null;
    for (const [otherId, otherCentroid] of centroids) {
      if (otherId === cid) continue;
      const s = _dot(centroid, otherCentroid);
      if (nearestScore == null || s > nearestScore) { nearestScore = s; nearestChapterId = otherId; }
    }
    out.push({
      chapterId: cid,
      pages: group.length,
      cohesion,
      spread,
      nearestChapterId,
      nearestScore,
    });
  }
  return out;
}

/**
 * Seiten mit dem grössten Abstand zum Buch-Zentroid — „was passt hier nicht
 * hinein". `topK` Zeilen, absteigend nach Abstand.
 *
 * Der Abstand wird zum Zentroid ALLER Seiten gerechnet, nicht zum eigenen
 * Kapitel: die Frage ist „gehört das in dieses Buch", nicht „gehört das in
 * dieses Kapitel" (letzteres steckt in `chapterStats.spread`).
 */
function outliers(points, { topK = 10 } = {}) {
  if (points.length < 3) return [];
  const dim = points[0].vector.length;
  const sum = new Float64Array(dim);
  for (const p of points) for (let i = 0; i < dim; i++) sum[i] += p.vector[i];
  const centroid = _unit(sum);
  if (!centroid) return [];
  return points
    .map(p => ({ id: p.id, chapterId: p.chapterId, distance: 1 - _dot(p.vector, centroid) }))
    .sort((a, b) => b.distance - a.distance)
    .slice(0, topK);
}

module.exports = { preparePoints, project2d, chapterStats, outliers, MIN_CHARS };
