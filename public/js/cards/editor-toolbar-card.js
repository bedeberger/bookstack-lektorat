// Alpine.data('editorToolbarCard') — Sub-Komponente für Bubble-Toolbar
// (Inline-Formate auf Selektion) und Slash-Menü (Block-Transforms).
//
// Eigener State: bubbleShow, bubbleX/Y, slashShow, slashX/Y, slashIdx,
//   _slashBlock, _slashLabels (Label-Cache), _slashFilterCache (Filter-Memo).
// Root behält: editMode, focusActive, _markEditDirty (→ $app / window.__app).
//
// Die Sub installiert globale Listener (selectionchange, scroll) und
// delegierte keydown/input-Listener auf das contenteditable, damit der Root
// keine Toolbar-spezifischen Handler mehr benötigt.

import { toolbarCardMethods } from '../editor/notebook/toolbar.js';

export function registerEditorToolbarCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorToolbarCard', () => ({
    bubbleShow: false,
    bubbleSingleWord: false,
    bubbleX: 0,
    bubbleY: 0,
    slashShow: false,
    slashX: 0,
    slashY: 0,
    slashIdx: 0,
    slashQuery: '',
    _slashBlock: null,
    _slashLabels: null,
    _slashFilterCache: null,
    linkShow: false,
    linkX: 0,
    linkY: 0,
    linkUrl: '',
    linkCanRemove: false,
    _linkRange: null,
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
      // closest() auf Normal- bzw. Focus-Container, damit wir nur im Edit-
      // Bereich reagieren. Beide Container haben getrennte Klassen
      // (entkoppelt), Selektor matcht beide.
      document.addEventListener('keydown', (e) => {
        const target = e.target;
        if (!target?.closest?.('.page-content-view--editing, .focus-editor__content')) return;
        this._onEditKeydown(e);
      }, { signal });

      // Checkbox-Toggle in todo-Listen: contenteditable schluckt den nativen
      // Toggle. Attribut (nicht nur Property) setzen, damit Serialisierung
      // den State persistiert.
      document.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || t.tagName !== 'INPUT' || t.type !== 'checkbox') return;
        if (!t.closest('.page-content-view--editing ul.todo, .focus-editor__content ul.todo')) return;
        if (t.hasAttribute('checked')) t.removeAttribute('checked');
        else t.setAttribute('checked', '');
        window.__app?._markEditDirty?.();
      }, { signal });

      // <hr> ist ein void-Element ohne Caret-Slot — per Klick als
      // ".hr-selected" markieren, damit Backspace/Delete (in
      // toolbarCardMethods._onEditKeydown) es entfernen kann. Nur im
      // Notebook-Edit-Container; Klick irgendwo sonst hebt die Markierung auf.
      document.addEventListener('click', (e) => {
        const editEl = e.target?.closest?.('.page-content-view--editing');
        editEl?.querySelectorAll('hr.hr-selected').forEach((h) => {
          if (h !== e.target) h.classList.remove('hr-selected');
        });
        if (editEl && e.target.tagName === 'HR') e.target.classList.toggle('hr-selected');
      }, { signal });

      // Void-<hr> hat keinen Caret-Slot: geht eine Text-Selektion über eine <hr>
      // hinweg, rendert der Browser den Caret schräg zwischen Linie und
      // Folgeabsatz. Solange die Selektion eine <hr> berührt, denselben
      // caret-color-Guard wie beim Klick setzen (siehe page-view.css). Klasse am
      // Edit-Container; kollabierte Selektion wird nicht behandelt (dort greift
      // die hr-selected-Klick-Logik).
      document.addEventListener('selectionchange', () => {
        // Ohne Edit-Session nichts zu tun: der Handler liefe sonst bei JEDER
        // Selektionsänderung der App (Chat, Suche, Findings) mit DOM-Scan mit.
        // Die Klasse wirkt nur im `--editing`-Scope, ein Rest im Lesemodus ist
        // wirkungslos und wird beim nächsten Edit-Selektionswechsel geräumt.
        if (!window.__app?.editMode) return;
        document.querySelectorAll('.page-content-view--editing.hr-in-selection')
          .forEach((el) => el.classList.remove('hr-in-selection'));
        const sel = document.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        const anchor = range.commonAncestorContainer;
        const editEl = (anchor.nodeType === 1 ? anchor : anchor.parentElement)
          ?.closest?.('.page-content-view--editing');
        if (!editEl) return;
        const touchesHr = Array.from(editEl.querySelectorAll('hr'))
          .some((hr) => range.intersectsNode(hr));
        if (touchesHr) editEl.classList.add('hr-in-selection');
      }, { signal });
    },

    destroy() {
      this._toolbarAbort?.abort();
    },

    ...toolbarCardMethods,
  }));
}
