// Alpine.data('strukturCard') — Struktur-Werkstatt journalistischer Beiträge.
// Nur bei Buchtyp 'journalismus' sichtbar (Gate via feature-registry
// requiresBuchtyp). Fachlicher State lebt hier, der showStrukturCard-Flag im
// Root (Hash-Router, Exklusivität).

import { strukturMethods } from '../book/struktur.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerStrukturCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('strukturCard', () => ({
    // Vorherrschende Textsorte des Buchs ('' = keine).
    strukturBookTextsorte: '',
    // { [page_id]: textsorte } — nur die ausdruecklichen Seiten-Overrides.
    strukturPageMap: {},
    // { [page_id]: check } — letzter Struktur-Befund je Seite.
    strukturChecks: {},
    // Aufgeklappte Zeile (page_id) oder null.
    strukturOpenId: null,
    strukturRunning: false,
    strukturProgress: 0,
    strukturStatus: '',
    strukturError: '',
    strukturLoadError: false,
    // Zusammenfassung des letzten Laufs (geprueft/uebersprungen/…) oder null.
    strukturLastRun: null,
    _strukturPollTimer: null,
    // Zeilen-Memo: das Template liest die Liste im x-for und in der Kopfzeile.
    _strukturRowsKey: null,
    _strukturRows: [],
    // Revisionszaehler: Textsorten-Aenderungen mutieren `strukturPageMap`
    // in-place, die Schluessel-Anzahl bleibt dabei gleich — ohne diesen Zaehler
    // traefe der Memo-Vergleich und die Tabelle zeigte den alten Wert.
    _strukturRev: 0,
    _strukturMemos: {},
    _lifecycle: null,

    get strukturHasRows() { return this.strukturRows().length > 0; },
    // Wie viele Beiträge haben überhaupt eine Textsorte? Ohne sie prüft der Job
    // nichts — das soll die Karte sagen, statt einen leeren Lauf zu zeigen.
    get strukturOhneTextsorte() {
      return this.strukturRows().filter(r => !r.textsorte).length;
    },
    get strukturMitBefund() {
      return this.strukturRows().filter(r => r.check).length;
    },

    init() {
      const doReset = (ctx) => {
        if (ctx._strukturPollTimer) { clearInterval(ctx._strukturPollTimer); ctx._strukturPollTimer = null; }
        ctx.strukturBookTextsorte = '';
        ctx.strukturPageMap = {};
        ctx.strukturChecks = {};
        ctx.strukturOpenId = null;
        ctx.strukturRunning = false;
        ctx.strukturProgress = 0;
        ctx.strukturStatus = '';
        ctx.strukturError = '';
        ctx.strukturLoadError = false;
        ctx.strukturLastRun = null;
        ctx._strukturRowsKey = null;
        ctx._strukturRows = [];
        ctx._strukturRev = 0;
        ctx._strukturMemos = {};
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'struktur',
        showFlag: 'showStrukturCard',
        timerKeys: ['_strukturPollTimer'],
        onShow: async () => { await this.loadStruktur(); },
        onBookChanged: async (e, ctx, root) => {
          doReset(ctx);
          if (root.showStrukturCard) await ctx.loadStruktur();
        },
        onViewReset: (e, ctx) => doReset(ctx),
        onCardRefresh: async (e, ctx) => { await ctx.loadStruktur(); },
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...strukturMethods,
  }));
}
