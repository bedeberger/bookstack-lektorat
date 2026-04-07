import { escHtml } from './utils.js';

// Szenenanalyse-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Die Extraktion läuft serverseitig als Hintergrundjob (POST /jobs/szenen).

export const szenenMethods = {
  async toggleSzenenCard() {
    if (this.showSzenenCard) { this.showSzenenCard = false; return; }
    this._closeOtherMainCards('szenen');
    this.showSzenenCard = true;
    // Figuren laden falls noch nicht vorhanden (für Figurennamen in Szenen)
    if (!this.figuren.length) await this.loadFiguren(this.selectedBookId);
    await this.loadSzenen(this.selectedBookId);
    // Prüfen ob bereits ein Job für dieses Buch läuft
    if (!this._szenenPollTimer && !this.szenenLoading) {
      try {
        const { jobId } = await fetch(`/jobs/active?type=szenen&book_id=${this.selectedBookId}`).then(r => r.json());
        if (jobId) {
          this.szenenLoading = true;
          this.szenenProgress = 0;
          this.szenenStatus = 'Analyse läuft bereits…';
          this.startSzenenPoll(jobId);
        }
      } catch (e) {
        console.error('[toggleSzenenCard] active-job check:', e);
      }
    }
  },

  async loadSzenen(bookId) {
    try {
      const data = await fetch('/figures/scenes/' + bookId).then(r => r.json());
      this.szenen = data?.szenen || [];
      this.szenenUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadSzenen]', e);
    }
  },

  async runSzenenAnalyse() {
    if (!this.figuren.length) {
      this.szenenStatus = '<span class="error-msg">Bitte zuerst Figuren ermitteln.</span>';
      return;
    }
    const bookId = this.selectedBookId;
    const bookName = this.selectedBookName;
    this.szenenLoading = true;
    this.szenenProgress = 0;
    this.szenenStatus = 'Starte Szenenanalyse…';
    try {
      const { jobId } = await fetch('/jobs/szenen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(bookId), book_name: bookName }),
      }).then(r => r.json());
      localStorage.setItem('lektorat_szenen_job_' + bookId, jobId);
      this.startSzenenPoll(jobId);
    } catch (e) {
      console.error('[runSzenenAnalyse]', e);
      this.szenenStatus = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
      this.szenenLoading = false;
      this.szenenProgress = 0;
    }
  },

  startSzenenPoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_szenenPollTimer',
      jobId,
      lsKey: 'lektorat_szenen_job_' + bookId,
      progressProp: 'szenenProgress',
      onProgress: (job) => {
        this.szenenStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress);
      },
      onNotFound: () => {
        this.szenenLoading = false;
        this.szenenProgress = 0;
        this.szenenStatus = 'Analyse unterbrochen (Server-Neustart). Bitte neu starten.';
      },
      onError: (job) => {
        this.szenenLoading = false;
        this.szenenProgress = 0;
        this.szenenStatus = `<span class="error-msg">Fehler: ${escHtml(job.error)}</span>`;
      },
      onDone: async (job) => {
        this.szenenLoading = false;
        this.szenenProgress = 0;
        if (job.result?.empty) { this.szenenStatus = 'Keine Seiten gefunden.'; return; }
        await this.loadSzenen(bookId);
        this.szenenStatus = `${job.result?.count || this.szenen.length} Szenen ermittelt.`;
      },
    });
  },
};
