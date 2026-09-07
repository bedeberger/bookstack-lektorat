// TOC-Einträge brechen um statt zu kürzen: zu breite Titel werden greedy auf
// die Spaltenbreite gewickelt, Fortsetzungszeilen beginnen an derselben
// x-Position. Testet den reinen Wrap-Helper mit einem Stub-Doc, dessen
// widthOfString proportional zur Zeichenzahl misst (1 Zeichen = 10 pt).

import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

process.env.DB_PATH = path.join('/tmp', `pdf-toc-wrap-${process.pid}-${Date.now()}.db`);
await import('../../db/schema.js');
const { _wrapTocLines } = await import('../../lib/pdf-render/pages.js');

// Monospace-Stub: jede Position 10 pt breit.
const doc = { widthOfString: (s) => String(s).length * 10 };

test('kurzer Titel bleibt eine Zeile', () => {
  assert.deepEqual(_wrapTocLines(doc, 'Kapitel 1', 1000), ['Kapitel 1']);
});

test('zu breiter Titel wird an Wortgrenzen umgebrochen', () => {
  // maxW=100 → 10 Zeichen pro Zeile. "Ein langer Titel" (16) → 2 Zeilen.
  const lines = _wrapTocLines(doc, 'Ein langer Titel', 100);
  assert.deepEqual(lines, ['Ein langer', 'Titel']);
  for (const ln of lines) assert.ok(doc.widthOfString(ln) <= 100);
});

test('greedy: jede Zeile wird so voll wie möglich', () => {
  // 10 Zeichen/Zeile: "aaaa bbbb" passt genau, "cccc" rutscht in Zeile 2.
  const lines = _wrapTocLines(doc, 'aaaa bbbb cccc dddd', 100);
  assert.deepEqual(lines, ['aaaa bbbb', 'cccc dddd']);
});

test('Überbreites Einzelwort wird hart nach Zeichen getrennt', () => {
  const lines = _wrapTocLines(doc, 'Donaudampfschifffahrt', 100);
  assert.ok(lines.length >= 3, `erwartet ≥3 Zeilen, war ${JSON.stringify(lines)}`);
  assert.equal(lines.join(''), 'Donaudampfschifffahrt'); // kein Zeichen verloren
  for (const ln of lines) assert.ok(doc.widthOfString(ln) <= 100);
});

test('mehrere Leerzeichen zwischen Wörtern kollabieren nicht zu Leerzeilen', () => {
  const lines = _wrapTocLines(doc, 'eins   zwei', 1000);
  assert.deepEqual(lines, ['eins   zwei']); // passt in eine Zeile → unverändert
  const wrapped = _wrapTocLines(doc, 'aaa  bbb  ccc  ddd', 80);
  for (const ln of wrapped) assert.ok(!/^\s|\s$/.test(ln), `Zeile mit Rand-Whitespace: "${ln}"`);
});

test('maxW <= 0 liefert den Titel als eine Zeile (kein Crash, kein Verlust)', () => {
  assert.deepEqual(_wrapTocLines(doc, 'egal', 0), ['egal']);
  assert.deepEqual(_wrapTocLines(doc, 'egal', -5), ['egal']);
});

test('nullish/leerer Titel liefert genau eine (leere) Zeile', () => {
  assert.deepEqual(_wrapTocLines(doc, null, 100), ['']);
  assert.deepEqual(_wrapTocLines(doc, undefined, 100), ['']);
  assert.deepEqual(_wrapTocLines(doc, '   ', 100), ['']);
});
