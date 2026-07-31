// Alpine.data('wortschatzCard') — Wortschatz-Analyse (quantitative Stilistik).
// Job-Polling implementiert die Karte selbst (manueller Flow, wie redundanzCard).
// Fachlicher State lebt hier; der showWortschatzCard-Flag bleibt im Root
// (Hash-Router, Exklusivität).

import { wortschatzMethods } from '../book/wortschatz.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerWortschatzCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('wortschatzCard', () => ({
    // Serverantwort von GET /lexicon/:book_id: { stats, terms, ngrams, peers, stale, thresholds }
    wortschatzData: null,
    wortschatzLoading: false,
    wortschatzProgress: 0,
    wortschatzStatus: '',
    wortschatzLoadError: false,
    // Aktiver Reiter der Ranglisten: 'terms' | 'phrases'
    wortschatzTab: 'terms',
    _wortschatzPollTimer: null,
    _lifecycle: null,

    // Getter inline (nicht in wortschatzMethods gespreadet — Spread-Getter-Falle).
    get wortschatzHasResult() {
      return !!this.wortschatzData?.stats;
    },
    get wortschatzTerms() {
      return this.wortschatzData?.terms || [];
    },
    get wortschatzNgrams() {
      return this.wortschatzData?.ngrams || [];
    },
    // Keyness-Spalte nur zeigen, wenn es überhaupt ein Referenzkorpus gab —
    // eine Spalte voller „–" ist keine Information, sondern Rauschen.
    get wortschatzHasKeyness() {
      return this.wortschatzTerms.some(t => t.keyness != null);
    },

    init() {
      const doReset = (ctx) => {
        if (ctx._wortschatzPollTimer) { clearTimeout(ctx._wortschatzPollTimer); ctx._wortschatzPollTimer = null; }
        ctx.wortschatzData = null;
        ctx.wortschatzLoading = false;
        ctx.wortschatzProgress = 0;
        ctx.wortschatzStatus = '';
        ctx.wortschatzLoadError = false;
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'wortschatz',
        showFlag: 'showWortschatzCard',
        timerKeys: ['_wortschatzPollTimer'],
        onShow: async () => { await this.loadWortschatz(); },
        onBookChanged: async (e, ctx, root) => {
          doReset(ctx);
          if (root.showWortschatzCard) await ctx.loadWortschatz();
        },
        onViewReset: (e, ctx) => doReset(ctx),
        onCardRefresh: async (e, ctx) => { await ctx.loadWortschatz(); },
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...wortschatzMethods,
  }));
}
