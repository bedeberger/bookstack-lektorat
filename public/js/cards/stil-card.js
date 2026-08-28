// Alpine.data('stilCard') — Sub-Komponente der Stil-Heatmap.

import { stilMethods } from '../book/stil-heatmap.js';
import { stilRhythmusMethods } from '../book/stil-rhythmus.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerStilCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('stilCard', () => ({
    stilData: null,
    stilLoading: false,
    stilSyncing: false,
    stilStatus: '',
    // Aufgeklappte Zelle: `<chapterKey>:<metricKey>`. Die Beispielsätze dazu
    // liegen NICHT im Kapitel-Raster, sondern werden pro Zelle nachgeladen
    // (/history/style-samples) — sie sind der grösste Posten der Rohdaten und
    // werden immer nur für genau eine Zelle gebraucht.
    activeStilDetailKey: null,
    stilDetail: null,
    stilDetailLoading: false,
    // Re-Entry-Guard für den Drilldown-Fetch: bei schnellen Klicks darf nur die
    // zuletzt geöffnete Zelle ihr Ergebnis setzen.
    _stilDetailSeq: 0,
    // Speicher des _memo-Helpers aus stil-heatmap.js (die render-fertigen Zeilen
    // werden im Template pro Render mehrfach abgefragt).
    _memos: {},
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showStilCard',
        load: async (root) => {
          await this.loadStilStats(Alpine.store('nav').selectedBookId);
          if (this._stilNeedsSync()) await this.runStilSync();
        },
        onBookChanged: (e, ctx, root) => {
          if (!root.showStilCard) return;
          const bookId = e.detail?.bookId || Alpine.store('nav').selectedBookId;
          if (bookId) ctx.loadStilStats(bookId);
        },
        resetStateView: {
          stilData: null,
          stilStatus: '',
          stilLoading: false,
          stilSyncing: false,
          activeStilDetailKey: null,
          stilDetail: null,
          stilDetailLoading: false,
          _memos: {},
        },
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...stilMethods,
    ...stilRhythmusMethods,
  }));
}
