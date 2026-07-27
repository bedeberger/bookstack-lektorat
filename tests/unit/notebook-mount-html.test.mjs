// Unit-Tests für die geteilte Einhänge-Pipeline (public/js/editor/shared/
// mount-html.js) und die Layout-Prefs (public/js/editor/notebook/storage.js).
//
// `mountEditorHtml` ist SSoT für alle drei Pfade, die den Editor-Inhalt komplett
// ersetzen: startEdit, Undo/Redo-Restore, Spiegeln eines gemergten Stands.
// Vorher hatte jeder Pfad seine eigene (unterschiedlich vollständige) Kopie —
// der Undo-Restore kannte den trailing-`<hr>`-Fall nicht und liess den User ohne
// Schreib-Anker zurück.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, DOMParser } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = DOMParser;

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const { mountEditorHtml, ensureCaretSlot } = await import('../../public/js/editor/shared/mount-html.js');
const { readEditorPrefs, writeEditorPrefs, ZOOM_MIN, ZOOM_MAX } = await import('../../public/js/editor/notebook/storage.js');

const el = () => window.document.createElement('div');

// ── mountEditorHtml ─────────────────────────────────────────────────────────

test('mountEditorHtml: leeres HTML → Platzhalter-Absatz mit Caret-Slot', () => {
  const c = el();
  mountEditorHtml(c, '');
  assert.equal(c.innerHTML, '<p><br></p>', 'ohne Block landet der erste Tastendruck als orphan Textnode');
});

test('mountEditorHtml: kindloses <p> am Ende bekommt <br> (zero-height sonst)', () => {
  const c = el();
  mountEditorHtml(c, '<p>Text</p><p></p>');
  assert.equal(c.lastElementChild.innerHTML, '<br>');
});

test('mountEditorHtml: trailing <hr> bekommt Folge-Absatz als Schreib-Anker', () => {
  const c = el();
  mountEditorHtml(c, '<p>Text</p><hr>');
  assert.equal(c.lastElementChild.tagName, 'P', 'void-<hr> nimmt keinen Caret — Absatz dahinter nötig');
  assert.equal(c.lastElementChild.innerHTML, '<br>');
});

test('mountEditorHtml: orphan Text-Run wird gewrappt und als repariert gemeldet', () => {
  const c = el();
  const { repaired } = mountEditorHtml(c, 'nackter Text<p>Block</p>');
  assert.equal(repaired, true, 'Aufrufer muss die Reparatur persistieren können');
  assert.match(c.innerHTML, /^<p>nackter Text<\/p>/);
});

test('mountEditorHtml: sauberes HTML meldet keine Reparatur', () => {
  const c = el();
  const { repaired } = mountEditorHtml(c, '<p>a</p><p>b</p>');
  assert.equal(repaired, false, 'sonst wäre jede Edit-Session sofort dirty');
});

test('mountEditorHtml: idempotent (zweiter Lauf ändert nichts)', () => {
  const c = el();
  mountEditorHtml(c, '<p>Text</p><hr>');
  const once = c.innerHTML;
  const { repaired } = mountEditorHtml(c, once);
  assert.equal(c.innerHTML, once);
  assert.equal(repaired, false);
});

test('ensureCaretSlot: leerer Container bleibt unangetastet', () => {
  const c = el();
  ensureCaretSlot(c);
  assert.equal(c.innerHTML, '');
});

// ── Layout-Prefs inkl. Zoom ─────────────────────────────────────────────────

test('Prefs: Defaults ohne gespeicherten Eintrag', () => {
  store.clear();
  assert.deepEqual(readEditorPrefs(), { fullscreen: false, fitWidth: false, showMarks: false, zoom: 1 });
});

test('Prefs: Zoom wird persistiert (Editor öffnet in gewählter Schriftgrösse)', () => {
  store.clear();
  writeEditorPrefs({ fullscreen: true, fitWidth: false, showMarks: true, zoom: 1.4 });
  assert.deepEqual(readEditorPrefs(), { fullscreen: true, fitWidth: false, showMarks: true, zoom: 1.4 });
});

test('Prefs: Zoom wird auf den Slider-Bereich geklemmt', () => {
  store.clear();
  writeEditorPrefs({ zoom: 99 });
  assert.equal(readEditorPrefs().zoom, ZOOM_MAX);
  writeEditorPrefs({ zoom: 0.01 });
  assert.equal(readEditorPrefs().zoom, ZOOM_MIN);
});

test('Prefs: kaputter/fremder Wert fällt auf Zoom 1 zurück', () => {
  store.clear();
  store.set('notebook.editorPrefs', '{"zoom":"gross"}');
  assert.equal(readEditorPrefs().zoom, 1);
  store.set('notebook.editorPrefs', 'kein json');
  assert.equal(readEditorPrefs().zoom, 1);
});
