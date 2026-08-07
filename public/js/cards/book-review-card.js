// Alpine.data('bookReviewCard') — Sub-Komponente der Buchbewertung.
//
// Eigener State: bookReviewLoading, bookReviewProgress, bookReviewStatus,
//   bookReviewOut, selectedBookReviewId, _reviewPollTimer.
// Root behält:
//   - `showBookReviewCard` (Hash-Router + Exklusivität)
//   - `bookReviewHistory` (tree.js/loadPages schreibt, user-settings liest)
//   - `loadBookReviewHistory` (history.js), `_closeOtherMainCards`, `t`

import { renderReviewHtml, bookReviewAxesFor } from '../book/review.js';
import { escHtml, renderStars, noteTip } from '../utils.js';
import { createCardJobFeature } from './job-feature-card.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerBookReviewCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookReviewCard', () => ({
    bookReviewLoading: false,
    bookReviewProgress: 0,
    bookReviewStatus: '',
    bookReviewOut: '',
    selectedBookReviewId: null,
    _reviewPollTimer: null,
    _lifecycle: null,

    init() {
      const onJobReconnect = (e) => {
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

      const onCardRefreshHistory = async (e) => {
        if (e.detail?.name !== 'bookReview') return;
        if (Alpine.store('nav').selectedBookId) await window.__app.loadBookReviewHistory(Alpine.store('nav').selectedBookId);
      };

      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showBookReviewCard',
        timerKeys: ['_reviewPollTimer'],
        onShow: () => this._onVisibleBookReview(),
        // Default load skipped — refresh-Listener und Reset reichen aus,
        // showFlag-Watcher delegiert an _onVisibleBookReview.
        resetState: {
          bookReviewLoading: false,
          bookReviewProgress: 0,
          bookReviewStatus: '',
          bookReviewOut: '',
          selectedBookReviewId: null,
        },
        extraListeners: [
          { type: 'job:reconnect', handler: onJobReconnect },
          { type: 'card:refresh', handler: onCardRefreshHistory },
        ],
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    _writeBookReviewStatus(msg, spinner) {
      const safe = escHtml(msg);
      this.bookReviewStatus = spinner ? `<span class="spinner"></span>${safe}` : safe;
    },

    _renderReviewHtml(r) {
      return renderReviewHtml(r, bookReviewAxesFor(r), (k, p) => window.__app.t(k, p));
    },

    renderStars(note) { return renderStars(note); },
    noteTip(note) { return noteTip(note); },

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
          book_id: parseInt(Alpine.store('nav').selectedBookId),
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
        if (Alpine.store('nav').selectedBookId) await window.__app.loadBookReviewHistory(Alpine.store('nav').selectedBookId);
      },
      async onOpen() {
        if (Alpine.store('nav').selectedBookId) await window.__app.loadBookReviewHistory(Alpine.store('nav').selectedBookId);
      },
    }),
  }));
}
