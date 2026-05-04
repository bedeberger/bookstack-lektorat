// Alpine.data('bookOverviewCard') — Default-Landing beim Öffnen eines Buchs.
// Reine Datenaggregation aus existierenden Endpoints; kein KI-Job.
// `showBookOverviewCard` lebt im Root (Hash-Router, Exklusivität).

import { bookOverviewMethods } from '../book-overview.js';

export function registerBookOverviewCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookOverviewCard', () => ({
    overviewLoading: false,
    overviewBookId: null,
    overviewStats: [],
    overviewCoverage: null,
    overviewHeat: null,
    overviewLastReview: null,
    overviewPrevReview: null,
    overviewRecent: [],
    overviewFiguren: [],
    overviewSzenen: [],
    overviewOrte: [],
    overviewLektoratTime: null,

    _onBookChanged: null,
    _onViewReset: null,
    _pendingBookId: null,

    init() {
      // Buchwechsel via Combobox feuert beide Events (`view:reset` sync aus
      // resetView, `book:changed` async aus _resetBookScopedState). Alle
      // Trigger laufen durch `scheduleLoad`, das per Microtask coalesciert
      // und dedupliziert — sonst Race zwischen Reset und neuem Load.
      const scheduleLoad = () => {
        const bookId = window.__app?.selectedBookId || null;
        if (!bookId) { this._pendingBookId = null; return; }
        // Schon gescheduled für diesen Buch → noop, sonst doppelter Load.
        if (this._pendingBookId === bookId) return;
        this._pendingBookId = bookId;
        queueMicrotask(() => {
          if (!window.__app?.showBookOverviewCard) { this._pendingBookId = null; return; }
          const target = this._pendingBookId;
          this._pendingBookId = null;
          if (target) this.loadBookOverview(target);
        });
      };

      this.$watch(() => window.__app.showBookOverviewCard, (visible) => {
        if (visible) scheduleLoad();
      });

      this._onBookChanged = () => {
        // Arrays nicht hier leeren: alte Daten bleiben sichtbar, bis der neue
        // Load assignt — verhindert Tile-Flackern. Stale Antworten werden im
        // loadBookOverview via overviewBookId-Guard verworfen.
        scheduleLoad();
      };
      window.addEventListener('book:changed', this._onBookChanged);

      // resetView setzt zuerst showBookOverviewCard=false, dann _maybeOpenBookOverview
      // wieder true — Alpine $watch coalesciert false→true zu no-op, daher
      // explizit nachschieben.
      this._onViewReset = () => { scheduleLoad(); };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset', this._onViewReset);
    },

    ...bookOverviewMethods,
  }));
}
