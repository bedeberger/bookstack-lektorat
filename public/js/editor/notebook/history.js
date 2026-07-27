// Notebook-Editor Undo/Redo-Stack — pro Edit-Session, pro Seite.
//
// Session-scoped: `startEdit` initialisiert mit Baseline-Snapshot;
// `saveEdit` (Non-Focus) und `cancelEdit` clearen den Stack komplett.
// Snapshots werden debounced (HISTORY_DEBOUNCE_MS) bei `_markEditDirty`
// geschoben — sodass eine Folge von Tasten als ein Schritt erscheint.
//
// Caret-Restore über Text-Offset (Tree-Walker, SHOW_TEXT). Über
// strukturelle Mutationen (Slash-Menu, HR-Insert) hinweg robust genug.
//
// Browser-eigener Undo-Stack wird absichtlich bypassed: er kollabiert,
// sobald wir `innerHTML` oder `replaceChild` aufrufen (Slash, HR, Paste-
// Cleaner). Eigener Stack ist dort konsistent.
//
// XSS: Snapshots stammen ausschliesslich aus `editEl.innerHTML` — Inhalt,
// der zuvor durch die Paste-Cleaner-Kette (`cleanContentArtefacts`) und
// `stripLektoratMarks` gelaufen ist. Kein externer/user-fremder String
// landet hier.

import { mountEditorHtml } from '../shared/mount-html.js';
import { editorHost } from '../shared/editor-host.js';

const HISTORY_DEBOUNCE_MS = 500;
const HISTORY_MAX = 100;

function captureCaretOffset(root) {
  const sel = root.ownerDocument?.defaultView?.getSelection?.()
    ?? (typeof document !== 'undefined' ? document.getSelection?.() : null);
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function restoreCaretAtOffset(root, offset) {
  if (offset == null) return;
  const doc = root.ownerDocument;
  if (!doc?.createTreeWalker || !doc?.createRange) return;
  try {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let target = null;
    let targetOffset = 0;
    let n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (remaining <= len) {
        target = n;
        targetOffset = remaining;
        break;
      }
      remaining -= len;
    }
    const range = doc.createRange();
    if (typeof range.setStart !== 'function') return;
    if (target) {
      range.setStart(target, targetOffset);
    } else {
      range.selectNodeContents(root);
      range.collapse(false);
    }
    range.collapse(true);
    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    const sel = win?.getSelection?.()
      ?? (typeof document !== 'undefined' ? document.getSelection?.() : null);
    if (sel?.removeAllRanges && sel?.addRange) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch {
    // Caret-Restore ist Best-Effort — bei Edge-Cases (Tree-Walker-Limits,
    // disconnected Nodes) lieber kein Caret als crash.
  }
}

export const notebookHistoryMethods = {
  _historyReset(html) {
    if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
    this._undoStack = [{ html: html ?? '', caretOffset: 0 }];
    this._undoIdx = 0;
    this._undoApplying = false;
  },

  _historyClear() {
    if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
    this._undoStack = [];
    this._undoIdx = -1;
    this._undoApplying = false;
  },

  _historyPushSoon() {
    if (this._undoApplying) return;
    if (this._undoTimer) clearTimeout(this._undoTimer);
    this._undoTimer = setTimeout(() => {
      this._undoTimer = null;
      this._historyPushNow();
    }, HISTORY_DEBOUNCE_MS);
  },

  _historyPushNow() {
    if (this._undoApplying) return;
    if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
    const el = this._getEditEl?.();
    if (!el) return;
    if (!Array.isArray(this._undoStack)) this._undoStack = [];
    const html = el.innerHTML;
    const top = this._undoStack[this._undoIdx];
    if (top && top.html === html) return;
    if (this._undoIdx < this._undoStack.length - 1) {
      this._undoStack.length = this._undoIdx + 1;
    }
    const caretOffset = captureCaretOffset(el);
    this._undoStack.push({ html, caretOffset });
    if (this._undoStack.length > HISTORY_MAX) {
      const drop = this._undoStack.length - HISTORY_MAX;
      this._undoStack.splice(0, drop);
    }
    this._undoIdx = this._undoStack.length - 1;
  },

  notebookCanUndo() {
    return Array.isArray(this._undoStack) && this._undoIdx > 0;
  },

  notebookCanRedo() {
    return Array.isArray(this._undoStack) && this._undoIdx < this._undoStack.length - 1;
  },

  notebookUndo() {
    const app = editorHost();
    if (!app?.editMode || app.focusActive) return;
    if (this._undoApplying) return;
    if (this._undoTimer) {
      clearTimeout(this._undoTimer);
      this._undoTimer = null;
      this._historyPushNow();
    }
    if (this._undoIdx <= 0) return;
    this._undoIdx--;
    this._historyRestore(this._undoStack[this._undoIdx]);
  },

  notebookRedo() {
    const app = editorHost();
    if (!app?.editMode || app.focusActive) return;
    if (this._undoApplying) return;
    if (this._undoIdx >= this._undoStack.length - 1) return;
    this._undoIdx++;
    this._historyRestore(this._undoStack[this._undoIdx]);
  },

  _historyRestore(snap) {
    const el = this._getEditEl?.();
    if (!el || !snap) return;
    this._undoApplying = true;
    try {
      // Block-Konsistenz wahren: ein Snapshot kann einen transienten
      // contenteditable-Zwischenstand eingefangen haben (orphan Text-/Inline-
      // Runs direkt unter dem Editor-Root, leerer <p> ohne Caret-Slot, trailing
      // <hr>). Ohne Re-Normalisierung reproduziert das Restore den Defekt.
      // `mountEditorHtml` ist dieselbe Pipeline, die startEdit nutzt — Text-
      // Offsets bleiben gültig (Wrapping ändert keine Textinhalte, <br>/<p>
      // sind kein Text), darum Caret-Restore danach.
      mountEditorHtml(el, snap.html || '');
      restoreCaretAtOffset(el, snap.caretOffset);
      el.focus?.();
      const app = editorHost();
      if (app) {
        app.editDirty = true;
        this._scheduleDraftSave?.();
        this._scheduleAutosave?.();
      }
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    } finally {
      this._undoApplying = false;
    }
  },
};
