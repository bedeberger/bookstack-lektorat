// Alpine.data('exportCard') — Sub-Komponente der Buch-Export-Karte.
// Fachlicher State lebt hier, `showExportCard` + `toggleExportCard` im Root.

import { exportMethods } from '../export.js';

export function registerExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('exportCard', () => ({
    bookExportLoading: null,
    bookExportError: '',

    _onBookChanged: null,
    _onViewReset: null,

    init() {
      this._onBookChanged = () => {
        this.bookExportLoading = null;
        this.bookExportError = '';
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => this._onBookChanged();
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset',  this._onViewReset);
    },

    ...exportMethods,
  }));
}
