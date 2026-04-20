'use strict';
// Unit-Tests für lib/ai.js – nur reine Logik (extractBalancedJson, parseJSON).
// Lauf: `node --test tests/unit/`

const test = require('node:test');
const assert = require('node:assert/strict');

// parseJSON schreibt bei Misserfolg in ai_parse_fails/. Damit Tests nichts anlegen,
// setzen wir SESSION_SECRET + eine dummy API-Key – lib/ai.js hängt daran nicht, nur
// Sub-Module, aber so bleibt das Setup identisch zum Prod-Boot.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { parseJSON } = require('../../lib/ai');

// extractBalancedJson ist nicht direkt exportiert – wir testen es indirekt
// über parseJSON mit Trailing-Content, das nur gematcht werden kann, wenn die
// balancierte Extraktion korrekt stackt.

test('parseJSON: direktes JSON', () => {
  assert.deepEqual(parseJSON('{"a":1}'), { a: 1 });
});

test('parseJSON: mit ```json Code-Fence', () => {
  assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
});

test('parseJSON: Trailing-Kommentar nach JSON', () => {
  // Das Modell hängt oft Erklärungen nach dem JSON an – balancedJson muss greifen.
  assert.deepEqual(
    parseJSON('{"a":1}\n\nDas war die Antwort.'),
    { a: 1 },
  );
});

test('parseJSON: trailing comma (via jsonrepair)', () => {
  assert.deepEqual(parseJSON('{"a":1,}'), { a: 1 });
});

test('parseJSON: verschachtelte Strukturen mit Trailing-Content', () => {
  const input = '{"fehler":[{"typ":"stil","text":"x"}]}\n\nHinweis: Ich habe geprüft.';
  assert.deepEqual(parseJSON(input), { fehler: [{ typ: 'stil', text: 'x' }] });
});

test('parseJSON: Strings mit Klammern stören nicht', () => {
  assert.deepEqual(
    parseJSON('{"a":"text mit { und [ innen","b":2}'),
    { a: 'text mit { und [ innen', b: 2 },
  );
});

test('parseJSON: escapete Quotes in Strings', () => {
  assert.deepEqual(
    parseJSON('{"a":"er sagte \\"hallo\\""}'),
    { a: 'er sagte "hallo"' },
  );
});

test('parseJSON: Typ-Mismatch `{"a":[}` wird nicht fälschlich aus Trailing-Mülltext erweitert', () => {
  // Früher zählte die Extraktion `{` und `[` in denselben depth-Counter; ein defekter
  // Input wie `{"a":[}` wurde "balanciert" erkannt und dann durch jsonrepair geflickt
  // – aber ein harmloses `{` im Nachtext hätte die Grenze verfälschen können.
  // Heute erkennt der Typ-sensitive Stack das als ungültig und fällt auf jsonrepair zurück.
  const result = parseJSON('{"a":[}');
  assert.deepEqual(result, { a: [] }); // jsonrepair-Fallback, nicht "balanciertes" Missverständnis
});

test('parseJSON: reiner Klartext → jsonrepair liefert String (dokumentiertes Verhalten)', () => {
  // Dokumentiert, dass die bestehende Fallback-Kette sehr permissiv ist.
  // Caller müssen anschliessend strukturell prüfen (z.B. `if (!Array.isArray(result.fehler))`).
  assert.equal(parseJSON('das ist kein JSON'), 'das ist kein JSON');
});
