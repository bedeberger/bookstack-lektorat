// collapseSoftNewlines: rohe Zeilenumbrüche + Rand-Whitespace im Blockinneren
// einebnen, bevor der Fokusmodus sie unter `white-space: pre-wrap` sichtbar
// macht (Invariante 11c). Der harte Teil ist nicht das Ersetzen, sondern was
// NICHT ersetzt werden darf: `pre`/`.poem` (dort ist `\n` Struktur) und die
// Textknoten zwischen den Blöcken (dort rendert er nicht).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.document = document;
globalThis.NodeFilter = parseHTML('<!doctype html>').NodeFilter ?? {
  SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2,
};

const { collapseSoftNewlines } = await import('../../public/js/editor/focus/soft-newlines.js');

function mount(html) {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

test('\\n im Blockinneren wird zum Leerzeichen', () => {
  const root = mount('<p>Erste\nZweite\nDritte</p>');
  assert.equal(collapseSoftNewlines(root), true);
  assert.equal(root.querySelector('p').textContent, 'Erste Zweite Dritte');
});

test('\\n-Runs samt umgebender Spaces kollabieren auf EIN Leerzeichen', () => {
  const root = mount('<p>a  \n\n  b</p>');
  collapseSoftNewlines(root);
  assert.equal(root.querySelector('p').textContent, 'a b');
});

test('Blockränder werden getrimmt (sonst Einzug unter pre-wrap)', () => {
  const root = mount('<p>\n  Eingerueckter Text\n</p>');
  collapseSoftNewlines(root);
  assert.equal(root.querySelector('p').textContent, 'Eingerueckter Text');
});

// Der Restore der Undo-Historie ist der einzige Aufrufer mit `trimEdges: false`:
// er reproduziert eine Momentaufnahme des eigenen Editor-DOM und darf daran
// nichts saeubern (sonst frisst jedes Undo das eben getippte Leerzeichen am
// Blockende und der Caret klebt danach am letzten Wort).
test('trimEdges:false laesst das Leerzeichen am Blockende stehen', () => {
  const root = mount('<p>Satz. </p>');
  assert.equal(collapseSoftNewlines(root, { trimEdges: false }), false);
  assert.equal(root.querySelector('p').textContent, 'Satz. ');
});

test('trimEdges:false ebnet \\n trotzdem ein — nur die Raender bleiben', () => {
  const root = mount('<p>  a\nb  </p>');
  assert.equal(collapseSoftNewlines(root, { trimEdges: false }), true);
  assert.equal(root.querySelector('p').textContent, '  a b  ');
});

test('pre bleibt unangetastet — dort ist \\n Struktur', () => {
  const root = mount('<pre>zeile1\nzeile2</pre>');
  assert.equal(collapseSoftNewlines(root), false);
  assert.equal(root.querySelector('pre').textContent, 'zeile1\nzeile2');
});

test('.poem bleibt unangetastet — Verse leben von den Umbruechen', () => {
  const root = mount('<div class="poem"><p>Vers eins\nVers zwei</p></div>');
  assert.equal(collapseSoftNewlines(root), false);
  assert.equal(root.textContent, 'Vers eins\nVers zwei');
});

test('Whitespace ZWISCHEN den Bloecken bleibt stehen (rendert nicht, waere grundlose Aenderung)', () => {
  const root = mount('<p>a</p>\n<p>b</p>');
  assert.equal(collapseSoftNewlines(root), false);
  assert.equal(root.innerHTML, '<p>a</p>\n<p>b</p>');
});

test('Inline-Auszeichnung ueberlebt, \\n darin wird trotzdem eingeebnet', () => {
  const root = mount('<p>vor <strong>fett\nweiter</strong> nach</p>');
  collapseSoftNewlines(root);
  assert.equal(root.querySelector('p').textContent, 'vor fett weiter nach');
  assert.equal(root.querySelectorAll('strong').length, 1);
});

test('sauberer Text bleibt unveraendert und meldet false', () => {
  const html = '<p>Alles gut</p><h2>Titel</h2><li>Punkt</li>';
  const root = mount(html);
  assert.equal(collapseSoftNewlines(root), false);
  assert.equal(root.innerHTML, html);
});

test('idempotent — zweiter Lauf aendert nichts mehr', () => {
  const root = mount('<p>\n  a\n  b\n</p>');
  assert.equal(collapseSoftNewlines(root), true);
  const once = root.innerHTML;
  assert.equal(collapseSoftNewlines(root), false);
  assert.equal(root.innerHTML, once);
});

test('greift auch in Ueberschriften, Zitaten und Listenpunkten', () => {
  const root = mount('<h2>Ti\ntel</h2><blockquote><p>Zi\ntat</p></blockquote><ul><li>Pu\nnkt</li></ul>');
  collapseSoftNewlines(root);
  assert.equal(root.querySelector('h2').textContent, 'Ti tel');
  assert.equal(root.querySelector('blockquote p').textContent, 'Zi tat');
  assert.equal(root.querySelector('li').textContent, 'Pu nkt');
});

test('leerer Root / kein Root wirft nicht', () => {
  assert.equal(collapseSoftNewlines(null), false);
  assert.equal(collapseSoftNewlines(mount('')), false);
});
