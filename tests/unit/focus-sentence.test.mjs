// Unit-Tests für Sentence-/Mark-Helpers des Focus-Editors
// (public/js/editor/focus/sentence.js + dom-blocks.js):
//   - `findSentenceAtCaret` — TreeWalker-basierte Satz-Erkennung am Caret.
//   - `clearAllFocusMarks` — räumt active-/near-Klassen + leeres class-Attribut
//     ab (Letzteres verhindert eine Phantom-Revision beim nächsten Save).
//
// linkedom liefert createTreeWalker; die Selection ist ein Minimal-Fake mit
// startContainer/startOffset (linkedom-Range kennt kein setStart). Test-HTML
// sind statische Literale.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body><div id="ed"></div></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.NodeFilter = window.NodeFilter || { SHOW_TEXT: 4 };

const {
  findSentenceAtCaret, clearAllFocusMarks, blockMarksIntact, repairBlockMarks,
} = await import('../../public/js/editor/focus.js');

function blockWith(html) {
  const ed = window.document.getElementById('ed');
  ed.innerHTML = html;
  return ed.querySelector('p');
}
function caretSel(node, offset) {
  return { rangeCount: 1, getRangeAt: () => ({ startContainer: node, startOffset: offset }) };
}

// --- findSentenceAtCaret ----------------------------------------------------

test('findSentenceAtCaret: Caret im ersten Satz → erste Range', () => {
  const block = blockWith('<p>Hallo Welt. Zweiter Satz hier.</p>');
  const info = findSentenceAtCaret(block, caretSel(block.firstChild, 3));
  assert.deepEqual(info.sentence, [0, 12]);
  assert.equal(info.totalLength, 30);
});

test('findSentenceAtCaret: Caret im zweiten Satz → zweite Range', () => {
  const block = blockWith('<p>Hallo Welt. Zweiter Satz hier.</p>');
  const info = findSentenceAtCaret(block, caretSel(block.firstChild, 20));
  assert.deepEqual(info.sentence, [12, 30]);
});

test('findSentenceAtCaret: kein Block / keine Selektion → null', () => {
  assert.equal(findSentenceAtCaret(null, caretSel(window.document.body, 0)), null);
  const block = blockWith('<p>Text.</p>');
  assert.equal(findSentenceAtCaret(block, { rangeCount: 0, getRangeAt: () => null }), null);
});

test('findSentenceAtCaret: Caret ausserhalb des Blocks → null', () => {
  const block = blockWith('<p>Drin.</p>');
  const aussen = window.document.body; // nicht im Block enthalten
  assert.equal(findSentenceAtCaret(block, caretSel(aussen, 0)), null);
});

test('findSentenceAtCaret: leerer Block → ganze (Null-)Länge als Range', () => {
  const block = blockWith('<p></p>');
  const info = findSentenceAtCaret(block, caretSel(block, 0));
  assert.deepEqual(info.sentence, [0, 0]);
  assert.equal(info.totalLength, 0);
});

test('findSentenceAtCaret: Element-Container (Caret nach <br>) zählt Kindknoten, nicht Zeichen', () => {
  // Chromium setzt den Caret nach einem <br>, in einem frisch geleerten Absatz
  // und direkt nach einem Merge auf das ELEMENT; `startOffset` ist dann ein
  // Kindknoten-Index. Ungefiltert fand die Textknoten-Suche den Container nie
  // und fiel auf 0 zurück → aktiv war der erste Satz, obwohl der Caret im
  // zweiten steht (Spotlight sprang beim Löschen an den Absatzanfang).
  const block = blockWith('<p>Erster Satz. <br>Zweiter Satz.</p>');
  // childNodes: [text "Erster Satz. ", br, text "Zweiter Satz."] → Offset 2 =
  // vor dem zweiten Textknoten, also Zeichenposition 13.
  const info = findSentenceAtCaret(block, caretSel(block, 2));
  assert.deepEqual(info.sentence, [13, 26]);
});

test('findSentenceAtCaret: Element-Container hinter allen Kindern → letzter Satz', () => {
  const block = blockWith('<p>Eins. Zwei.</p>');
  const info = findSentenceAtCaret(block, caretSel(block, block.childNodes.length));
  assert.deepEqual(info.sentence, [6, 11]);
});

test('findSentenceAtCaret: verschachtelter Element-Container zählt Text davor mit', () => {
  const block = blockWith('<p>Eins. <em>Zwei drei.</em></p>');
  const em = block.querySelector('em');
  // Caret vor dem Textknoten in <em> → Zeichenposition 6 (nach "Eins. ").
  const info = findSentenceAtCaret(block, caretSel(em, 0));
  assert.deepEqual(info.sentence, [6, 16]);
});

