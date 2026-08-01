// Alpine.data('wortschatzCard') — Wortschatz-Analyse (quantitative Stilistik).
// Job-Polling implementiert die Karte selbst (manueller Flow, wie redundanzCard).
// Fachlicher State lebt hier; der showWortschatzCard-Flag bleibt im Root
// (Hash-Router, Exklusivität).

import { wortschatzMethods } from '../book/wortschatz.js';
import { wortschatzCloudMethods } from '../book/wortschatz-cloud.js';
import { setupCardLifecycle } from './card-lifecycle.js';

// Stabile Leer-Referenz: ein frisch gebautes `[]` bei jedem Getter-Aufruf würde
// den Memo-Vergleich unten immer verfehlen.
const EMPTY_ROWS = [];

export function registerWortschatzCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('wortschatzCard', () => ({
    // Serverantwort von GET /lexicon/:book_id:
    // { stats, terms, hapax, ngrams, peers, stale, thresholds }
    wortschatzData: null,
    wortschatzLoading: false,
    wortschatzProgress: 0,
    wortschatzStatus: '',
    wortschatzLoadError: false,
    // Aktiver Reiter: 'terms' | 'phrases' | 'hapax' | 'cloud'
    wortschatzTab: 'terms',
    // Wortwolke (vierter Reiter, siehe book/wortschatz-cloud.js).
    // 'freq' = Häufigkeit, 'key' = Keyness.
    wsCloudMode: 'freq',
    // Von d3-cloud platzierte Wörter (x/y/rotate/size). Leer, solange nicht gebaut.
    wsCloudLayout: [],
    wsCloudBuilding: false,
    wsCloudError: false,
    // Wie viele Wörter d3-cloud mangels Platz weglassen musste.
    wsCloudDropped: 0,
    // Laufender Layout-Handle + Lauf-Nummer (verwirft Ergebnisse überholter Läufe).
    _wsCloudLayout: null,
    _wsCloudRun: 0,
    _wortschatzPollTimer: null,
    // Memo der Einmalwort-Zeilen (Wortlänge angereichert). Der Getter läuft pro
    // Render mehrfach — ohne Cache baut er bei jedem Aufruf ein neues Array und
    // die sortableTable sortiert jedes Mal neu.
    _hapaxSrc: null,
    _hapaxRows: [],
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
    // Einmalwörter mit Wortlänge als eigenem Feld: sie ist die einzige Zahl, nach
    // der sich diese Liste sortieren lässt — die Häufigkeit ist per Definition
    // überall 1.
    get wortschatzHapax() {
      const src = this.wortschatzData?.hapax;
      if (!src) return EMPTY_ROWS;
      if (this._hapaxSrc !== src) {
        this._hapaxSrc = src;
        this._hapaxRows = src.map(h => ({ ...h, len: h.term.length }));
      }
      return this._hapaxRows;
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
        ctx._hapaxSrc = null;
        ctx._hapaxRows = [];
        ctx.wortschatzLoading = false;
        ctx.wortschatzProgress = 0;
        ctx.wortschatzStatus = '';
        ctx.wortschatzLoadError = false;
        ctx._wsCloudStop();
        ctx.wsCloudLayout = [];
        ctx.wsCloudBuilding = false;
        ctx.wsCloudError = false;
        ctx.wsCloudDropped = 0;
      };

      // Die Wolke wird nur gebaut, wenn ihr Reiter offen ist — der Layout-Lauf
      // misst jedes Wort einzeln auf einem Canvas und ist zu teuer, um ihn bei
      // jedem Kartenöffnen mitlaufen zu lassen.
      this.$watch('wortschatzTab', (tab) => { if (tab === 'cloud') this.wsBuildCloud(); });
      // Nach einem Scan/Reload zeigt die offene Wolke sonst den alten Stand.
      this.$watch('wortschatzData', () => { if (this.wortschatzTab === 'cloud') this.wsBuildCloud(); });

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

    destroy() {
      this._wsCloudStop();
      this._lifecycle?.destroy();
    },

    ...wortschatzMethods,
    ...wortschatzCloudMethods,
  }));
}
