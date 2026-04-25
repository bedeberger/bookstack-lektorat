// Alpine.data('editorFigurLookupCard') — Sub-Komponente für das Figuren-Popover
// (Ctrl/Cmd-Klick auf Figurname im Edit-/Fokusmodus).
//
// Eigener State: showFigurLookup, figurLookupX, figurLookupY, figurLookupData,
//   _figurLookupScrollHandler, _figurLookupAnchor.
// Root behält: Lookup-Index + `_tryOpenFigurLookupAt` (synchroner Hit-Test für
//   Synonym-Kontextmenü). Root dispatcht `editor:figur-lookup:open { fig, x, y }`
//   und `editor:figur-lookup:close`; diese Sub hört darauf.

import { figurLookupCardMethods } from '../editor-figur-lookup.js';

export function registerEditorFigurLookupCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorFigurLookupCard', () => ({
    showFigurLookup: false,
    figurLookupX: 0,
    figurLookupY: 0,
    figurLookupData: null,
    _figurLookupScrollHandler: null,
    _figurLookupAnchor: null,

    _onOpen: null,
    _onClose: null,

    init() {
      this._onOpen = (e) => {
        const { fig, x, y } = e.detail || {};
        if (!fig) return;
        this._openFigurLookup(fig, x, y);
      };
      this._onClose = () => this.closeFigurLookup();
      window.addEventListener('editor:figur-lookup:open', this._onOpen);
      window.addEventListener('editor:figur-lookup:close', this._onClose);

      // Bei Buchwechsel/View-Reset Popover hart schliessen — sonst bleibt der
      // capture-phase Scroll-Listener nach Buchwechsel-Wegnavigation am Window.
      this._onBookChanged = () => this.closeFigurLookup?.();
      this._onViewReset   = () => this.closeFigurLookup?.();
      window.addEventListener('book:changed', this._onBookChanged);
      window.addEventListener('view:reset',  this._onViewReset);
    },

    destroy() {
      if (this._onOpen)  window.removeEventListener('editor:figur-lookup:open',  this._onOpen);
      if (this._onClose) window.removeEventListener('editor:figur-lookup:close', this._onClose);
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset',  this._onViewReset);
      this._detachFigurLookupScroll();
    },

    ...figurLookupCardMethods,
  }));
}
