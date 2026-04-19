import { escHtml, fetchJson } from './utils.js';

// Kapitel-Review-Methoden (werden in die Alpine-Komponente gespreadet).
// `this` bezieht sich auf die Alpine-Komponente. Die eigentliche Analyse
// läuft serverseitig als Hintergrundjob (POST /jobs/chapter-review).
// Pro Kapitel kann ein eigener Job laufen – mehrere Kapitel parallel sind ok.

export const kapitelReviewMethods = {
  _lsKeyKapitelReview(chapterId) {
    return `lektorat_chapter_review_job_${this.selectedBookId}_${chapterId}`;
  },

  _renderKapitelReviewHtml(r) {
    const note = parseInt(r.gesamtnote, 10) || 0;
    const stars = '★'.repeat(Math.min(6, Math.max(0, note))) + '☆'.repeat(Math.max(0, 6 - note));
    let html = `
        <div class="bewertung-header">
          <span class="bewertung-stars">${stars}</span>
          <span class="bewertung-header-note">${escHtml(r.gesamtnote_begruendung || '')}</span>
        </div>
        <div class="stilbox" style="margin-bottom:14px;">${escHtml(r.zusammenfassung || '')}</div>`;
    const sections = [
      ['dramaturgie', 'kapitelReview.section.dramaturgie'],
      ['pacing',      'kapitelReview.section.pacing'],
      ['kohaerenz',   'kapitelReview.section.kohaerenz'],
      ['perspektive', 'kapitelReview.section.perspektive'],
      ['figuren',     'kapitelReview.section.figuren'],
    ];
    for (const [key, i18n] of sections) {
      if (r[key]) html += `
        <div class="bewertung-section">
          <div class="bewertung-section-title">${escHtml(this.t(i18n))}</div>
          <p class="bewertung-section-text">${escHtml(r[key])}</p>
        </div>`;
    }
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
    if (r.fazit) html += `<div class="fazit" style="margin-top:16px;">${escHtml(r.fazit)}</div>`;
    return html;
  },

  setKapitelReviewStatus(msg, spinner = false) {
    this.kapitelReviewStatus = spinner
      ? `<span class="spinner"></span>${msg}`
      : msg;
  },

  startKapitelReviewPoll(jobId, chapterId) {
    this._startPoll({
      timerProp: '_kapitelReviewPollTimer',
      jobId,
      lsKey: this._lsKeyKapitelReview(chapterId),
      progressProp: 'kapitelReviewProgress',
      onProgress: (job) => {
        this.kapitelReviewStatus = this._runningJobStatus(
          job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
          job.progress, job.tokensPerSec, job.statusParams,
        );
      },
      onNotFound: () => {
        this.kapitelReviewLoading = false;
        this.setKapitelReviewStatus(this.t('job.interrupted'));
      },
      onError: (job) => {
        this.kapitelReviewLoading = false;
        this.kapitelReviewOut = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(this.t(job.error, job.errorParams))}</span>`;
        this.setKapitelReviewStatus('');
      },
      onDone: async (job) => {
        this.kapitelReviewLoading = false;
        if (job.result?.empty) {
          this.setKapitelReviewStatus(this.t('kapitelReview.noPages'));
          return;
        }
        const r = job.result?.review;
        if (r) {
          this.kapitelReviewOut = this._renderKapitelReviewHtml(r);
          setTimeout(() => { this.kapitelReviewProgress = 0; }, 400);
          this.setKapitelReviewStatus(this.t('kapitelReview.pagesAnalyzed', { n: job.result.pageCount || '?' }));
          if (this.selectedBookId) await this.loadKapitelReviewHistory(this.selectedBookId);
        }
      },
    });
  },

  async loadKapitelReviewHistory(bookId) {
    try {
      this.kapitelReviewHistory = await fetchJson('/history/chapter-reviews/' + bookId) || {};
    } catch (e) {
      console.error('[loadKapitelReviewHistory]', e);
      this.kapitelReviewHistory = {};
    }
  },

  // Direkt aus der Sidebar: Kapitel auswählen und Karte öffnen.
  // `chapterId` kommt vom Klick auf ein Kapitel im Seitenbaum.
  async openKapitelReviewForChapter(chapterId) {
    if (!chapterId) return;
    // Prüfen, ob das Kapitel qualifiziert (>1 Seite) – Guard gegen Stale-Clicks.
    const opts = this.kapitelReviewChapterOptions();
    if (!opts.some(c => String(c.id) === String(chapterId))) return;
    const switching = String(this.kapitelReviewChapterId) !== String(chapterId);
    this.kapitelReviewChapterId = String(chapterId);
    if (switching) {
      this.kapitelReviewOut = '';
      this.setKapitelReviewStatus('');
    }
    if (!this.showKapitelReviewCard) {
      await this.toggleKapitelReviewCard();
    }
  },

  async toggleKapitelReviewCard() {
    if (this.showKapitelReviewCard) { this.showKapitelReviewCard = false; return; }
    this._closeOtherMainCards('kapitelReview');
    this.showKapitelReviewCard = true;
    // Default-Kapitel vorwählen (nur Kapitel mit mehr als einer Seite).
    // Einzelseiten-„Kapitel" werden über das normale Seiten-Lektorat abgedeckt.
    const current = this.kapitelReviewChapterId;
    const eligible = this.kapitelReviewChapterOptions();
    const stillValid = current && eligible.some(c => String(c.id) === String(current));
    if (!stillValid) {
      this.kapitelReviewChapterId = eligible.length ? String(eligible[0].id) : '';
    }
    if (this.selectedBookId) {
      await this.loadKapitelReviewHistory(this.selectedBookId);
    }
  },

  async runKapitelReview() {
    const bookId = this.selectedBookId;
    const bookName = this.selectedBookName;
    const chapterId = this.kapitelReviewChapterId;
    if (!chapterId) return;
    const chapter = (this.tree || []).find(i => i.type === 'chapter' && String(i.id) === String(chapterId));
    const chapterName = chapter?.name || '';
    this.kapitelReviewLoading = true;
    this.kapitelReviewProgress = 0;
    this.showKapitelReviewCard = true;
    this.kapitelReviewOut = '';
    this.setKapitelReviewStatus(this.t('kapitelReview.starting'), true);
    try {
      const { jobId } = await fetchJson('/jobs/chapter-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: parseInt(bookId),
          chapter_id: parseInt(chapterId),
          chapter_name: chapterName,
          book_name: bookName,
        }),
      });
      localStorage.setItem(this._lsKeyKapitelReview(chapterId), jobId);
      this.startKapitelReviewPoll(jobId, chapterId);
    } catch (e) {
      console.error('[runKapitelReview]', e);
      this.kapitelReviewOut = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.setKapitelReviewStatus('');
      this.kapitelReviewLoading = false;
    }
  },

  async deleteKapitelReview(id) {
    try {
      await fetchJson('/history/chapter-review/' + id, { method: 'DELETE' });
      if (this.selectedBookId) await this.loadKapitelReviewHistory(this.selectedBookId);
    } catch (e) {
      console.error('[deleteKapitelReview]', e);
    }
  },

  // Liste der Kapitel, die sich für ein Makro-Review lohnen: mehr als eine Seite.
  // Einzelseiten-„Kapitel" werden über das normale Seiten-Lektorat abgedeckt.
  // Als Methode statt Getter, weil Alpine-Spread Getter einmalig evaluiert und
  // als tote Property einfriert – `this.tree` wäre beim Spread undefined.
  kapitelReviewChapterOptions() {
    return (this.tree || [])
      .filter(i => i.type === 'chapter' && i.pages.length > 1)
      .map(c => ({ id: c.id, name: c.name, pageCount: c.pages.length }));
  },

  // Historieneinträge für das aktuell gewählte Kapitel
  kapitelReviewCurrentHistory() {
    if (!this.kapitelReviewChapterId) return [];
    return this.kapitelReviewHistory?.[String(this.kapitelReviewChapterId)] || [];
  },
};
