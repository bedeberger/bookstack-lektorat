// Geteilter Find-Kern (public/js/editor/shared/text-find.js) — Match-Suche
// über Text-Node-Grenzen hinweg, Offset-Rückmapping, Ganzwort-Regel.
// Konsumenten: Notebook-Finder (editor/find.js, ein Root) und Bucheditor-
// Finder (cards/book-editor/find.js, N Block-Roots).
//
// DOM aus linkedom: `createTreeWalker` reicht für den Kern. `rangeOf` und die
// Highlight-Factory brauchen echte Range-/CSS-Highlight-APIs (linkedom hat
// keine) — die deckt die E2E-Ebene im Browser ab.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<body></body>');
globalThis.document = document;
globalThis.NodeFilter = { SHOW_TEXT: 4 };

const { collectMatches, collectTextNodes } = await import('../../public/js/editor/shared/text-find.js');

// Baut einen Root aus HTML und liefert zusätzlich den konkatenierten Text,
// damit die Erwartungen als Offsets im Gesamttext lesbar bleiben.
function root(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

// Ein Match auf seinen tatsächlichen Text zurückauflösen (ohne Range-API):
// gültig, solange Start und Ende im selben Text-Node liegen.
function textOf(match) {
  assert.equal(match.startNode, match.endNode, 'Helper deckt nur Single-Node-Matches ab');
  return match.startNode.nodeValue.slice(match.startOffset, match.endOffset);
}

test('collectTextNodes: alle Text-Nodes in Dokumentreihenfolge', () => {
  const nodes = collectTextNodes(root('<p>Ein <b>Haus</b> steht</p><p>hier</p>'));
  assert.deepEqual(nodes.map(n => n.nodeValue), ['Ein ', 'Haus', ' steht', 'hier']);
});

test('collectMatches: leerer Term oder fehlender Root → keine Treffer', () => {
  assert.deepEqual(collectMatches(root('<p>Haus</p>'), ''), []);
  assert.deepEqual(collectMatches(null, 'Haus'), []);
});

test('collectMatches: case-insensitive per Default, case-sensitive auf Wunsch', () => {
  const el = root('<p>Haus haus HAUS</p>');
  assert.equal(collectMatches(el, 'haus').length, 3);
  assert.equal(collectMatches(el, 'haus', { caseSensitive: true }).length, 1);
  assert.equal(textOf(collectMatches(el, 'haus', { caseSensitive: true })[0]), 'haus');
});

test('collectMatches: Offsets zeigen auf den richtigen Text-Node', () => {
  const el = root('<p>Ein Haus</p><p>und ein Haus</p>');
  const [a, b] = collectMatches(el, 'Haus');
  assert.equal(textOf(a), 'Haus');
  assert.equal(a.startNode.nodeValue, 'Ein Haus');
  assert.equal(a.startOffset, 4);
  assert.equal(textOf(b), 'Haus');
  assert.equal(b.startNode.nodeValue, 'und ein Haus');
  assert.equal(b.startOffset, 8);
});

test('collectMatches: Treffer über Text-Node-Grenze hinweg (Inline-Markup)', () => {
  // «Haustür» steht im DOM als «Haus» + «tür» — der konkatenierte Stream findet
  // es trotzdem, Start und Ende landen in verschiedenen Nodes.
  //
  // Grenz-Semantik: liegt der Start-Offset exakt auf einer Node-Grenze, gewinnt
  // der FRÜHERE Node mit Offset == seiner Länge. Das ist dieselbe Position im
  // Dokument (Range.setStart akzeptiert offset === length) — nur eben nicht die
  // naheliegende Schreibweise. Beide Editoren mappen so; hier festgenagelt,
  // damit ein „Aufräumen" der Bedingung nicht unbemerkt die Ranges verschiebt.
  const el = root('<p>Die <b>Haus</b>tür</p>');
  const [m] = collectMatches(el, 'Haustür');
  assert.equal(m.startNode.nodeValue, 'Die ');
  assert.equal(m.startOffset, 4);
  assert.equal(m.startOffset, m.startNode.nodeValue.length, 'Position == Ende des früheren Nodes');
  assert.equal(m.endNode.nodeValue, 'tür');
  assert.equal(m.endOffset, 3);
});

test('collectMatches: wholeWord ignoriert Treffer mitten im Wort', () => {
  const el = root('<p>Haus Hausboot behaust</p>');
  assert.equal(collectMatches(el, 'Haus').length, 3);
  const whole = collectMatches(el, 'Haus', { wholeWord: true });
  assert.equal(whole.length, 1);
  assert.equal(whole[0].startOffset, 0);
});

test('collectMatches: wholeWord zählt Bindestrich und Apostroph als Wortzeichen', () => {
  // Eine Regel für beide Editoren (vorher: Notebook mit -/', Bucheditor ohne).
  // «Haus» ist damit in «Haus-Tür» KEIN Ganzwort-Treffer.
  assert.equal(collectMatches(root('<p>Haus-Tür</p>'), 'Haus', { wholeWord: true }).length, 0);
  assert.equal(collectMatches(root("<p>wir's</p>"), 'wir', { wholeWord: true }).length, 0);
  assert.equal(collectMatches(root('<p>Haus_2</p>'), 'Haus', { wholeWord: true }).length, 0);
  assert.equal(collectMatches(root('<p>(Haus)</p>'), 'Haus', { wholeWord: true }).length, 1);
});

test('collectMatches: überlappende Treffer werden nicht doppelt gezählt', () => {
  // «aa» in «aaaa» → 2 Treffer (0-2, 2-4), nicht 3.
  assert.equal(collectMatches(root('<p>aaaa</p>'), 'aa').length, 2);
});

test('collectMatches: Treffer am Textende terminiert die Schleife', () => {
  const el = root('<p>Ende</p>');
  const m = collectMatches(el, 'Ende');
  assert.equal(m.length, 1);
  assert.equal(m[0].endOffset, 4);
});
