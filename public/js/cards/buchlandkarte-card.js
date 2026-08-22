// Alpine.data('buchlandkarteCard') — Buchlandkarte (Seiten als Punktwolke über
// dem Embedding-Index). Job-Polling implementiert die Karte selbst (manueller
// Flow, wie beim Redundanz-Radar). Fachlicher State lebt hier; der
// showBuchlandkarteCard-Flag bleibt im Root (Exklusivität).

import {
  buchlandkarteMethods, _destroyBookMapChart, _disconnectBookMapThemeObserver,
} from '../book/buchlandkarte.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerBuchlandkarteCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('buchlandkarteCard', () => ({
    bookMapResult: null,
    bookMapLoading: false,
    bookMapProgress: 0,
    bookMapStatus: '',
    bookMapIndexInfo: null,
    _bookMapPollTimer: null,
    _lifecycle: null,

    // Getter inline (nicht im gespreadeten Fachmodul — Spread-Getter-Falle):
    // Backend + Buch vorhanden (die Vektoren leben pro Buch).
    get bookMapAvailable() {
      return !!this.$store.config?.semanticSearchEnabled && !!Alpine.store('nav').selectedBookId;
    },
    // Ob ein SEITEN-Index existiert — nur Seiten werden projiziert.
    get bookMapHasIndex() {
      const bk = this.bookMapIndexInfo?.byKind || [];
      return bk.some(k => k.kind === 'page' && k.chunks > 0);
    },

    init() {
      const doReset = (ctx) => {
        if (ctx._bookMapPollTimer) { clearTimeout(ctx._bookMapPollTimer); ctx._bookMapPollTimer = null; }
        _destroyBookMapChart();
        ctx.bookMapResult = null;
        ctx.bookMapLoading = false;
        ctx.bookMapProgress = 0;
        ctx.bookMapStatus = '';
        ctx.bookMapIndexInfo = null;
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'buchlandkarte',
        showFlag: 'showBuchlandkarteCard',
        timerKeys: ['_bookMapPollTimer'],
        onShow: async () => {
          if (this.bookMapAvailable) await this.loadBookMapIndexStatus();
        },
        onBookChanged: async (e, ctx, root) => {
          doReset(ctx);
          if (!root.showBuchlandkarteCard) return;
          if (ctx.bookMapAvailable) await ctx.loadBookMapIndexStatus();
        },
        onViewReset: (e, ctx) => doReset(ctx),
      });
    },

    destroy() {
      // Chart-Instanz UND Theme-Observer liegen modulweit — ohne beides
      // überlebt der Observer das Unmount und zeichnet in ein totes Canvas.
      _destroyBookMapChart();
      _disconnectBookMapThemeObserver();
      this._lifecycle?.destroy();
    },

    ...buchlandkarteMethods,
  }));
}
