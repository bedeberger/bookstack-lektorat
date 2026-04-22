// Alpine.data('bookReviewCard') — Sub-Komponente der Buchbewertung.
//
// Eigener State: bookReviewLoading, bookReviewProgress, bookReviewStatus,
//   bookReviewOut, selectedBookReviewId, _reviewPollTimer.
// Root behält:
//   - `showBookReviewCard` (Hash-Router + Exklusivität)
//   - `bookReviewHistory` (tree.js/loadPages schreibt, user-settings liest)
//   - `loadBookReviewHistory` (history.js), `_closeOtherMainCards`, `t`
//
// Lifecycle:
//   - $watch($root.showBookReviewCard): Onvisible (History laden + Active-Job-Check)
//   - book:changed: eigenen State nullen, Polling stoppen
//   - view:reset: wie book:changed
//   - card:refresh (name='bookReview'): History neu laden
//   - job:reconnect (type='review'): Loading-State übernehmen + Polling starten

import { renderReviewHtml } from '../review.js';
import { createCardJobFeature } from './job-feature-card.js';

export function registerBookReviewCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookReviewCard', () => ({
    bookReviewLoading: false,
    bookReviewProgress: 0,
    bookReviewStatus: '',
    bookReviewOut: '',
    selectedBookReviewId: null,
    _reviewPollTimer: null,

    _onBookChanged: null,
    _onViewReset: null,
    _onCardRefresh: null,
    _onJobReconnect: null,

    init() {
      this.$watch(() => window.__app.showBookReviewCard, async (visible) => {
        if (!visible) return;
        if (!window.__app.selectedBookId) return;
        await this._onVisibleBookReview();
      });

      this._onBookChanged = () => {
        if (this._reviewPollTimer) { clearInterval(this._reviewPollTimer); this._reviewPollTimer = null; }
        this.bookReviewLoading = false;
        this.bookReviewProgress = 0;
        this.bookReviewStatus = '';
        this.bookReviewOut = '';
        this.selectedBookReviewId = null;
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => {
        if (this._reviewPollTimer) { clearInterval(this._reviewPollTimer); this._reviewPollTimer = null; }
        this.bookReviewLoading = false;
        this.bookReviewProgress = 0;
        this.bookReviewStatus = '';
        this.bookReviewOut = '';
        this.selectedBookReviewId = null;
      };
      window.addEventListener('view:reset', this._onViewReset);

      this._onCardRefresh = async (e) => {
        if (e.detail?.name !== 'bookReview') return;
        if (window.__app.selectedBookId) await window.__app.loadBookReviewHistory(window.__app.selectedBookId);
      };
      window.addEventListener('card:refresh', this._onCardRefresh);

      this._onJobReconnect = (e) => {
        const d = e.detail;
        if (d?.type !== 'review') return;
        const job = d.job;
        this.bookReviewLoading = true;
        this.bookReviewProgress = job.progress || 0;
        this.bookReviewOut = '';
        this._writeBookReviewStatus(
          job.statusText ? window.__app.t(job.statusText, job.statusParams) : window.__app.t('common.analysisRunning'),
          true,
        );
        this.startBookReviewPoll(d.jobId);
      };
      window.addEventListener('job:reconnect', this._onJobReconnect);
    },

    destroy() {
      if (this._reviewPollTimer) { clearInterval(this._reviewPollTimer); this._reviewPollTimer = null; }
      if (this._onBookChanged)   window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)     window.removeEventListener('view:reset',  this._onViewReset);
      if (this._onCardRefresh)   window.removeEventListener('card:refresh', this._onCardRefresh);
      if (this._onJobReconnect)  window.removeEventListener('job:reconnect', this._onJobReconnect);
    },

    _writeBookReviewStatus(msg, spinner) {
      this.bookReviewStatus = spinner ? `<span class="spinner"></span>${msg}` : msg;
    },

    _renderReviewHtml(r) {
      return renderReviewHtml(r, (k, p) => window.__app.t(k, p));
    },

    ...createCardJobFeature({
      name: 'review',
      endpoint: '/jobs/review',
      timerProp: '_reviewPollTimer',
      methodNames: {
        start:     'startBookReviewPoll',
        run:       'runBookReview',
        onVisible: '_onVisibleBookReview',
      },
      fields: {
        show:     'showBookReviewCard',
        loading:  'bookReviewLoading',
        progress: 'bookReviewProgress',
        status:   'bookReviewStatus',
        out:      'bookReviewOut',
      },
      i18n: {
        starting:       'review.starting',
        interrupted:    'job.interrupted',
        alreadyRunning: 'common.analysisAlreadyRunning',
        empty:          'review.noPages',
      },
      progressResetDelay: 400,
      buildPayload() {
        return {
          book_id: parseInt(window.__app.selectedBookId),
          book_name: window.__app.selectedBookName,
        };
      },
      render(job) {
        const r = job.result?.review;
        return r ? this._renderReviewHtml(r) : undefined;
      },
      async onDone(job) {
        if (!job.result?.review) return;
        this.bookReviewStatus = window.__app.t('review.pagesAnalyzed', { n: job.result.pageCount || '?' });
        if (window.__app.selectedBookId) await window.__app.loadBookReviewHistory(window.__app.selectedBookId);
      },
      async onOpen() {
        if (window.__app.selectedBookId) await window.__app.loadBookReviewHistory(window.__app.selectedBookId);
      },
    }),
  }));
}
