// Alpine.data('bookStatsCard') — Sub-Komponente der Buchstatistik-Karte.
//
// Chart.js-Instanz + Theme-Observer leben als Modul-State in bookstats.js —
// ein Alpine-Reaktivitäts-Proxy würde die Chart-Instanz beschädigen. destroy()
// räumt beide auf.

import { bookstatsMethods, _destroyStatsChart, _disconnectThemeObserver } from '../bookstats.js';

export function registerBookStatsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookStatsCard', () => ({
    bookStatsData: [],
    bookStatsLoading: false,
    bookStatsSyncStatus: '',
    bookStatsMetric: 'words',
    bookStatsRange: 0,
    bookStatsCoverage: null,
    bookStatsDelta: null,
    writingTimeData: null,

    _onBookChanged: null,
    _onViewReset: null,

    init() {
      // Öffnen: (Re-)Load der Daten.
      this.$watch(() => window.__app.showBookStatsCard, async (visible) => {
        if (!visible) return;
        if (!window.__app.selectedBookId) return;
        await this.loadBookStats(window.__app.selectedBookId);
      });

      this._onBookChanged = () => {
        if (!window.__app.showBookStatsCard) return;
        if (!window.__app.selectedBookId) return;
        // Bei Buchwechsel: State nullen + neu laden. `renderStatsChart` baut
        // das Chart ohnehin nach jedem Load frisch auf.
        this.bookStatsData = [];
        this.bookStatsCoverage = null;
        this.bookStatsDelta = null;
        this.writingTimeData = null;
        this.loadBookStats(window.__app.selectedBookId);
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => {
        this.bookStatsData = [];
        this.bookStatsSyncStatus = '';
        this.bookStatsCoverage = null;
        this.bookStatsDelta = null;
        this.writingTimeData = null;
        _destroyStatsChart();
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset',  this._onViewReset);
      _destroyStatsChart();
      _disconnectThemeObserver();
    },

    ...bookstatsMethods,
  }));
}
