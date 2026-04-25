// Alpine.data('editorFindCard') — Sub-Komponente für Find & Replace im Edit-Mode.
//
// Eigener State: findOpen, findTerm, findReplace, findCaseSensitive,
//   findWholeWord, findMatches, findIndex, findX, findY, _findRecomputeTimer,
//   _findReflowHandler.
// Root behält: editMode, focusMode, selectedBookId, setStatus(), t(),
//   _markEditDirty(). Zugriff via window.__app / $app.

import { editorFindCardMethods } from '../editor-find.js';

export function registerEditorFindCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorFindCard', () => ({
    findOpen: false,
    findTerm: '',
    findReplace: '',
    findCaseSensitive: false,
    findWholeWord: false,
    findMatches: [],
    findIndex: -1,
    findX: 0,
    findY: 0,
    _findRecomputeTimer: null,
    _findReflowHandler: null,
    _onFindHotkey: null,

    init() {
      // Ctrl/Cmd+F: im Edit-Mode Finder öffnen, sonst BookStack-Suche fokussieren.
      // Bewusst im Sub statt auf dem Body-Keydown: hält die Logik beim Feature.
      this._onFindHotkey = (event) => {
        const isFind = (event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'f' || event.key === 'F');
        if (!isFind) return;
        const app = window.__app;
        if (!app) return;
        if (app.editMode && !app.focusMode) {
          event.preventDefault();
          this.openFind();
        } else if (app.selectedBookId) {
          event.preventDefault();
          const input = document.querySelector('.bookstack-search-input');
          if (input) { input.focus(); input.select?.(); }
        }
      };
      window.addEventListener('keydown', this._onFindHotkey);

      // Find-Widget muss bei Buchwechsel/View-Reset geschlossen werden, sonst
      // bleibt der capture-phase Scroll-Listener am Window kleben (per Sub-
      // mount akkumuliert).
      this._onBookChanged = () => this.closeFind?.();
      this._onViewReset = () => this.closeFind?.();
      window.addEventListener('book:changed', this._onBookChanged);
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._findRecomputeTimer) { clearTimeout(this._findRecomputeTimer); this._findRecomputeTimer = null; }
      if (this._findReflowHandler) {
        window.removeEventListener('resize', this._findReflowHandler);
        window.removeEventListener('scroll', this._findReflowHandler, true);
        this._findReflowHandler = null;
      }
      if (this._onFindHotkey) {
        window.removeEventListener('keydown', this._onFindHotkey);
        this._onFindHotkey = null;
      }
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset',  this._onViewReset);
    },

    ...editorFindCardMethods,
  }));
}
