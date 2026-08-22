// Buchlandkarte — pure Mathematik (lib/book-map.js): Punkt-Verdichtung,
// PCA-Projektion, Kapitel-Kennzahlen, Ausreisser. Kein DB-/Netz-Zugriff.
//
// Die Tests pruefen die Eigenschaften, auf die sich die Karte verlaesst — nicht
// konkrete Koordinaten: eine Eigenrichtung ist nur bis aufs Vorzeichen bestimmt,
// ein Test auf feste x/y waere darum ein Test auf die Laune der Iteration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { preparePoints, project2d, chapterStats, outliers } = require('../../lib/book-map.js');

const LONG = 'Ein ausreichend langer Beispieltext fuer den Chunk der Seite. ';

function chunk(entity_id, chapter_id, vector, { text = LONG, chunk_ix = 0 } = {}) {
  return { entity_id, chapter_id, chunk_ix, text, vector: Float32Array.from(vector) };
}

// ── preparePoints ───────────────────────────────────────────────────────────

test('preparePoints: ein Punkt je Seite, Vektoren auf Einheitslaenge', () => {
  const { points } = preparePoints([
    chunk(1, 10, [3, 0, 0]),
    chunk(1, 10, [0, 3, 0], { chunk_ix: 1 }),
    chunk(2, 10, [0, 0, 5]),
  ]);
  assert.equal(points.length, 2);
  const p1 = points.find(p => p.id === 1);
  assert.equal(p1.chunks, 2);
  // Mittel aus (3,0,0) und (0,3,0), normiert → beide Komponenten gleich gross.
  const norm = Math.hypot(...p1.vector);
  assert.ok(Math.abs(norm - 1) < 1e-6, `Norm ${norm} sollte 1 sein`);
  assert.ok(Math.abs(p1.vector[0] - p1.vector[1]) < 1e-6);
});

test('preparePoints: zu kurze Chunks und Nullvektoren fallen heraus', () => {
  const { points } = preparePoints([
    chunk(1, null, [1, 0, 0], { text: 'kurz' }),
    chunk(2, null, [0, 0, 0]),
    chunk(3, null, [0, 1, 0]),
  ]);
  assert.deepEqual(points.map(p => p.id), [3]);
});

test('preparePoints: Reihenfolge ist stabil (nach id), unabhaengig von der Eingabe', () => {
  const mk = (order) => preparePoints(order.map(id => chunk(id, null, [id, 1, 0]))).points.map(p => p.id);
  assert.deepEqual(mk([3, 1, 2]), [1, 2, 3]);
  assert.deepEqual(mk([2, 3, 1]), [1, 2, 3]);
});

test('preparePoints: Chunk mit fremder Dimension kippt die Seite nicht', () => {
  const { points } = preparePoints([
    chunk(1, null, [1, 0, 0]),
    chunk(1, null, [1, 0, 0, 0], { chunk_ix: 1 }), // Fremdmodell-Rest
  ]);
  assert.equal(points.length, 1);
  assert.equal(points[0].chunks, 1);
});

// ── project2d ───────────────────────────────────────────────────────────────

test('project2d: Koordinate je Punkt, in der Einheitsbox', () => {
  const { points } = preparePoints([
    chunk(1, null, [1, 0, 0]),
    chunk(2, null, [0, 1, 0]),
    chunk(3, null, [0, 0, 1]),
    chunk(4, null, [1, 1, 0]),
  ]);
  const { coords, explainedVariance } = project2d(points);
  assert.equal(coords.length, points.length);
  for (const [x, y] of coords) {
    assert.ok(Math.abs(x) <= 1 + 1e-6 && Math.abs(y) <= 1 + 1e-6, `(${x},${y}) ausserhalb der Box`);
  }
  assert.ok(explainedVariance > 0 && explainedVariance <= 1);
});

test('project2d: deterministisch — gleiche Eingabe, gleiches Ergebnis', () => {
  const build = () => preparePoints([
    chunk(1, null, [1, 0.2, 0]),
    chunk(2, null, [0.9, 0.1, 0.1]),
    chunk(3, null, [0, 1, 0.3]),
    chunk(4, null, [0.1, 0.9, 0]),
    chunk(5, null, [0, 0.2, 1]),
  ]).points;
  assert.deepEqual(project2d(build()).coords, project2d(build()).coords);
});

test('project2d: zwei getrennte Gruppen liegen in der Projektion getrennt', () => {
  // Zwei Cluster mit je drei Punkten, orthogonal zueinander.
  const { points } = preparePoints([
    chunk(1, null, [1, 0, 0, 0]), chunk(2, null, [0.98, 0.02, 0, 0]), chunk(3, null, [0.97, 0, 0.03, 0]),
    chunk(4, null, [0, 0, 0, 1]), chunk(5, null, [0, 0.02, 0, 0.98]), chunk(6, null, [0, 0, 0.03, 0.97]),
  ]);
  const { coords } = project2d(points);
  const at = (id) => coords[points.findIndex(p => p.id === id)];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const inner = Math.max(dist(at(1), at(2)), dist(at(4), at(5)));
  const across = dist(at(1), at(4));
  assert.ok(across > inner * 3, `Cluster-Abstand ${across} sollte den Innenabstand ${inner} klar uebertreffen`);
});

