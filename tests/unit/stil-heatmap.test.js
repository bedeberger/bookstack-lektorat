'use strict';
// Verdichtung der Stil-Karte: lib/stil-heatmap.js. Getestet wird die
// Kapitel-Aggregation (gewichtet, nicht arithmetisch), der Drilldown-Zuschnitt
// und die Frage „muss nachgerechnet werden?" — das ist die Entscheidung, die
// frueher eine Metrik-Versions-KOPIE im Frontend traf.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildStilHeatmap, buildStilDetail, isSampleBucket, parseStyleRow } = require('../../lib/stil-heatmap');

function row(over = {}) {
  return {
    page_id: 1, chapter_id: 1, chapter_name: 'K1',
    words: 100, chars: 600, dialog_chars: 60,
    filler_count: 5, passive_count: 2, adverb_count: 9,
    avg_sentence_len: 12, sentence_len_p90: 20,
    lix: 40, flesch_de: 60, metrics_version: 7,
    cached_at: '2026-01-01T10:00:00.000Z',
    repetition_data: JSON.stringify({ score: 3, top: [{ word: 'und', count: 4 }] }),
    style_samples: JSON.stringify({ filler: [{ token: 'eigentlich', sentence: 'Ein Satz.' }], passive: [], adverb: [] }),
    sentence_lens: JSON.stringify([5, 12, 19]),
    opener_counts: JSON.stringify({ counts: { Er: 2, Sie: 1 }, repeats: 1 }),
    ...over,
  };
}

test('parseStyleRow: korrupte JSON-Spalte kippt die Zeile nicht', () => {
  const p = parseStyleRow(row({ repetition_data: '{kaputt', sentence_lens: 'nope', opener_counts: '[]' }));
  assert.equal(p.repetition_data, null);
  assert.equal(p.sentence_lens, null);
  // Ein Array ist kein Zaehl-Objekt — darf nicht als opener_counts durchgehen.
  assert.deepEqual(p.opener_counts, []);
});

test('buildStilHeatmap: Dichten pro 1000 Woerter, Dialog in Prozent', () => {
  const { chapters } = buildStilHeatmap({ rows: [row()], metricsVersion: 7 });
  assert.equal(chapters.length, 1);
  const c = chapters[0];
  assert.equal(c.filler_per1k, 50);   // 5 / 100 * 1000
  assert.equal(c.passive_per1k, 20);
  assert.equal(c.adverb_per1k, 90);
  assert.equal(c.dialog_ratio, 10);   // 60 / 600
  assert.equal(c.words, 100);
  assert.equal(c.pageCount, 1);
});

test('buildStilHeatmap: Mittelwerte sind wortgewichtet, nicht seitengewichtet', () => {
  // Eine lange Seite mit kurzen Saetzen und eine kurze Seite mit langen Saetzen:
  // arithmetisch waere der Schnitt 30, gewichtet ist er nahe an der langen Seite.
  const rows = [
    row({ page_id: 1, words: 900, avg_sentence_len: 10 }),
    row({ page_id: 2, words: 100, avg_sentence_len: 50 }),
  ];
  const { chapters } = buildStilHeatmap({ rows, metricsVersion: 7 });
  assert.equal(chapters[0].avg_sentence_len, 14); // (10*900 + 50*100) / 1000
});

test('buildStilHeatmap: Seiten ohne Kapitel bekommen den __uncat__-Schluessel und keinen Namen', () => {
  const { chapters } = buildStilHeatmap({
    rows: [row({ chapter_id: null, chapter_name: null })],
    metricsVersion: 7,
  });
  assert.equal(chapters[0].key, '__uncat__');
  // Das Label ist UI-Text und gehoert in die Locale-Datei, nicht in die Antwort.
  assert.equal(chapters[0].name, null);
});

test('buildStilHeatmap: needsSync bei alter Metrik-Version', () => {
  assert.equal(buildStilHeatmap({ rows: [row()], metricsVersion: 7 }).needsSync, false);
  assert.equal(buildStilHeatmap({ rows: [row({ metrics_version: 6 })], metricsVersion: 7 }).needsSync, true);
});

