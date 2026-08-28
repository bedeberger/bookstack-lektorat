// Render-fertige Zeilen der Stil-Heatmap: public/js/book/stil-heatmap.js#buildStilRows.
//
// Der Test haelt fest, was der Grund fuer diese Funktion ist: die Farbskala einer
// Spalte ist eine Eigenschaft ALLER Kapitel (Min/Max), wird aber pro Zelle
// gebraucht. Frueher rechnete das Template sie in jeder Zelle neu — bei
// Kapiteln x 9 Metriken x 2 Bindings war das O(Kapitel^2) pro Render.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStilRows } from '../../public/js/book/stil-heatmap.js';

function chapter(over = {}) {
  return {
    key: '1', name: 'K1', pageCount: 2, words: 1000,
    filler_per1k: 5, passive_per1k: 2, adverb_per1k: 9,
    avg_sentence_len: 14, sentence_len_p90: 30, dialog_ratio: 12,
    repetition_score: 3, lix: 40, flesch_de: 60,
    ...over,
  };
}

test('buildStilRows: leere Eingabe liefert keine Zeilen', () => {
  assert.deepEqual(buildStilRows([], 'de'), []);
  assert.deepEqual(buildStilRows(null, 'de'), []);
});

test('buildStilRows: jede Zeile traegt eine fertige Zelle je Metrik', () => {
  const [r] = buildStilRows([chapter()], 'de');
  const keys = Object.keys(r.cells);
  assert.equal(keys.length, 9);
  for (const k of keys) {
    const c = r.cells[k];
    assert.equal(typeof c.text, 'string');
    assert.equal(typeof c.cls, 'string');
    assert.equal(typeof c.clickable, 'boolean');
    assert.equal(c.detailKey, `1:${k}`);
  }
});

test('buildStilRows: bei einem einzigen Kapitel gibt es keine Skala, also kein Tint', () => {
  const [r] = buildStilRows([chapter()], 'de');
  // min === max fuer jede Metrik → neutral, keine CSS-Variablen.
  assert.ok(r.cells.filler_per1k.cls.startsWith('heatmap-cell--neutral'));
  assert.deepEqual(r.cells.filler_per1k.vars, {});
});

test('buildStilRows: die Skala spannt ueber alle Kapitel, nicht ueber die Zeile', () => {
  const rows = buildStilRows([
    chapter({ key: '1', filler_per1k: 0 }),
    chapter({ key: '2', filler_per1k: 10 }),
    chapter({ key: '3', filler_per1k: 5 }),
  ], 'de');
  assert.equal(rows[0].cells.filler_per1k.vars['--heatmap-t'], '0%');
  assert.equal(rows[1].cells.filler_per1k.vars['--heatmap-t'], '100%');
  assert.equal(rows[2].cells.filler_per1k.vars['--heatmap-t'], '50%');
});

test('buildStilRows: Flesch ist umgekehrt gepolt — hoch ist gut, also gruen', () => {
  const rows = buildStilRows([
    chapter({ key: '1', flesch_de: 20 }),
    chapter({ key: '2', flesch_de: 80 }),
  ], 'de');
  // t=1 heisst rot. Der schlechtere (niedrigere) Flesch-Wert muss ihn bekommen.
  assert.equal(rows[0].cells.flesch_de.vars['--heatmap-t'], '100%');
  assert.equal(rows[1].cells.flesch_de.vars['--heatmap-t'], '0%');
});

test('buildStilRows: richtungslose Metriken bekommen die Primary-Skala, nicht gruen/rot', () => {
  const rows = buildStilRows([
    chapter({ key: '1', avg_sentence_len: 8 }),
    chapter({ key: '2', avg_sentence_len: 24 }),
  ], 'de');
  for (const r of rows) assert.ok(r.cells.avg_sentence_len.cls.startsWith('heatmap-cell--primary'));
  // Primary-Skala ist eine Deckkraft, kein Farbverlauf → keine --heatmap-opacity.
  assert.equal(rows[1].cells.avg_sentence_len.vars['--heatmap-opacity'], undefined);
});

test('buildStilRows: klickbar ist nur, was Beispiele hat UND vorkommt', () => {
  const [r] = buildStilRows([chapter({ filler_per1k: 5, repetition_score: 0 })], 'de');
  assert.equal(r.cells.filler_per1k.clickable, true, 'Fuellwoerter haben Beispiele');
  assert.ok(r.cells.filler_per1k.cls.includes('heatmap-cell--clickable'));
  assert.equal(r.cells.repetition_score.clickable, false, 'Wert 0 → nichts aufzuklappen');
  assert.equal(r.cells.lix.clickable, false, 'LIX hat keinen Beispiel-Eimer');
  assert.ok(!r.cells.lix.cls.includes('clickable'));
});

test('buildStilRows: fehlender Wert bleibt neutral statt als 0 gefaerbt', () => {
  const rows = buildStilRows([
    chapter({ key: '1', lix: null }),
    chapter({ key: '2', lix: 50 }),
  ], 'de');
  assert.ok(rows[0].cells.lix.cls.startsWith('heatmap-cell--neutral'));
  assert.deepEqual(rows[0].cells.lix.vars, {});
});

test('buildStilRows: Kapitel-Felder bleiben erhalten, Woerter sind vorformatiert', () => {
  const [r] = buildStilRows([chapter({ words: 12345 })], 'de');
  assert.equal(r.key, '1');
  assert.equal(r.pageCount, 2);
  assert.equal(typeof r.wordsLabel, 'string');
  assert.ok(/12.?345/.test(r.wordsLabel), `unerwartete Formatierung: ${r.wordsLabel}`);
});
