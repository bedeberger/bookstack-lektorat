// Alpine.data('ideenCard') — Sub-Komponente für Seiten-Ideen.
// Lebt parallel zum Editor wie der Seiten-Chat (kein _closeOtherMainCards).
// Eigener State; Root behält showIdeenCard, currentPage, selectedBookId, t.

import { ideenMethods } from '../ideen.js';

export function registerIdeenCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('ideenCard', () => ({
    ideen: [],
    newContent: '',
    editingId: null,
    editingDraft: '',
    movingId: null,
    moveTargetId: '',
    loading: false,
    busy: false,
    errorMessage: '',

    _onBookChanged: null,
    _onViewReset: null,
    _onIdeenReset: null,

    init() {
      // Beim Öffnen + Page-Wechsel laden.
      this.$watch(() => window.__app.showIdeenCard, async (visible) => {
        if (!visible) return;
        await this.loadIdeen();
      });
      this.$watch(() => window.__app.currentPage?.id, async (pid) => {
        if (!pid) { this.resetIdeen(); return; }
        if (window.__app.showIdeenCard) await this.loadIdeen();
      });

      // Move-Picker neben aktive Idee verschieben (DOM-Move, weil Combobox
      // in x-for nicht sauber initialisiert — daher Single-Panel ausserhalb).
      this.$watch('movingId', (id) => {
        const panel = this.$el.querySelector('.idee-move-panel');
        if (!panel) return;
        if (id === null) {
          const list = this.$el.querySelector('.ideen-list');
          if (list && panel.nextSibling !== list) this.$el.insertBefore(panel, list);
          return;
        }
        const item = this.$el.querySelector(`[data-idee-id="${id}"]`);
        if (item && item.parentNode) item.parentNode.insertBefore(panel, item.nextSibling);
      });

      this._onIdeenReset = () => this.resetIdeen();
      window.addEventListener('ideen:reset', this._onIdeenReset);

      this._onBookChanged = () => this.resetIdeen();
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => this.resetIdeen();
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onIdeenReset)  window.removeEventListener('ideen:reset', this._onIdeenReset);
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset', this._onViewReset);
    },

    ...ideenMethods,
  }));
}
