// Alpine.data('stilCard') — Sub-Komponente der Stil-Heatmap.
//
// Teil der Migration von Root-Methoden-Spreads zu echten Alpine.data-Komponenten
// (siehe CLAUDE.md und Refactoring-Plan).
//
// Scope-Regeln:
//   - Fachlicher State (stilData, stilLoading, stilSyncing, stilStatus,
//     activeStilDetailKey) lebt hier, NICHT mehr im Root.
//   - `showStilCard` und `toggleStilCard` bleiben im Root — Hash-Router und
//     Karten-Exklusivität brauchen die Flag als Single Source of Truth.
//   - Zugriff auf Root-State via this.$root (selectedBookId, uiLocale, pages,
//     selectPage, t).
//   - Lifecycle-Events: `book:changed` (Sub-Komponente lädt neu, wenn sichtbar)
//     und `view:reset` (lokalen State nullen). Werden vom Root dispatcht.
//   - `$watch($root.showStilCard)` triggert beim Öffnen den First-Load.

import { stilMethods } from '../stil-heatmap.js';

export function registerStilCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('stilCard', () => ({
    stilData: null,
    stilLoading: false,
    stilSyncing: false,
    stilStatus: '',
    activeStilDetailKey: null,

    _onBookChanged: null,
    _onViewReset: null,

    init() {
      // Bei Öffnen der Karte: erstmals laden, bei Bedarf Auto-Sync starten.
      this.$watch(() => this.$root.showStilCard, async (visible) => {
        if (!visible) return;
        if (!this.$root.selectedBookId) return;
        await this.loadStilStats(this.$root.selectedBookId);
        if (this._stilNeedsSync()) await this.runStilSync();
      });

      // Buchwechsel bei offener Karte → Daten für neues Buch nachladen.
      this._onBookChanged = (e) => {
        if (!this.$root.showStilCard) return;
        const bookId = e.detail?.bookId || this.$root.selectedBookId;
        if (bookId) this.loadStilStats(bookId);
      };
      window.addEventListener('book:changed', this._onBookChanged);

      // Globaler Reset (z.B. Klick auf Site-Title, Buchwahl-Combobox-Wechsel).
      this._onViewReset = () => {
        this.stilData = null;
        this.stilStatus = '';
        this.stilLoading = false;
        this.stilSyncing = false;
        this.activeStilDetailKey = null;
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset',  this._onViewReset);
    },

    ...stilMethods,
  }));
}
