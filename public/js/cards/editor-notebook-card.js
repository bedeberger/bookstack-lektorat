// Alpine.data('editorNotebookCard') — Sub-Komponente für den Normal-Editor
// (Notizbuch-Modus). Pendant zu editorFocusCard.
//
// Hostet die volle Edit-Pipeline (startEdit/saveEdit/cancelEdit/quickSave,
// Autosave, Draft, Conflict, Lock/Presence) und die Reload-Wiederaufnahme
// aus `normal.snapshot`. Root spreaded nur dünne Forwarder via
// [editor/notebook/trampoline.js] und greift hier über `window.__notebookCard`
// zu.

import { notebookCardMethods } from '../editor/notebook/card.js';
import { notebookEditMethods } from '../editor/notebook/edit.js';
import { notebookHistoryMethods } from '../editor/notebook/history.js';
import { formatMarksMethods } from '../editor/notebook/format-marks.js';

export function registerEditorNotebookCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorNotebookCard', () => ({
    _notebookRestoreSnapshot: null,
    // Undo/Redo: Session-scoped Stack (siehe editor/notebook/history.js).
    // Initial leer; `startEdit` ruft `_historyReset(initialHtml)`.
    _undoStack: [],
    _undoIdx: -1,
    _undoTimer: null,
    _undoApplying: false,
    // Steuerzeichen-Overlay (Soft-Break-Marken ↵): Listener-/Observer-Handles
    // (siehe editor/notebook/format-marks.js).
    _formatMarksRaf: null,
    _formatMarksRO: null,
    _formatMarksAbort: null,

    init() {
      // Globaler Selbst-Ref für die Root-Trampoline. Pendant zu __focusCard /
      // __app. Alpine bindet `this` automatisch beim Method-Aufruf, das
      // einfache Festhalten der reaktiven Sub-Instanz reicht.
      window.__notebookCard = this;
      this._setupNotebookRestore();
      this._setupNotebookDiagrams();
    },

    destroy() {
      if (window.__notebookCard === this) window.__notebookCard = null;
    },

    ...notebookCardMethods,
    ...notebookEditMethods,
    ...notebookHistoryMethods,
    ...formatMarksMethods,
  }));
}
