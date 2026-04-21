import { escHtml } from './utils.js';
import { createJobFeature } from './app-jobs-core.js';

// Buchbewertungs-Methoden (werden in die Alpine-Komponente gespreadet).
// `this` bezieht sich auf die Alpine-Komponente. Die eigentliche Analyse
// läuft serverseitig als Hintergrundjob (POST /jobs/review). Generischer
// Job-Flow kommt aus createJobFeature — hier bleiben nur Render und
// Post-Processing.

function renderReviewHtml(r) {
  const note = parseInt(r.gesamtnote, 10) || 0;
  const stars = '★'.repeat(Math.min(6, Math.max(0, note))) + '☆'.repeat(Math.max(0, 6 - note));
  let html = `
      <div class="bewertung-header">
        <span class="bewertung-stars">${stars}</span>
        <span class="bewertung-header-note">${escHtml(r.gesamtnote_begruendung || '')}</span>
      </div>
      <div class="stilbox stilbox--review-summary">${escHtml(r.zusammenfassung || '')}</div>`;
  if (r.struktur) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(this.t('review.section.struktur'))}</div>
        <p class="bewertung-section-text">${escHtml(r.struktur)}</p>
      </div>`;
  if (r.stil) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(this.t('review.section.stil'))}</div>
        <p class="bewertung-section-text">${escHtml(r.stil)}</p>
      </div>`;
  if (r.staerken?.length) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(this.t('review.strengths'))}</div>
        <ul class="bullet-list pos">${r.staerken.map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>
      </div>`;
  if (r.schwaechen?.length) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(this.t('review.weaknesses'))}</div>
        <ul class="bullet-list neg">${r.schwaechen.map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>
      </div>`;
  if (r.empfehlungen?.length) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(this.t('review.section.empfehlungen'))}</div>
        <ul class="bullet-list">${r.empfehlungen.map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>
      </div>`;
  if (r.fazit) html += `<div class="fazit fazit--review">${escHtml(r.fazit)}</div>`;
  return html;
}

export const reviewMethods = {
  _renderReviewHtml: renderReviewHtml,

  ...createJobFeature({
    name: 'review',
    endpoint: '/jobs/review',
    timerProp: '_reviewPollTimer',
    closeCardKey: 'bookReview',
    methodNames: {
      start:  'startReviewPoll',
      run:    'runBookReview',
      toggle: 'toggleBookReviewCard',
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
        book_id: parseInt(this.selectedBookId),
        book_name: this.selectedBookName,
      };
    },
    render(job) {
      const r = job.result?.review;
      return r ? renderReviewHtml.call(this, r) : undefined;
    },
    async onDone(job) {
      if (!job.result?.review) return;
      this.bookReviewStatus = this.t('review.pagesAnalyzed', { n: job.result.pageCount || '?' });
      await this.loadBookReviewHistory(this.selectedBookId);
    },
    async onOpen() {
      if (this.selectedBookId) await this.loadBookReviewHistory(this.selectedBookId);
    },
    async onOpenWhenOpen() {
      if (this.selectedBookId) await this.loadBookReviewHistory(this.selectedBookId);
    },
  }),
};
