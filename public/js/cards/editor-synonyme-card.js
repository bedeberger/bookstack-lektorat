// Alpine.data('editorSynonymeCard') — Sub-Komponente für das Synonym-
// Kontextmenü und den Picker (Rechtsklick auf Wort im Edit-Mode).
//
// Eigener State: showSynonymMenu, synonymMenuX/Y, showSynonymPicker,
//   synonymThesList/Loading/Error/Disabled, synonymKiList/Loading/Error,
//   _synonymRange, _synonymWord, _synonymPollTimer, _synonymScrollHandler,
//   _synonymJobId.
// Root behält: `_onEditContextMenu` (Trigger am contenteditable extrahiert
//   Range+Word und dispatcht `editor:synonym:open {range, word, x, y}`),
//   Trampoline `closeSynonymMenu/closeSynonymPicker` und `requestSynonyms`
//   dispatchen an die Sub. `_startPoll` bleibt Root-Utility.

import { synonymCardMethods } from '../editor-synonyme.js';

export function registerEditorSynonymeCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorSynonymeCard', () => ({
    showSynonymMenu: false,
    synonymMenuX: 0,
    synonymMenuY: 0,
    showSynonymPicker: false,
    synonymThesList: [],
    synonymThesLoading: false,
    synonymThesError: '',
    synonymThesDisabled: false,
    synonymKiList: [],
    synonymKiLoading: false,
    synonymKiError: '',
    _synonymRange: null,
    _synonymWord: '',
    _synonymPollTimer: null,
    _synonymScrollHandler: null,
    _synonymJobId: null,

    _onOpen: null,
    _onCloseMenu: null,
    _onClosePicker: null,
    _onRequest: null,

    init() {
      this._onOpen = (e) => this._openSynonymMenu(e.detail || {});
      this._onCloseMenu   = () => this.closeSynonymMenu();
      this._onClosePicker = () => this.closeSynonymPicker();
      this._onRequest     = () => this.requestSynonyms();
      window.addEventListener('editor:synonym:open',         this._onOpen);
      window.addEventListener('editor:synonym:close-menu',   this._onCloseMenu);
      window.addEventListener('editor:synonym:close-picker', this._onClosePicker);
      window.addEventListener('editor:synonym:request',      this._onRequest);
    },

    destroy() {
      if (this._synonymPollTimer) { clearInterval(this._synonymPollTimer); this._synonymPollTimer = null; }
      this._detachSynonymScroll();
      if (this._onOpen)         window.removeEventListener('editor:synonym:open',         this._onOpen);
      if (this._onCloseMenu)    window.removeEventListener('editor:synonym:close-menu',   this._onCloseMenu);
      if (this._onClosePicker)  window.removeEventListener('editor:synonym:close-picker', this._onClosePicker);
      if (this._onRequest)      window.removeEventListener('editor:synonym:request',      this._onRequest);
    },

    ...synonymCardMethods,
  }));
}
