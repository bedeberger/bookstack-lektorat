import { escHtml, fetchJson } from './utils.js';

// Buchbewertungs-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Die eigentliche Analyse läuft serverseitig als Hintergrundjob (POST /jobs/review).

export const reviewMethods = {
  _renderReviewHtml(r) {
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
  },

  // Pollt einen laufenden Review-Job und aktualisiert den UI-State.
  // Wird sowohl beim frischen Start als auch beim Reconnect nach Tab-Schliessen aufgerufen.
  startReviewPoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_reviewPollTimer',
      jobId,
      lsKey: 'lektorat_review_job_' + bookId,
      progressProp: 'bookReviewProgress',
      onProgress: (job) => {
        this.bookReviewStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
      },
      onNotFound: () => {
        this.bookReviewLoading = false;
        this.setReviewStatus(this.t('job.interrupted'));
      },
      onError: (job) => {
        this.bookReviewLoading = false;
        this.bookReviewOut = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(this.t(job.error, job.errorParams))}</span>`;
        this.setReviewStatus('');
      },
      onDone: async (job) => {
        this.bookReviewLoading = false;
        if (job.result?.empty) { this.setReviewStatus(this.t('review.noPages')); return; }
        const r = job.result?.review;
        if (r) {
          this.bookReviewOut = this._renderReviewHtml(r);
          setTimeout(() => { this.bookReviewProgress = 0; }, 400);
          this.setReviewStatus(this.t('review.pagesAnalyzed', { n: job.result.pageCount || '?' }));
          await this.loadBookReviewHistory(bookId);
        }
      },
    });
  },

  async toggleBookReviewCard() {
    if (this.showBookReviewCard) { if (this.selectedBookId) await this.loadBookReviewHistory(this.selectedBookId); return; }
    this._closeOtherMainCards('bookReview');
    this.showBookReviewCard = true;
    if (this.selectedBookId) {
      await this.loadBookReviewHistory(this.selectedBookId);
      // Prüfen ob auf dem Server bereits ein Job für dieses Buch läuft
      if (!this._reviewPollTimer && !this.bookReviewLoading) {
        try {
          const { jobId } = await fetchJson(`/jobs/active?type=review&book_id=${this.selectedBookId}`);
          if (jobId) {
            this.bookReviewLoading = true;
            this.bookReviewProgress = 0;
            this.bookReviewOut = '';
            this.setReviewStatus(this.t('common.analysisAlreadyRunning'), true);
            this.startReviewPoll(jobId);
          }
        } catch (e) {
          console.error('[toggleBookReviewCard] active-job check:', e);
        }
      }
    }
  },

  async runBookReview() {
    const bookId = this.selectedBookId;
    const bookName = this.selectedBookName;
    this.bookReviewLoading = true;
    this.bookReviewProgress = 0;
    this.showBookReviewCard = true;
    this.bookReviewOut = '';
    this.setReviewStatus(this.t('review.starting'), true);
    try {
      const { jobId } = await fetchJson('/jobs/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(bookId), book_name: bookName }),
      });
      localStorage.setItem('lektorat_review_job_' + bookId, jobId);
      this.startReviewPoll(jobId);
    } catch (e) {
      console.error('[runBookReview]', e);
      this.bookReviewOut = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.setReviewStatus('');
      this.bookReviewLoading = false;
    }
  },
};
