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
    chapterSort: 'order', // 'order' | 'wordsDesc' | 'wordsAsc'

    _onBookChanged: null,
    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showBookOverviewCard, async (visible) => {
        if (!visible) return;
        if (!window.__app.selectedBookId) return;
        await this.loadBookOverview(window.__app.selectedBookId);
      });

      this._onBookChanged = () => {
        this.resetBookOverview();
        if (window.__app.showBookOverviewCard && window.__app.selectedBookId) {
          this.loadBookOverview(window.__app.selectedBookId);
        }
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => {
        this.resetBookOverview();
        // resetView setzt zuerst showBookOverviewCard=false, dann _maybeOpenBookOverview
        // wieder true — Alpine $watch coalesciert false→true im selben Tick zu no-op,
        // daher würde loadBookOverview nicht feuern. Explizit nachladen, sobald die
        // Reaktivität durch ist.
        queueMicrotask(() => {
          if (window.__app?.showBookOverviewCard && window.__app.selectedBookId) {
            this.loadBookOverview(window.__app.selectedBookId);
          }
        });
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset', this._onViewReset);
    },

    ...bookOverviewMethods,
  }));
}
