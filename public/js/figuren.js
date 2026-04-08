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
      // Prüfen ob auf dem Server bereits ein Job für dieses Buch läuft
      if (!this._figuresPollTimer && !this._figureEventsPollTimer && !this.figurenLoading) {
        try {
          const [{ jobId: figJobId }, { jobId: evJobId }] = await Promise.all([
            fetch(`/jobs/active?type=figures&book_id=${this.selectedBookId}`).then(r => r.json()),
            fetch(`/jobs/active?type=figure-events&book_id=${this.selectedBookId}`).then(r => r.json()),
          ]);
          if (figJobId) {
            this.figurenLoading = true;
            this.figurenProgress = 0;
            this.figurenStatus = 'Figuren-Analyse läuft bereits…';
            this.startFiguresPoll(figJobId);
          } else if (evJobId) {
            this.figurenLoading = true;
            this.figurenProgress = 50;
            this.figurenStatus = 'Ereignis-Analyse läuft bereits…';
            this.startFigureEventsPoll(evJobId);
          }
        } catch (e) {
          console.error('[toggleFiguresCard] active-job check:', e);
        }
      }
    }
  },

  // Pollt den Figuren-Job (0–50 %) und startet danach automatisch den Ereignis-Job.
  startFiguresPoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_figuresPollTimer',
      jobId,
      lsKey: 'lektorat_figures_job_' + bookId,
      onProgress: (job) => {
        this.figurenProgress = Math.round((job.progress || 0) / 2);
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
        if (job.result?.empty) {
          this.figurenLoading = false;
          this.figurenProgress = 0;
          this.figurenStatus = 'Keine Seiten gefunden.';
          return;
        }
        // Direkt zum Ereignis-Job weiterleiten
        this.figurenProgress = 50;
        this.figurenStatus = '<span class="spinner"></span>Figuren ermittelt – starte Ereignis-Analyse…';
        try {
          const { jobId: evJobId } = await fetch('/jobs/figure-events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ book_id: parseInt(bookId), book_name: this.selectedBookName }),
          }).then(r => r.json());
          localStorage.setItem('lektorat_figure_events_job_' + bookId, evJobId);
          this.startFigureEventsPoll(evJobId);
        } catch (e) {
          // Figuren sind da, aber Ereignis-Start schlug fehl
          this.figurenLoading = false;
          this.figurenProgress = 0;
          await this.loadFiguren(bookId);
          this.figurenStatus = `${job.result?.count || this.figuren.length} Figuren gespeichert. Ereignis-Analyse konnte nicht gestartet werden: ${escHtml(e.message)}`;
          this._buildGlobalZeitstrahl();
          await this.$nextTick();
          this.renderFigurGraph();
        }
      },
    });
  },

  // Pollt den Ereignis-Job (50–100 %).
  startFigureEventsPoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_figureEventsPollTimer',
      jobId,
      lsKey: 'lektorat_figure_events_job_' + bookId,
      onProgress: (job) => {
        this.figurenProgress = 50 + Math.round((job.progress || 0) / 2);
        this.figurenStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, this.figurenProgress);
      },
      onNotFound: () => {
        this.figurenLoading = false;
        this.figurenProgress = 0;
        this.figurenStatus = 'Ereignis-Analyse unterbrochen (Server-Neustart). Bitte neu starten.';
      },
      onError: (job) => {
        this.figurenLoading = false;
        this.figurenProgress = 0;
        this.figurenStatus = `<span class="error-msg">Fehler: ${escHtml(job.error)}</span>`;
      },
      onDone: async (job) => {
        this.figurenLoading = false;
        this.figurenProgress = 0;
        await this.loadFiguren(bookId);
        this.figurenUpdatedAt = new Date().toISOString();
        const figCount = this.figuren.length;
        const evCount = job.result?.eventCount ?? '?';
        this.figurenStatus = `${figCount} Figuren · ${evCount} Ereignisse ermittelt und gespeichert.`;
        this._buildGlobalZeitstrahl();
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
