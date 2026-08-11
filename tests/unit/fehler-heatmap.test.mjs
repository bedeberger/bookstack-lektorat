// Aggregation der Fehler-Heatmap (lib/fehler-heatmap.js).
//
// Warum ueberhaupt testbar: die Verdichtung lag als 160-Zeilen-Block im
// Route-Handler von /history/fehler-heatmap und war damit nur ueber einen
// HTTP-Request mit DB-Bestand erreichbar. Als pure Funktion sind die drei Modi
// und die kumulative applied-Union direkt pruefbar — genau die Stellen, an denen
// sich die Karte still verrechnen kann.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFehlerHeatmap, normalizeMode, MODES } from '../../lib/fehler-heatmap.js';

const page = (page_id, chapter_id, words, extra = {}) => ({
  page_id, chapter_id, chapter_name: chapter_id ? `Kapitel ${chapter_id}` : null,
  page_name: `Seite ${page_id}`, words, ...extra,
});
const finding = (typ, original, extra = {}) => ({ typ, original, korrektur: original + '!', erklaerung: 'weil', ...extra });
const check = (page_id, findings) => ({ page_id, errors_json: JSON.stringify(findings) });
const applied = (page_id, findings) => ({ page_id, applied_errors_json: JSON.stringify(findings) });

test('normalizeMode: nur die drei Modi, sonst open', () => {
  for (const m of MODES) assert.equal(normalizeMode(m), m);
  assert.equal(normalizeMode('bogus'), 'open');
  assert.equal(normalizeMode(undefined), 'open');
  assert.equal(normalizeMode(null), 'open');
});

test('open (Default) zaehlt nur Findings, die NICHT angenommen wurden', () => {
  const r = buildFehlerHeatmap({
    pages: [page(1, 10, 1000)],
    checks: [check(1, [finding('stil', 'A'), finding('stil', 'B'), finding('grammatik', 'C')])],
    appliedRows: [applied(1, [finding('stil', 'A')])],
  });
  assert.equal(r.mode, 'open');
  assert.equal(r.matrix[10].stil.count, 1);        // B bleibt offen, A ist angenommen
  assert.equal(r.matrix[10].grammatik.count, 1);
  assert.deepEqual(r.totals, { stil: 1, grammatik: 1 });
});

test('applied zaehlt die Union ueber ALLE Checks der Seite, dedupliziert per original', () => {
  // Kumulativ: der juengste Check kennt A nicht mehr, angenommen bleibt es doch.
  const r = buildFehlerHeatmap({
    pages: [page(1, 10, 1000)],
    checks: [check(1, [finding('stil', 'B')])],
    appliedRows: [
      applied(1, [finding('stil', 'A')]),
      applied(1, [finding('stil', 'A'), finding('grammatik', 'C')]), // A doppelt gemeldet
    ],
    mode: 'applied',
  });
  assert.equal(r.matrix[10].stil.count, 1, 'A nur einmal gezaehlt');
  assert.equal(r.matrix[10].grammatik.count, 1);
});

test('all zaehlt alle Findings des juengsten Checks, unabhaengig von applied', () => {
  const r = buildFehlerHeatmap({
    pages: [page(1, 10, 1000)],
    checks: [check(1, [finding('stil', 'A'), finding('stil', 'B')])],
    appliedRows: [applied(1, [finding('stil', 'A')])],
    mode: 'all',
  });
  assert.equal(r.matrix[10].stil.count, 2);
});

test('Dichte per1k rechnet gegen die Woerter des Kapitels, 0 Woerter → 0', () => {
  const r = buildFehlerHeatmap({
    pages: [page(1, 10, 500), page(2, 10, 500)],
    checks: [check(1, [finding('stil', 'A'), finding('stil', 'B')])],
    appliedRows: [],
  });
  // 2 Fehler auf 1000 Woerter = 2.0 je 1000
  assert.equal(r.matrix[10].stil.per1k, 2);
  assert.equal(r.matrix[10].stil.pages, 1, 'nur Seite 1 traegt den Typ');

  const zero = buildFehlerHeatmap({
    pages: [page(1, 10, 0)],
    checks: [check(1, [finding('stil', 'A')])],
    appliedRows: [],
  });
  assert.equal(zero.matrix[10].stil.per1k, 0);
});

test('ungeprueft ist nicht fehlerfrei: pages_checked zaehlt nur Seiten mit Check', () => {
  const r = buildFehlerHeatmap({
    pages: [page(1, 10, 100), page(2, 10, 100), page(3, 10, 100)],
    checks: [check(1, [])],
    appliedRows: [],
  });
  const ch = r.chapters.find(c => c.chapter_id === 10);
  assert.equal(ch.pages_total, 3);
  assert.equal(ch.pages_checked, 1);
  assert.equal(ch.words, 300);
});

test('Seiten ohne Kapitel landen unter __uncat__ und sortieren ans Ende', () => {
  const r = buildFehlerHeatmap({
    pages: [page(1, null, 100), page(2, 7, 100), page(3, 2, 100)],
    checks: [check(1, [finding('stil', 'A')]), check(2, [finding('stil', 'B')])],
    appliedRows: [],
  });
  assert.deepEqual(r.chapters.map(c => c.chapter_id), [2, 7, null]);
  assert.equal(r.matrix.__uncat__.stil.count, 1);
});

test('details: pro Kapitel+Typ absteigend nach Anzahl, max 3 Beispiele je Seite', () => {
  const many = ['a', 'b', 'c', 'd', 'e'].map(o => finding('stil', o));
  const r = buildFehlerHeatmap({
    pages: [page(1, 10, 100), page(2, 10, 100)],
    checks: [check(1, many), check(2, [finding('stil', 'z')])],
    appliedRows: [],
  });
  const rows = r.details['10:stil'];
  assert.deepEqual(rows.map(x => x.count), [5, 1], 'absteigend');
  assert.equal(rows[0].samples.length, 3, 'Beispiele gedeckelt');
  assert.deepEqual(rows[0].samples[0], { original: 'a', korrektur: 'a!', erklaerung: 'weil' });
});

test('kaputtes JSON und Findings ohne Typ kippen die Antwort nicht', () => {
  const r = buildFehlerHeatmap({
    pages: [page(1, 10, 100), page(2, 10, 100)],
    checks: [
      { page_id: 1, errors_json: '{kein json' },
      { page_id: 2, errors_json: JSON.stringify([{ original: 'X' }, finding('stil', 'Y')]) },
    ],
    appliedRows: [{ page_id: 2, applied_errors_json: 'auch kaputt' }],
  });
  assert.equal(r.matrix[10].stil.count, 1);
  assert.equal(r.chapters[0].pages_checked, 2, 'kaputter Check zaehlt als geprueft');
});

test('leere Eingabe liefert eine wohlgeformte, leere Antwort', () => {
  const r = buildFehlerHeatmap({});
  assert.deepEqual(r, { mode: 'open', chapters: [], matrix: {}, totals: {}, details: {} });
});

test('open ignoriert Findings ohne original (kein Abgleich moeglich)', () => {
  // Ein Finding ohne `original` kann nicht als angenommen erkannt werden; es
  // faellt im open-Modus heraus statt faelschlich als offen zu zaehlen.
  const r = buildFehlerHeatmap({
    pages: [page(1, 10, 100)],
    checks: [{ page_id: 1, errors_json: JSON.stringify([{ typ: 'stil' }]) }],
    appliedRows: [],
  });
  assert.equal(r.matrix[10].stil, undefined);
  assert.deepEqual(r.totals, {});
});