// --- blockMarksIntact / repairBlockMarks ------------------------------------

test('blockMarksIntact: genau ein Aktiv-Mark auf dem Soll-Block → intakt', () => {
  const ed = window.document.getElementById('ed');
  ed.innerHTML = '<p class="focus-paragraph-active">a</p><p>b</p>';
  const [a] = ed.querySelectorAll('p');
  assert.equal(blockMarksIntact(ed, a, 'paragraph'), true);
});

test('blockMarksIntact: Merge hat den markierten Block weggerissen → kaputt', () => {
  // Backspace am Absatzanfang: Chromium merged zwei <p>, der markierte fliegt
  // aus dem DOM. Danach trägt KEIN Element mehr die Klasse und die Dim-Regel
  // greift für den ganzen Text.
  const ed = window.document.getElementById('ed');
  ed.innerHTML = '<p>ab</p>';
  const [a] = ed.querySelectorAll('p');
  assert.equal(blockMarksIntact(ed, a, 'paragraph'), false);
});

test('blockMarksIntact: Ghost-Mark auf zweitem Absatz (Split) → kaputt', () => {
  const ed = window.document.getElementById('ed');
  ed.innerHTML = '<p class="focus-paragraph-active">a</p><p class="focus-paragraph-active">b</p>';
  const [a] = ed.querySelectorAll('p');
  assert.equal(blockMarksIntact(ed, a, 'paragraph'), false);
});

test('blockMarksIntact: typewriter-only will gar keinen Mark', () => {
  const ed = window.document.getElementById('ed');
  ed.innerHTML = '<p>a</p>';
  const [a] = ed.querySelectorAll('p');
  assert.equal(blockMarksIntact(ed, a, 'typewriter-only'), true);
  a.classList.add('focus-paragraph-active');
  assert.equal(blockMarksIntact(ed, a, 'typewriter-only'), false);
});

test('blockMarksIntact: block=null → intakt (reguläres Tick entscheidet)', () => {
  const ed = window.document.getElementById('ed');
  ed.innerHTML = '<p class="focus-paragraph-active">a</p>';
  assert.equal(blockMarksIntact(ed, null, 'paragraph'), true);
});

test('repairBlockMarks: mutiert nur im kaputten Zustand', () => {
  const ed = window.document.getElementById('ed');
  ed.innerHTML = '<p>a</p><p>b</p>';
  const [a, b] = ed.querySelectorAll('p');

  assert.equal(repairBlockMarks(ed, a, 'paragraph'), true, 'kein Mark vorhanden → Repair');
  assert.equal(a.classList.contains('focus-paragraph-active'), true);

  assert.equal(repairBlockMarks(ed, a, 'paragraph'), false, 'intakt → kein zweiter Eingriff');

  b.classList.add('focus-paragraph-active');   // Ghost (Split-Bug)
  assert.equal(repairBlockMarks(ed, a, 'paragraph'), true);
  assert.equal(ed.querySelectorAll('.focus-paragraph-active').length, 1);
  assert.equal(b.hasAttribute('class'), false, 'leeres class-Attribut muss weg');
});

// --- clearAllFocusMarks -----------------------------------------------------

test('clearAllFocusMarks: entfernt active + near und leeres class-Attribut', () => {
  const ed = window.document.getElementById('ed');
  ed.innerHTML = '<p class="focus-paragraph-active">a</p><p class="focus-paragraph-near">b</p>';
  clearAllFocusMarks(ed);
  for (const p of ed.querySelectorAll('p')) {
    assert.equal(p.classList.contains('focus-paragraph-active'), false);
    assert.equal(p.classList.contains('focus-paragraph-near'), false);
    assert.equal(p.hasAttribute('class'), false, 'leeres class-Attribut muss weg (sonst Save-Diff)');
  }
});

test('clearAllFocusMarks: erhält fremde Klassen', () => {
  const ed = window.document.getElementById('ed');
  ed.innerHTML = '<p class="poem focus-paragraph-active">a</p>';
  clearAllFocusMarks(ed);
  const p = ed.querySelector('p');
  assert.equal(p.classList.contains('poem'), true);
  assert.equal(p.classList.contains('focus-paragraph-active'), false);
});

test('clearAllFocusMarks: null-Container → kein Wurf', () => {
  assert.doesNotThrow(() => clearAllFocusMarks(null));
});
