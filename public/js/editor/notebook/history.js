// Notebook-Editor Undo/Redo — Glue um den geteilten Kern
// (shared/edit-history.js). Hier steht nur, was Alpine-/Karten-spezifisch ist:
// Container-Lookup (`_getEditEl`), Mount-Pipeline, Dirty-Flag + Draft/Autosave.
// Stack, Debounce, Deckel, Caret-Offset und der `inputType`-Vertrag liegen im
// Kern und werden mit der Standalone-Schale des Fokusmodus geteilt.
//
// Session-scoped, pro Seite: `startEdit` initialisiert mit Baseline-Snapshot,
// `cancelEdit`/`saveEdit` (Non-Focus) clearen den Stack komplett.
//
// GILT FÜR BEIDE MODI DERSELBEN EDIT-SESSION. Der Fokusmodus ist in der SPA
// kein eigener Editor, sondern derselbe Edit-Vorgang auf einem gespiegelten
// Container (focus/mirror.js) — `_getEditEl` löst über
// shared/active-editor.js ohnehin auf den Fokus-Container auf, und
// `@input="_markEditDirty()"` am Fokus-Container schiebt seine Snapshots schon
// heute hier herein. Ein zweiter Stack für den Fokusmodus wäre also eine zweite
// Wahrheit über denselben Inhalt; stattdessen läuft die Historie durch den
// Modus-Wechsel hindurch. Eine eigene Instanz hat nur die fremde Schale
// (focus/standalone.js) — die ist eine eigene Session ohne Alpine.

import { createEditHistory } from '../shared/edit-history.js';
import { mountEditorHtml } from '../shared/mount-html.js';
import { editorHost } from '../shared/editor-host.js';

export const notebookHistoryMethods = {
  // Instanz liegt als `_editHistory` im Karten-State (Initial `null` in
  // cards/editor-notebook-card.js) und wird beim ersten Zugriff erzeugt —
  // `startEdit` ist über `_historyReset` immer der erste Aufrufer.
  _historyEnsure() {
    if (this._editHistory) return this._editHistory;
    this._editHistory = createEditHistory({
      getRoot: () => this._getEditEl?.() ?? null,
      // Dieselbe Pipeline wie `startEdit`: ein Snapshot kann einen transienten
      // contenteditable-Zwischenstand eingefangen haben (orphan Text-/Inline-
      // Runs direkt unter dem Editor-Root, leerer <p> ohne Caret-Slot, trailing
      // <hr>). Ohne Re-Normalisierung reproduziert das Restore den Defekt.
      // Text-Offsets bleiben gültig (Wrapping ändert keine Textinhalte).
      mountHtml: (el, html) => { mountEditorHtml(el, html); },
      // Draft + Autosave laufen weiter — ein Undo ist eine Änderung wie jede
      // andere und soll persistiert werden.
      onRestored: () => {
        const app = editorHost();
        if (!app) return;
        app.editDirty = true;
        this._scheduleDraftSave?.();
        this._scheduleAutosave?.();
      },
    });
    return this._editHistory;
  },

  _historyReset(html) { this._historyEnsure().reset(html); },
  _historyClear() { this._historyEnsure().clear(); },
  _historyPushSoon() { this._historyEnsure().pushSoon(); },
  _historyPushNow() { this._historyEnsure().pushNow(); },

  notebookCanUndo() { return this._historyEnsure().canUndo(); },
  notebookCanRedo() { return this._historyEnsure().canRedo(); },

  // Kein `focusActive`-Gate: der Fokusmodus fährt bewusst auf dieser Historie
  // (siehe Modulkopf). Der Edit-Modus bleibt Vorbedingung — ohne offene Session
  // gibt es keinen Container, in den restored werden könnte.
  notebookUndo() {
    if (!editorHost()?.editMode) return;
    this._historyEnsure().undo();
  },

  notebookRedo() {
    if (!editorHost()?.editMode) return;
    this._historyEnsure().redo();
  },
};
