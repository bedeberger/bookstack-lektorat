// Schauplatz-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

import { escHtml } from './utils.js';

export const orteMethods = {
  async loadOrte(bookId) {
    try {
      const data = await fetch('/locations/' + bookId).then(r => r.json());
      this.orte = data?.orte || [];
      this.orteUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadOrte]', e);
    }
  },

  async saveOrte() {
    try {
      await fetch('/locations/' + this.selectedBookId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orte: this.orte }),
      });
    } catch (e) {
      console.error('[saveOrte]', e);
    }
  },

  async toggleOrteCard() {
    if (this.showOrteCard) { this.showOrteCard = false; return; }
    this._closeOtherMainCards('orte');
    this.showOrteCard = true;
    await this.loadOrte(this.selectedBookId);
    // Prüfen ob bereits ein Job läuft
    if (!this._ortePollTimer && !this.orteLoading) {
      try {
        const { jobId } = await fetch(`/jobs/active?type=locations&book_id=${this.selectedBookId}`).then(r => r.json());
        if (jobId) {
          this.orteLoading = true;
          this.orteProgress = 0;
          this.orteStatus = 'Analyse läuft bereits…';
          this.startOrtePoll(jobId);
        }
      } catch (e) {
        console.error('[toggleOrteCard] active-job check:', e);
      }
    }
  },

  startOrtePoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_ortePollTimer',
      jobId,
      lsKey: 'lektorat_orte_job_' + bookId,
      progressProp: 'orteProgress',
      onProgress: (job) => {
        this.orteStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress);
      },
      onNotFound: () => {
        this.orteLoading = false;
        this.orteProgress = 0;
        this.orteStatus = 'Analyse unterbrochen (Server-Neustart). Bitte neu starten.';
      },
      onError: (job) => {
        this.orteLoading = false;
        this.orteProgress = 0;
        this.orteStatus = `<span class="error-msg">Fehler: ${escHtml(job.error)}</span>`;
      },
      onDone: async (job) => {
        this.orteLoading = false;
        this.orteProgress = 0;
        if (job.result?.empty) { this.orteStatus = 'Keine Seiten gefunden.'; return; }
        await this.loadOrte(bookId);
        this.orteUpdatedAt = new Date().toISOString();
        this.orteStatus = `${job.result?.count || this.orte.length} Schauplätze ermittelt und gespeichert.`;
      },
    });
  },

  async runOrteExtraction() {
    const bookId = this.selectedBookId;
    const bookName = this.selectedBookName;
    this.orteLoading = true;
    this.orteProgress = 0;
    this.orteStatus = 'Starte Analyse…';
    try {
      const { jobId } = await fetch('/jobs/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(bookId), book_name: bookName }),
      }).then(r => r.json());
      localStorage.setItem('lektorat_orte_job_' + bookId, jobId);
      this.startOrtePoll(jobId);
    } catch (e) {
      console.error('[runOrteExtraction]', e);
      this.orteStatus = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
      this.orteLoading = false;
      this.orteProgress = 0;
    }
  },
};
