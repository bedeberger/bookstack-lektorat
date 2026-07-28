// Unit-Tests fuer public/js/editor/shared/todo-html.js — das Setzen des
// `checked`-ATTRIBUTS am n-ten Todo-Kasten des Seiten-HTML.
//
// Warum diese Schicht: der Haken muss als Attribut im serialisierten HTML
// landen, nicht nur als DOM-Property. Nur das ueberlebt den Weg in die
// Persistenz; wer `box.checked` setzt, sieht den Haken und speichert ihn nie.
// Ausserdem muss die Index-Zuordnung Leseansicht -> gespeichertes HTML halten,
// auch wenn die Ansicht Inline-Marks (Lektorat/Chat/Mentions) eingezogen hat.
//
// Assertions gehen ueber einen Re-Parse des Outputs, nicht ueber Regex auf die
// Attribut-Schreibweise: `checked=""` vs. `checked` ist Serializer-Detail
// (Chromium vs. linkedom), das `hasAttribute` beider Welten gleich beantwortet.
//
// Setup analog tests/unit/paste-sanitize.test.mjs: linkedom als DOM, DOMParser
// gestubt (linkedoms eigener wickelt 'text/html'-Fragmente nicht in <body>).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;

class StubDOMParser {
  parseFromString(html, _type) {
    return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
  }
}
globalThis.DOMParser = StubDOMParser;

const { setTodoCheckedAt, todoBoxIndex, TODO_BOX_SEL } =
  await import('../../public/js/editor/shared/todo-html.js');

// Markup-SSoT: editor/notebook/toolbar/slash.js
const item = (txt, checked = false) =>
  `<li class="todo-item"><input type="checkbox"${checked ? ' checked=""' : ''}><span class="todo-text">${txt}</span></li>`;
const list = (...items) => `<ul class="todo">${items.join('')}</ul>`;

// Haken-Zustand aller Todo-Kaesten aus serialisiertem HTML zurueckgelesen.
function checkedFlags(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return [...el.querySelectorAll(TODO_BOX_SEL)].map(b => b.hasAttribute('checked'));
}

test('setzt checked als ATTRIBUT (ueberlebt Serialisierung)', () => {
  assert.deepEqual(checkedFlags(setTodoCheckedAt(list(item('Eins')), 0, true)), [true]);
});

test('entfernt checked wieder', () => {
  const out = setTodoCheckedAt(list(item('Eins', true)), 0, false);
  assert.deepEqual(checkedFlags(out), [false]);
  assert.doesNotMatch(out, /checked/);
});

test('trifft genau den n-ten Kasten, Nachbarn bleiben unberuehrt', () => {
  const out = setTodoCheckedAt(list(item('Eins'), item('Zwei'), item('Drei')), 1, true);
  assert.deepEqual(checkedFlags(out), [false, true, false]);
});

test('zaehlt ueber mehrere Todo-Listen hinweg durch', () => {
  const html = `${list(item('A'))}<p>Prosa</p>${list(item('B'), item('C'))}`;
  assert.deepEqual(checkedFlags(setTodoCheckedAt(html, 2, true)), [false, false, true]);
});

test('Checkboxen ausserhalb einer Todo-Liste zaehlen nicht mit', () => {
  const html = `<p><input type="checkbox" id="loose"></p>${list(item('Eins'))}`;
  const out = setTodoCheckedAt(html, 0, true);
  // Index 0 ist der Todo-Kasten, nicht der lose <p>-Input.
  assert.deepEqual(checkedFlags(out), [true]);
  const el = document.createElement('div');
  el.innerHTML = out;
  assert.equal(el.querySelector('#loose').hasAttribute('checked'), false);
});

test('idempotent: zweimal setzen aendert nichts mehr', () => {
  const once = setTodoCheckedAt(list(item('Eins')), 0, true);
  assert.equal(setTodoCheckedAt(once, 0, true), once);
});

test('Prosa, Block-IDs und Marks um die Liste bleiben erhalten', () => {
  const html = `<p data-bid="a1">Text mit <mark class="lektorat-mark">Fund</mark></p>${list(item('Eins'))}`;
  const out = setTodoCheckedAt(html, 0, true);
  assert.match(out, /data-bid="a1"/);
  assert.match(out, /class="lektorat-mark"/);
  assert.match(out, /Text mit/);
});

test('nicht vorhandener Index -> null (kein fremder Haken wird verschoben)', () => {
  assert.equal(setTodoCheckedAt(list(item('Eins')), 3, true), null);
  assert.equal(setTodoCheckedAt(list(item('Eins')), -1, true), null);
  assert.equal(setTodoCheckedAt(list(item('Eins')), 1.5, true), null);
});

test('leeres / falsches HTML -> null', () => {
  assert.equal(setTodoCheckedAt('', 0, true), null);
  assert.equal(setTodoCheckedAt(null, 0, true), null);
  assert.equal(setTodoCheckedAt(undefined, 0, true), null);
});

test('todoBoxIndex: Live-DOM-Index passt zum HTML-Index', () => {
  const view = document.createElement('div');
  view.innerHTML = `${list(item('A'))}<p>x</p>${list(item('B'), item('C'))}`;
  const boxes = [...view.querySelectorAll(TODO_BOX_SEL)];
  assert.equal(boxes.length, 3);
  assert.equal(todoBoxIndex(view, boxes[2]), 2);
});

test('todoBoxIndex: Fremdknoten -> -1', () => {
  const view = document.createElement('div');
  view.innerHTML = `${list(item('A'))}<p><input type="checkbox" id="loose"></p>`;
  assert.equal(todoBoxIndex(view, view.querySelector('#loose')), -1);
  assert.equal(todoBoxIndex(view, null), -1);
  assert.equal(todoBoxIndex(null, view.querySelector(TODO_BOX_SEL)), -1);
});
