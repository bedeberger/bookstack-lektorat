'use strict';
// Unit-Tests für lib/page-index.js – Pronomen/Dialog-Split, Stil-Stats, Figuren-Matching.

const test = require('node:test');
const assert = require('node:assert/strict');

// better-sqlite3 öffnet die DB beim Import. Für reine Logik-Tests umgehen wir das
// nicht (es ist ok, db schema zu laden — die Funktionen verwenden es erst lazy).
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const {
  computePronounsAndDialog,
  computeStyleStats,
  computeFigureMentions,
  tokenizeNamesForStopwords,
} = require('../../lib/page-index');

test('Pronomen: Ich-Erzähler narrativ vs. Dialog getrennt gezählt', () => {
  const text = 'Ich ging zum Fenster. Er sagte: «Ich komme gleich.»';
  const { pronoun_counts } = computePronounsAndDialog(text);
  assert.equal(pronoun_counts.ich.narr, 1, 'ein Ich im Erzähltext');
  assert.equal(pronoun_counts.ich.dlg,  1, 'ein Ich im Dialog');
});

test('Dialog-Marker: «…» umschliesst korrekt', () => {
  const text = 'Er antwortete «sie kommt gleich».';
  const { pronoun_counts, dialog_chars } = computePronounsAndDialog(text);
  assert.ok(dialog_chars > 0, 'dialog_chars > 0 für CH-Guillemets');
  assert.equal(pronoun_counts.sie_sg.dlg, 1);
  assert.equal(pronoun_counts.sie_sg.narr, 0);
});

test('Pronomen: Er-Pronomen inkl. Possessiv-Formen', () => {
  const text = 'Er öffnete seinen Mantel. Sein Blick war leer.';
  const { pronoun_counts } = computePronounsAndDialog(text);
  assert.equal(pronoun_counts.er.narr, 3, 'Er + seinen + Sein');
});

test('computeStyleStats: leerer Text liefert Null-Metriken', () => {
  const stats = computeStyleStats('');
  assert.equal(stats.filler_count, 0);
  assert.equal(stats.passive_count, 0);
  assert.equal(stats.avg_sentence_len, null);
  assert.equal(stats.lix, null);
});

test('computeStyleStats: Füllwörter und Passiv-Formen', () => {
  const text = 'Eigentlich wurde die Tür geöffnet. Das ist natürlich sehr wichtig.';
  const stats = computeStyleStats(text);
  assert.ok(stats.filler_count >= 3, `erwartet ≥3 Füllwörter, gemessen ${stats.filler_count}`);
  assert.ok(stats.passive_count >= 1, `erwartet ≥1 Passiv (wurde), gemessen ${stats.passive_count}`);
});

test('computeStyleStats: Wiederholungs-Score klammert Eigennamen via extraStopwords aus', () => {
  const text = 'Anna ging. Anna sprach. Anna hörte.';
  const withoutFilter = computeStyleStats(text);
  const withFilter    = computeStyleStats(text, { extraStopwords: new Set(['anna']) });

  const repWith = JSON.parse(withFilter.repetition_data);
  const repWithout = JSON.parse(withoutFilter.repetition_data);
  // "anna" sollte in der gefilterten Top-Liste fehlen, in der ungefilterten vorhanden sein.
  assert.ok(repWithout.top.some(t => t.word === 'anna'));
  assert.ok(!repWith.top.some(t => t.word === 'anna'));
});

test('computeFigureMentions: Vollname-Match + Token-Match gewichtet', () => {
  const text = 'Anna Müller trat ein. Später kam Anna allein zurück.';
  const figures = [{ id: 1, name: 'Anna Müller', kurzname: 'Anna' }];
  const mentions = computeFigureMentions(text, figures);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].figure_id, 1);
  // Vollname (1.0) + 2× "Anna" (0.5 für Token-Match + 1.0 fürs kurzname-Vollname-Match)
  // Das genaue Gewicht muss nicht ein exakter Integer sein – wir erwarten ≥ 2.
  assert.ok(mentions[0].count >= 2, `count ≥ 2, gemessen ${mentions[0].count}`);
  assert.equal(mentions[0].first_offset, 0, 'erste Erwähnung am Textanfang');
});

test('computeFigureMentions: Token-Blocklist verhindert "Herr"-Matches', () => {
  // Vollname "Herr Müller" (1.0) + "Müller" Token (0.5) = 1.5 → round → 2.
  // "Herr" allein zählt nicht (Blocklist) – ohne Blocklist käme jedes "Herr"-Vorkommen mit dazu.
  const text = 'Herr Müller kam herein. Später tauchte noch ein anderer Herr auf.';
  const figures = [{ id: 1, name: 'Herr Müller', kurzname: null }];
  const mentions = computeFigureMentions(text, figures);
  assert.equal(mentions.length, 1);
  // Der zweite "Herr" (allein) darf NICHT mitgezählt werden.
  // Vollname(1) + Müller-Token(0.5) = 1.5 → round → 2.
  assert.equal(mentions[0].count, 2, 'Vollname + Müller-Token, aber kein freistehendes "Herr"');
});

test('tokenizeNamesForStopwords: strippt Namen in lowercase-Tokens, filtert Blocklist/Kurzwörter', () => {
  const tokens = tokenizeNamesForStopwords(['Anna Müller', 'Sankt-Gallen', 'Herr Dr. Schmidt']);
  assert.ok(tokens.has('anna'));
  assert.ok(tokens.has('müller'));
  assert.ok(tokens.has('sankt'));
  assert.ok(tokens.has('gallen'));
  assert.ok(tokens.has('schmidt'));
  assert.ok(!tokens.has('herr'), 'blocklist: herr ausgeschlossen');
  assert.ok(!tokens.has('dr'),   'zu kurz: dr ausgeschlossen');
});
