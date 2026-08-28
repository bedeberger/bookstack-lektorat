// Alpine.data('fehlerHeatmapCard') — Sub-Komponente der Fehler-Heatmap.
//
// Neben der Heatmap-Matrix zeigt die Karte den Fehlerdichte-Trend über die
// Fassungen (Chart.js). Die Chart-Instanz + Theme-Observer leben als Modul-State
// in fehler-heatmap.js (Alpine-Proxy würde die Chart-Instanz beschädigen);
// destroy() + Ausblenden räumen beide auf.

import {
  fehlerHeatmapMethods,
  _destroyFehlerTrendChart,
  _disconnectFehlerTrendThemeObserver,
} from '../book/fehler-heatmap.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerFehlerHeatmapCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('fehlerHeatmapCard', () => ({
    fehlerHeatmapData: null,
    fehlerHeatmapLoading: false,
    fehlerHeatmapStatus: '',
    fehlerHeatmapMode: 'open',
    activeFehlerDetailKey: null,
    fehlerTrendData: [],
    // Memo-Speicher fuer fehlerHeatmapRange (siehe book/fehler-heatmap.js#_memo).
    // Explizit deklariert statt lazy — CLAUDE.md "State explizit deklariert".
    // Reset ueber this._memos = {} im Lade-Pfad und bei jedem State-Reset.
    _memos: {},
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showFehlerHeatmapCard',
        load: async () => {
          await this.loadFehlerHeatmap();
          await this.loadFehlerTrend();
        },
        // Factory, nicht Objekt-Literal: applyReset macht `Object.assign(ctx, state)`
        // und wuerde sonst bei JEDEM Reset dieselbe `_memos`-/`fehlerTrendData`-
        // Referenz einhaengen — ein geteilter Cache ueber alle Resets hinweg.
        resetStateView: () => ({
          fehlerHeatmapData: null,
          fehlerHeatmapStatus: '',
          fehlerHeatmapLoading: false,
          activeFehlerDetailKey: null,
          fehlerTrendData: [],
          _memos: {},
        }),
        onViewReset: (e, ctx) => {
          ctx.fehlerHeatmapData = null;
          ctx.fehlerHeatmapStatus = '';
          ctx.fehlerHeatmapLoading = false;
          ctx.activeFehlerDetailKey = null;
          ctx.fehlerTrendData = [];
          ctx._memos = {};
          _destroyFehlerTrendChart();
        },
      });

      // Chart beim Ausblenden zerstören, damit Chart.js' Resize-Handler nicht auf
      // dem versteckten Canvas crasht. Reopen baut es frisch (renderFehlerTrendChart).
      this.$watch(() => window.__app.showFehlerHeatmapCard, (visible) => {
        if (!visible) _destroyFehlerTrendChart();
      });
    },

    destroy() {
      this._lifecycle?.destroy();
      _destroyFehlerTrendChart();
      _disconnectFehlerTrendThemeObserver();
    },

    ...fehlerHeatmapMethods,
  }));
}
