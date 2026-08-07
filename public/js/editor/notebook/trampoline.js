// Root-Trampoline für den Notebook-Editor. Pendant zu editor/focus/trampoline.js.
//
// Spread in den Root (`notebookTrampoline` in [app.js]). Methoden sind dünne
// Forwarder auf die Sub-Komponente `editorNotebookCard`, die ihren Selbst-Ref
// in `init()` an `window.__notebookCard` legt. Templates (`@click="startEdit()"`)
// und externe Module (`app.quickSave()`, `app._markEditDirty()`) treffen weiter
// die Root-API, die echte Logik lebt aber in [notebook/edit.js].
//
// `this`-Binding: Forwarder rufen die Sub-Methode via `card.X(...args)`, sodass
// `this` innerhalb der Sub korrekt der Sub-Proxy ist (Alpine bindet automatisch).

import { EVT } from '../../events.js';

const card = () => window.__notebookCard;

export const notebookTrampoline = {
  // Public — Templates & cross-card-Aufrufer
  startEdit() { card()?.startEdit(); },
  cancelEdit() { return card()?.cancelEdit(); },
  saveEdit() { return card()?.saveEdit(); },
  quickSave() { return card()?.quickSave(); },
  insertHorizontalRule() { card()?.insertHorizontalRule(); },
  togglePageEditorFullscreen() { card()?.togglePageEditorFullscreen(); },
  togglePageEditorFitWidth() { card()?.togglePageEditorFitWidth(); },
  togglePageEditorShowMarks() { card()?.togglePageEditorShowMarks(); },
  togglePageEditorShowHead() { card()?.togglePageEditorShowHead(); },
  pageEditorZoomIn() { card()?.pageEditorZoomIn(); },
  pageEditorZoomOut() { card()?.pageEditorZoomOut(); },
  pageEditorZoomReset() { card()?.pageEditorZoomReset(); },
  normalizeQuotes() { return card()?.normalizeQuotes(); },
  // Beleg-Picker (Quellenverzeichnis) am Caret öffnen. Einziger Forwarder hier,
  // der NICHT auf `editorNotebookCard` zeigt: der Picker liegt in
  // `editorToolbarCard`, die keinen Selbst-Ref auslegt — darum per Event
  // (Muster: editor/focus/trampoline.js).
  openCitePicker() { window.dispatchEvent(new CustomEvent(EVT.EDITOR_CITE_OPEN)); },
  notebookUndo() { card()?.notebookUndo(); },
  notebookRedo() { card()?.notebookRedo(); },
  notebookCanUndo() { return !!card()?.notebookCanUndo(); },
  notebookCanRedo() { return !!card()?.notebookCanRedo(); },
  // Banner rendert im Root-Scope, bevor die Sub gemountet ist → '' statt undefined.
  editConflictBannerText() { return card()?.editConflictBannerText() ?? ''; },

  // Half-public — von Templates/anderen Modulen (synonyme, find, focus, toolbar,
  // app-view, book-editor-card) erwartet.
  _onEditPaste(e) { card()?._onEditPaste(e); },
  _onEditCopy(e) { card()?._onEditCopy(e); },
  _onEditCut(e) { card()?._onEditCut(e); },
  _markEditDirty() { card()?._markEditDirty(); },
  _flushDraftSaveNow() { card()?._flushDraftSaveNow(); },
  _stopAutosave() { card()?._stopAutosave(); },
  _uninstallOnlineRetry() { card()?._uninstallOnlineRetry(); },
  // Seitenwechsel / Karten-Schliessen (app-view/page.js#resetPage): dieselbe
  // Abbau-Sequenz wie cancelEdit, aber mit Draft-Erhalt — ohne diesen Aufruf
  // liefen Edit-Lock-Heartbeat und Presence-Ping der verlassenen Seite weiter.
  _teardownEditSession(opts) { card()?._teardownEditSession(opts); },
  _filterFindingsAfterSave(html) { card()?._filterFindingsAfterSave(html); },
  _checkPageConflict(pageId, expectedUpdatedAt) {
    return card()?._checkPageConflict(pageId, expectedUpdatedAt) ?? null;
  },
  _getEditEl() { return card()?._getEditEl() ?? null; },
  _scrollEditCaretIntoView(rect) { card()?._scrollEditCaretIntoView(rect); },
};
