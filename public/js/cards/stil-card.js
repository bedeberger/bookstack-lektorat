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
    activeStilDetailKey: null,
    // Speicher des _memo-Helpers aus stil-rhythmus.js (Band + Satzanfänge werden
    // im Template mehrfach pro Render abgefragt).
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
          _memos: {},
        },
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...stilMethods,
    ...stilRhythmusMethods,
  }));
}
