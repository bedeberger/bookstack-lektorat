// Unit-Tests für public/js/editor/notebook/history.js — die KARTEN-GLUE um den
// geteilten Undo/Redo-Kern.
//
// Stack-Mechanik (Dedupe, Deckel, Redo-Ast, Debounce, `inputType`-Vertrag) liegt
// im Kern und wird in edit-history.test.mjs geprüft. Hier steht nur, was die
// Notebook-Karte beiträgt: Container-Lookup, die Mount-Pipeline
// (`mountEditorHtml` → Block-Normalisierung + Caret-Slot), Dirty-Flag +
// Draft/Autosave und das `editMode`-Gate.
//
// Tests greifen direkt auf `notebookHistoryMethods` zu, mocken `_getEditEl`,
// `_scheduleDraftSave`, `_scheduleAutosave` + `window.__app`.
// Test-Fixtures setzen `innerHTML` mit statischen, im Test-Source eingebetteten
// HTML-Literalen — keine externen Daten, kein XSS-Risiko.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body><div id="ed" contenteditable="true"><p>start</p></div></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.NodeFilter = window.NodeFilter || { SHOW_TEXT: 4 };

const { notebookHistoryMethods } = await import('../../public/js/editor/notebook/history.js');

function makeCtx() {
  const el = window.document.getElementById('ed');
  el.innerHTML = '<p>start</p>'; // Reset zwischen Tests (shared DOM)
  const app = { editMode: true, focusActive: false, editDirty: false };
  window.__app = app;
  const ctx = {
    // Spiegel des Karten-States (cards/editor-notebook-card.js): Instanz
    // entsteht beim ersten Zugriff.
    _editHistory: null,
    _getEditEl: () => el,
    _scheduleDraftSave: () => { ctx._draftCalls++; },
    _scheduleAutosave: () => { ctx._autosaveCalls++; },
    _draftCalls: 0,
    _autosaveCalls: 0,
    ...notebookHistoryMethods,
  };
  return { ctx, el, app };
}

function setHtml(el, html) { el.innerHTML = html; }

test('_historyReset legt Baseline — Undo/Redo noch nicht möglich', () => {
  const { ctx } = makeCtx();
  ctx._historyReset('<p>a</p>');
  assert.equal(ctx.notebookCanUndo(), false);
  assert.equal(ctx.notebookCanRedo(), false);
});

test('Push + Undo/Redo laufen über die Karten-Methoden', () => {
  const { ctx, el } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  ctx._historyPushNow();
  assert.equal(ctx.notebookCanUndo(), true);
  ctx.notebookUndo();
  assert.equal(el.innerHTML, '<p>start</p>');
  assert.equal(ctx.notebookCanRedo(), true);
  ctx.notebookRedo();
  assert.equal(el.innerHTML, '<p>v2</p>');
});

test('Restore markiert dirty + ruft Draft+Autosave', () => {
  const { ctx, el, app } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  ctx._historyPushNow();
  app.editDirty = false;
  ctx.notebookUndo();
  assert.equal(app.editDirty, true);
  assert.ok(ctx._draftCalls > 0);
  assert.ok(ctx._autosaveCalls > 0);
});

test('Undo no-op bei !editMode', () => {
  const { ctx, el, app } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  ctx._historyPushNow();
  app.editMode = false;
  ctx.notebookUndo();
  assert.equal(el.innerHTML, '<p>v2</p>', 'kein Restore wenn editMode off');
});

test('Undo wirkt AUCH bei focusActive — der Fokusmodus fährt auf dieser Historie', () => {
  // Der Fokusmodus ist in der SPA kein eigener Editor, sondern derselbe
  // Edit-Vorgang auf einem gespiegelten Container: `_getEditEl` löst dorthin
  // auf und `@input="_markEditDirty()"` schiebt die Snapshots schon hier herein.
  // Ein Gate auf `!focusActive` liess den Stack zwar volllaufen, machte ihn im
  // Fokusmodus aber unbenutzbar — dort griff dann der browsereigene Undo-Stack,
  // der unter WebKit eine ganze Tippstrecke als EINEN Schritt führt.
  const { ctx, el, app } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  ctx._historyPushNow();
  app.focusActive = true;
  ctx.notebookUndo();
  assert.equal(el.innerHTML, '<p>start</p>');
  app.focusActive = true;
  ctx.notebookRedo();
  assert.equal(el.innerHTML, '<p>v2</p>');
});

test('Undo normalisiert orphan-Text-Snapshot in <p> (Block-Konsistenz)', () => {
  // Reproduziert den Korruptions-Fall: ein Snapshot fängt einen transienten
  // contenteditable-Stand ohne <p>-Wrapper ein (z.B. nach Select-all+Tippen).
  // Restore muss den Block normalisieren statt orphan-Text zu reinstanzieren —
  // das leistet die injizierte Mount-Pipeline, nicht der Kern.
  const { ctx, el } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, 'orphan ohne block');
  ctx._historyPushNow();
  setHtml(el, '<p>danach</p>');
  ctx._historyPushNow();
  ctx.notebookUndo();
  assert.equal(el.innerHTML, '<p>orphan ohne block</p>', 'orphan-Text in <p> gewrapt');
});

test('Restore ergänzt Caret-Slot <br> in leerem trailing <p>', () => {
  const { ctx, el } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>text</p><p></p>');
  ctx._historyPushNow();
  setHtml(el, '<p>weiter</p>');
  ctx._historyPushNow();
  ctx.notebookUndo();
  assert.equal(el.innerHTML, '<p>text</p><p><br></p>', 'leerer trailing <p> bekommt Caret-Slot');
});

test('_historyClear beendet die Session-Historie', () => {
  const { ctx, el } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  ctx._historyPushNow();
  ctx._historyClear();
  assert.equal(ctx.notebookCanUndo(), false);
  assert.equal(ctx.notebookCanRedo(), false);
});

test('Karten-Methoden funktionieren ohne vorherigen Reset (Instanz entsteht lazy)', () => {
  const { ctx, el } = makeCtx();
  assert.equal(ctx.notebookCanUndo(), false);
  setHtml(el, '<p>v2</p>');
  assert.doesNotThrow(() => ctx._historyPushSoon());
  assert.doesNotThrow(() => ctx.notebookUndo());
});