test('buildStilHeatmap: needsSync bei fehlendem Wert trotz Text', () => {
  assert.equal(buildStilHeatmap({ rows: [row({ lix: null })], metricsVersion: 7 }).needsSync, true);
  // Eine leere Seite ist kein Grund nachzurechnen.
  assert.equal(buildStilHeatmap({ rows: [row({ lix: null, words: 0 })], metricsVersion: 7 }).needsSync, false);
});

test('buildStilHeatmap: ohne Zeilen ist nichts berechnet, also needsSync', () => {
  const r = buildStilHeatmap({ rows: [], metricsVersion: 7 });
  assert.equal(r.needsSync, true);
  assert.deepEqual(r.chapters, []);
  assert.equal(r.lastUpdated, null);
});

test('buildStilHeatmap: lastUpdated ist der juengste Stand', () => {
  const rows = [
    row({ page_id: 1, cached_at: '2026-01-01T10:00:00.000Z' }),
    row({ page_id: 2, cached_at: '2026-03-05T08:00:00.000Z' }),
  ];
  assert.equal(buildStilHeatmap({ rows, metricsVersion: 7 }).lastUpdated, '2026-03-05T08:00:00.000Z');
});

test('buildStilHeatmap: Beispielsaetze reisen NICHT im Kapitel-Raster mit', () => {
  const { chapters } = buildStilHeatmap({ rows: [row()], metricsVersion: 7 });
  const blob = JSON.stringify(chapters);
  assert.ok(!blob.includes('eigentlich'), 'style_samples darf nicht in der Rasterantwort stehen');
  assert.ok(!blob.includes('sentence_lens'), 'die Satzlaengen-Sequenz gehoert ins Band, nicht in die Zeile');
});

test('buildStilHeatmap: Rhythmus und Satzanfaenge haengen mit an der Antwort', () => {
  const r = buildStilHeatmap({ rows: [row()], metricsVersion: 7 });
  assert.equal(r.rhythm.rows.length, 1);
  assert.equal(r.rhythm.rows[0].count, 3);
  assert.equal(r.openers.total, 3);
});

test('isSampleBucket: nur die vier bekannten Eimer', () => {
  for (const b of ['filler', 'passive', 'adverb', 'repetition']) assert.ok(isSampleBucket(b));
  for (const b of ['lix', '', null, 'DROP TABLE']) assert.ok(!isSampleBucket(b));
});

test('buildStilDetail: gruppiert Beispiele nach Token, sortiert Seiten nach Trefferzahl', () => {
  const rows = [
    row({ page_id: 1, page_name: 'S1', filler_count: 2, style_samples: JSON.stringify({ filler: [
      { token: 'eigentlich', sentence: 'A' }, { token: 'eigentlich', sentence: 'B' },
    ] }) }),
    row({ page_id: 2, page_name: 'S2', filler_count: 9, style_samples: JSON.stringify({ filler: [
      { token: 'halt', sentence: 'C' },
    ] }) }),
  ];
  const { entries } = buildStilDetail({ rows, bucket: 'filler' });
  assert.deepEqual(entries.map(e => e.page_name), ['S2', 'S1'], 'dichteste Seite zuerst');
  const s1 = entries.find(e => e.page_name === 'S1');
  assert.equal(s1.tokens.length, 1, 'zweimal dasselbe Wort ist eine Gruppe');
  assert.deepEqual(s1.tokens[0].sentences, ['A', 'B']);
});

test('buildStilDetail: Seiten ohne Treffer erscheinen nicht', () => {
  const rows = [row({ page_id: 3, style_samples: JSON.stringify({ filler: [], passive: [], adverb: [] }) })];
  assert.deepEqual(buildStilDetail({ rows, bucket: 'filler' }).entries, []);
});

test('buildStilDetail: Wiederholungen liefern Woerter statt Saetze', () => {
  const { entries } = buildStilDetail({ rows: [row({ page_name: 'S1' })], bucket: 'repetition' });
  assert.deepEqual(entries[0].words, [{ token: 'und', count: 4 }]);
  assert.equal(entries[0].count, 4);
  assert.equal(entries[0].tokens, undefined);
});

test('buildStilDetail: unbekannter Eimer liefert nichts statt zu raten', () => {
  assert.deepEqual(buildStilDetail({ rows: [row()], bucket: 'lix' }).entries, []);
});
