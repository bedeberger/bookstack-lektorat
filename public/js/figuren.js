// Figurenübersicht-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Die eigentliche Extraktion läuft serverseitig als Hintergrundjob (POST /jobs/figures).

import { escHtml } from './utils.js';

export const figurenMethods = {
  async loadFiguren(bookId) {
    try {
      const data = await fetch('/figures/' + bookId).then(r => r.json());
      this.figuren = data?.figuren || [];
      this.figurenUpdatedAt = data?.updated_at || null;
      this._buildGlobalZeitstrahl();
    } catch (e) {
      console.error('[loadFiguren]', e);
    }
  },

  async saveFiguren() {
    try {
      await fetch('/figures/' + this.selectedBookId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figuren: this.figuren }),
      });
    } catch (e) {
      console.error('[saveFiguren]', e);
    }
  },

  async toggleFiguresCard() {
    if (this.showFiguresCard) { this.showFiguresCard = false; return; }
    this._closeOtherMainCards('figures');
    this.showFiguresCard = true;
    if (this.showFiguresCard) {
      await this.loadFiguren(this.selectedBookId);
      await this.$nextTick();
      this.renderFigurGraph();
      // Prüfen ob auf dem Server bereits ein Figuren-Job für dieses Buch läuft
      if (!this._figuresPollTimer && !this.figurenLoading) {
        try {
          const { jobId: figJobId } = await fetch(`/jobs/active?type=figures&book_id=${this.selectedBookId}`).then(r => r.json());
          if (figJobId) {
            this.figurenLoading = true;
            this.figurenProgress = 0;
            this.figurenStatus = 'Figuren-Analyse läuft bereits…';
            this.startFiguresPoll(figJobId);
          }
        } catch (e) {
          console.error('[toggleFiguresCard] active-job check:', e);
        }
      }
    }
  },

  startFiguresPoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_figuresPollTimer',
      jobId,
      lsKey: 'lektorat_figures_job_' + bookId,
      onProgress: (job) => {
        this.figurenProgress = job.progress || 0;
        this.figurenStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, this.figurenProgress);
      },
      onNotFound: () => {
        this.figurenLoading = false;
        this.figurenProgress = 0;
        this.figurenStatus = 'Analyse unterbrochen (Server-Neustart). Bitte neu starten.';
      },
      onError: (job) => {
        this.figurenLoading = false;
        this.figurenProgress = 0;
        this.figurenStatus = `<span class="error-msg">Fehler: ${escHtml(job.error)}</span>`;
      },
      onDone: async (job) => {
        this.figurenLoading = false;
        this.figurenProgress = 0;
        if (job.result?.empty) {
          this.figurenStatus = 'Keine Seiten gefunden.';
          return;
        }
        await this.loadFiguren(bookId);
        const figCount = job.result?.count || this.figuren.length;
        this.figurenStatus = `${figCount} Figuren gespeichert.`;
        this._buildGlobalZeitstrahl();
        await this.$nextTick();
        this.renderFigurGraph();
      },
    });
  },

  async runSoziogrammEnrichment() {
    const bookId   = this.selectedBookId;
    const bookName = this.selectedBookName;
    this.soziogrammLoading  = true;
    this.soziogrammProgress = 0;
    this.soziogrammStatus   = 'Starte Soziogramm-Analyse…';
    try {
      const { jobId } = await fetch('/jobs/soziogramm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(bookId), book_name: bookName }),
      }).then(r => r.json());
      localStorage.setItem('lektorat_soziogramm_job_' + bookId, jobId);
      this.startSoziogrammPoll(jobId);
    } catch (e) {
      console.error('[runSoziogrammEnrichment]', e);
      this.soziogrammStatus   = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
      this.soziogrammLoading  = false;
      this.soziogrammProgress = 0;
    }
  },

  startSoziogrammPoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_soziogrammPollTimer',
      jobId,
      lsKey: 'lektorat_soziogramm_job_' + bookId,
      onProgress: (job) => {
        this.soziogrammProgress = job.progress || 0;
        this.soziogrammStatus   = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, this.soziogrammProgress);
      },
      onNotFound: () => {
        this.soziogrammLoading  = false;
        this.soziogrammProgress = 0;
        this.soziogrammStatus   = 'Analyse unterbrochen (Server-Neustart). Bitte neu starten.';
      },
      onError: (job) => {
        this.soziogrammLoading  = false;
        this.soziogrammProgress = 0;
        this.soziogrammStatus   = `<span class="error-msg">Fehler: ${escHtml(job.error)}</span>`;
      },
      onDone: async () => {
        this.soziogrammLoading  = false;
        this.soziogrammProgress = 0;
        await this.loadFiguren(bookId);
        this.soziogrammStatus   = 'Sozialschichten und Machtstrukturen gespeichert.';
        this._figurenHash = null; // Graph-Cache invalidieren
        await this.$nextTick();
        this.renderFigurGraph();
      },
    });
  },

  async runFigurExtraction() {
    const bookId = this.selectedBookId;
    const bookName = this.selectedBookName;
    this.figurenLoading = true;
    this.figurenProgress = 0;
    this.figurenStatus = 'Starte Analyse…';
    try {
      const { jobId } = await fetch('/jobs/figures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(bookId), book_name: bookName }),
      }).then(r => r.json());
      localStorage.setItem('lektorat_figures_job_' + bookId, jobId);
      this.startFiguresPoll(jobId);
    } catch (e) {
      console.error('[runFigurExtraction]', e);
      this.figurenStatus = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
      this.figurenLoading = false;
      this.figurenProgress = 0;
    }
  },
};
