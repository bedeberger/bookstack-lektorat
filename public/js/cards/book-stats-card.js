// Alpine.data('bookStatsCard') — Sub-Komponente der Buchstatistik-Karte.
//
// Teil der Migration von Root-Methoden-Spreads zu echten Alpine.data-Komponenten
// (siehe CLAUDE.md und Refactoring-Plan).
//
// Scope-Regeln:
//   - Fachlicher State (bookStatsData, bookStatsLoading, bookStatsSyncStatus,
//     bookStatsMetric, bookStatsRange, bookStatsCoverage, bookStatsDelta,
//     writingTimeData) lebt hier.
//   - `showBookStatsCard` + `toggleBookStatsCard` bleiben im Root.
//   - Root-State via window.__app (selectedBookId, uiLocale, pages, tokEsts, t).
//   - Chart.js-Instanz + Theme-Observer leben als Modul-State in bookstats.js
//     (siehe _statsChart, _themeObserver dort) — Alpine-Reaktivitäts-Proxy
//     würde die Chart-Instanz beschädigen. destroy() räumt beide auf.
//   - Writing-Time-Heartbeat (editMode/focusMode-Tracking) lebt weiter im
//     Root (writingTimeMethods), weil der Heartbeat auf editMode+focusMode
//     reagiert — Editor-State ist Root-nah und die Karte braucht NICHT offen
//     zu sein, damit Schreibzeit erfasst wird.

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
