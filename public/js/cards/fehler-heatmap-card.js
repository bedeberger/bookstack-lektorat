// Alpine.data('fehlerHeatmapCard') — Sub-Komponente der Fehler-Heatmap.
//
// Teil der Migration von Root-Methoden-Spreads zu echten Alpine.data-Komponenten
// (siehe CLAUDE.md und Refactoring-Plan).
//
// Scope-Regeln:
//   - Fachlicher State (fehlerHeatmapData, fehlerHeatmapLoading,
//     fehlerHeatmapStatus, fehlerHeatmapMode, activeFehlerDetailKey) lebt hier.
//   - `showFehlerHeatmapCard` und `toggleFehlerHeatmapCard` bleiben im Root.
//   - Root-State via this.$root (selectedBookId, uiLocale, pages, selectPage,
//     pageHistory, activeHistoryEntryId, loadHistoryEntry, t).
//   - Lifecycle-Events: `book:changed` + `view:reset` (siehe stil-card.js).

import { fehlerHeatmapMethods } from '../fehler-heatmap.js';

export function registerFehlerHeatmapCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('fehlerHeatmapCard', () => ({
    fehlerHeatmapData: null,
    fehlerHeatmapLoading: false,
    fehlerHeatmapStatus: '',
    fehlerHeatmapMode: 'all',
    activeFehlerDetailKey: null,

    _onBookChanged: null,
    _onViewReset: null,

    init() {
      // Bei Öffnen der Karte: Daten laden.
      this.$watch(() => this.$root.showFehlerHeatmapCard, async (visible) => {
        if (!visible) return;
        if (!this.$root.selectedBookId) return;
        await this.loadFehlerHeatmap();
      });

      // Buchwechsel bei offener Karte → Daten für neues Buch nachladen.
      this._onBookChanged = () => {
        if (!this.$root.showFehlerHeatmapCard) return;
        if (!this.$root.selectedBookId) return;
        this.loadFehlerHeatmap();
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => {
        this.fehlerHeatmapData = null;
        this.fehlerHeatmapStatus = '';
        this.fehlerHeatmapLoading = false;
        this.activeFehlerDetailKey = null;
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset',  this._onViewReset);
    },

    ...fehlerHeatmapMethods,
  }));
}