test('project2d: beide Achsen teilen einen Faktor — eine langgezogene Wolke bleibt langgezogen', () => {
  // Weit gestreut in der einen Richtung, schmal in der anderen. Wuerden die
  // Achsen GETRENNT auf [-1,1] skaliert, saehe die Wolke rund aus — und die
  // einzige Aussage der Karte („diese zwei liegen nah") waere verzerrt.
  const chunks = [];
  for (let i = -5; i <= 5; i++) {
    chunks.push(chunk(i + 6, null, [1, i * 0.2, ((i % 3) - 1) * 0.01, 0]));
  }
  const { points } = preparePoints(chunks);
  const { coords } = project2d(points);
  const extent = (ix) => Math.max(...coords.map(c => Math.abs(c[ix])));
  // Bei GETRENNTER Skalierung waeren beide Ausdehnungen exakt 1 — der Abstand
  // zur Haelfte ist die Reserve gegen Rundungsrauschen in beide Richtungen.
  assert.ok(extent(1) < extent(0) / 2,
    `y-Ausdehnung ${extent(1)} muesste klar unter der x-Ausdehnung ${extent(0)} liegen`);
});

test('project2d: unter drei Punkten keine Projektion, aber auch kein Absturz', () => {
  const { points } = preparePoints([chunk(1, null, [1, 0, 0]), chunk(2, null, [0, 1, 0])]);
  const { coords, explainedVariance } = project2d(points);
  assert.deepEqual(coords, [[0, 0], [0, 0]]);
  assert.equal(explainedVariance, 0);
});

test('project2d: identische Punkte haben keine Streuung → Nullkoordinaten', () => {
  const { points } = preparePoints([
    chunk(1, null, [1, 0, 0]), chunk(2, null, [1, 0, 0]), chunk(3, null, [1, 0, 0]),
  ]);
  const { coords } = project2d(points);
  for (const [x, y] of coords) {
    assert.ok(Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6);
  }
});

// ── chapterStats ────────────────────────────────────────────────────────────

test('chapterStats: geschlossenes Kapitel rankt hoeher als zerfallendes', () => {
  const { points } = preparePoints([
    // Kapitel 1: alle drei Seiten nah beieinander.
    chunk(1, 1, [1, 0, 0, 0]), chunk(2, 1, [0.98, 0.02, 0, 0]), chunk(3, 1, [0.99, 0, 0.01, 0]),
    // Kapitel 2: zwei Haelften, die nichts miteinander zu tun haben.
    chunk(4, 2, [1, 0, 0, 0]), chunk(5, 2, [0, 0, 0, 1]),
  ]);
  const stats = chapterStats(points);
  const c1 = stats.find(c => c.chapterId === 1);
  const c2 = stats.find(c => c.chapterId === 2);
  assert.ok(c1.cohesion > c2.cohesion, `${c1.cohesion} sollte > ${c2.cohesion} sein`);
  assert.ok(c2.spread > c1.spread, 'das zerfallende Kapitel hat die groessere Streuung');
  assert.equal(c1.pages, 3);
});

test('chapterStats: Ein-Seiten-Kapitel behauptet keine Geschlossenheit', () => {
  const { points } = preparePoints([
    chunk(1, 1, [1, 0, 0]),
    chunk(2, 2, [0, 1, 0]), chunk(3, 2, [0, 0.99, 0.01]),
  ]);
  const c1 = chapterStats(points).find(c => c.chapterId === 1);
  assert.equal(c1.cohesion, null, 'ohne zweite Seite gibt es keinen Wert, auch nicht 1.0');
  assert.equal(c1.spread, null);
});

test('chapterStats: nearest zeigt auf das inhaltlich naechste Kapitel', () => {
  const { points } = preparePoints([
    chunk(1, 1, [1, 0, 0, 0]), chunk(2, 1, [0.99, 0.01, 0, 0]),
    chunk(3, 2, [0.9, 0.1, 0, 0]), chunk(4, 2, [0.95, 0.05, 0, 0]),  // nah an Kapitel 1
    chunk(5, 3, [0, 0, 0, 1]), chunk(6, 3, [0, 0, 0.01, 0.99]),      // weit weg
  ]);
  const stats = chapterStats(points);
  assert.equal(stats.find(c => c.chapterId === 1).nearestChapterId, 2);
  assert.equal(stats.find(c => c.chapterId === 2).nearestChapterId, 1);
});

test('chapterStats: kapitellose Seiten erzeugen keine Kapitel-Zeile', () => {
  const { points } = preparePoints([chunk(1, null, [1, 0, 0]), chunk(2, null, [0, 1, 0])]);
  assert.deepEqual(chapterStats(points), []);
});

test('chapterStats: einzelnes Kapitel hat keinen Nachbarn', () => {
  const { points } = preparePoints([chunk(1, 1, [1, 0, 0]), chunk(2, 1, [0.9, 0.1, 0])]);
  const c = chapterStats(points)[0];
  assert.equal(c.nearestChapterId, null);
  assert.equal(c.nearestScore, null);
});

// ── outliers ────────────────────────────────────────────────────────────────

test('outliers: die abseits liegende Seite steht oben', () => {
  const { points } = preparePoints([
    chunk(1, 1, [1, 0, 0, 0]), chunk(2, 1, [0.99, 0.01, 0, 0]),
    chunk(3, 1, [0.98, 0.02, 0, 0]), chunk(4, 1, [0.97, 0, 0.03, 0]),
    chunk(9, 1, [0, 0, 0, 1]), // der Exkurs
  ]);
  const rows = outliers(points);
  assert.equal(rows[0].id, 9);
  assert.ok(rows[0].distance > rows[1].distance);
});

test('outliers: topK deckelt die Liste', () => {
  const chunks = [];
  for (let i = 1; i <= 20; i++) chunks.push(chunk(i, 1, [1, i / 100, 0]));
  const { points } = preparePoints(chunks);
  assert.equal(outliers(points, { topK: 5 }).length, 5);
});

test('outliers: unter drei Seiten keine Aussage', () => {
  const { points } = preparePoints([chunk(1, 1, [1, 0, 0]), chunk(2, 1, [0, 1, 0])]);
  assert.deepEqual(outliers(points), []);
});
