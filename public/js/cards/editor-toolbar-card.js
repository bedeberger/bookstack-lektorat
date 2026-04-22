// Alpine.data('editorToolbarCard') — Sub-Komponente für Bubble-Toolbar
// (Inline-Formate auf Selektion) und Slash-Menü (Block-Transforms).
//
// Eigener State: bubbleShow, bubbleX/Y, slashShow, slashX/Y, slashIdx,
//   _slashBlock.
// Root behält: editMode, focusMode, _markEditDirty (→ $app / window.__app).
//
// Die Sub installiert globale Listener (selectionchange, scroll) und
// delegierte keydown/input-Listener auf das contenteditable, damit der Root
// keine Toolbar-spezifischen Handler mehr benötigt.

import { toolbarCardMethods } from '../editor-toolbar.js';

export function registerEditorToolbarCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorToolbarCard', () => ({
    bubbleShow: false,
    bubbleX: 0,
    bubbleY: 0,
    slashShow: false,
    slashX: 0,
    slashY: 0,
    slashIdx: 0,
    _slashBlock: null,
    _toolbarAbort: null,

    init() {
      const abort = new AbortController();
      this._toolbarAbort = abort;
      const signal = abort.signal;

      document.addEventListener('selectionchange', () => this._updateBubble(), { signal });
      // Capture-Phase, damit auch Scroll-Events in internen Containern
      // (editor-preview-wrap) mitbekommen werden.
      window.addEventListener('scroll', () => {
        if (this.bubbleShow) this._updateBubble();
        if (this.slashShow) this._updateSlashPosition();
      }, { capture: true, signal });

      // Delegierter Keydown-Listener auf dem contenteditable — filtert per
      // closest() nach `.page-content-view--editing`, damit wir nur im
      // Edit-Bereich reagieren.
      document.addEventListener('keydown', (e) => {
        const target = e.target;
        if (!target?.closest?.('.page-content-view--editing')) return;
        this._onEditKeydown(e);
      }, { signal });
    },

    destroy() {
      this._toolbarAbort?.abort();
    },

    ...toolbarCardMethods,
  }));
}
