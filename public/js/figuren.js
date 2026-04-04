import { escHtml } from './utils.js';

function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// Figurenübersicht-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Die eigentliche Extraktion läuft serverseitig als Hintergrundjob (POST /jobs/figures).

export const figurenMethods = {
  async loadFiguren(bookId) {
    try {
      const data = await fetch('/figures/' + bookId).then(r => r.json());
      this.figuren = data?.figuren || [];
      this.figurenUpdatedAt = data?.updated_at || null;
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
    this.showFiguresCard = !this.showFiguresCard;
    if (this.showFiguresCard) {
      await this.$nextTick();
      this.renderFigurGraph();
    }
  },

  // Pollt einen laufenden Figuren-Job und aktualisiert den UI-State.
  // Wird sowohl beim frischen Start als auch beim Reconnect nach Tab-Schliessen aufgerufen.
  startFiguresPoll(jobId) {
    const bookId = this.selectedBookId;
    if (this._figuresPollTimer) clearInterval(this._figuresPollTimer);
    this._figuresPollTimer = setInterval(async () => {
      try {
        const resp = await fetch('/jobs/' + jobId);
        if (resp.status === 404) {
          clearInterval(this._figuresPollTimer);
          this._figuresPollTimer = null;
          localStorage.removeItem('lektorat_figures_job_' + bookId);
          this.figurenLoading = false;
          this.figurenProgress = 0;
          this.figurenStatus = 'Analyse unterbrochen (Server-Neustart). Bitte neu starten.';
          return;
        }
        if (!resp.ok) return; // temporärer Fehler – beim nächsten Tick nochmal
        const job = await resp.json();
        this.figurenProgress = job.progress || 0;
        if (job.status === 'running') {
          const total = (job.tokensIn || 0) + (job.tokensOut || 0);
          const tokInfo = total > 0 ? ` · ${fmtTok(total)} Tokens` : '';
          this.figurenStatus = `<span class="spinner"></span>${escHtml(job.statusText || '…')}${tokInfo}`;
          return;
        }
        // Job ist fertig (done oder error)
        clearInterval(this._figuresPollTimer);
        this._figuresPollTimer = null;
        localStorage.removeItem('lektorat_figures_job_' + bookId);
        this.figurenLoading = false;
        this.figurenProgress = 0;

        if (job.status === 'error') {
          this.figurenStatus = `<span class="error-msg">Fehler: ${escHtml(job.error)}</span>`;
          return;
        }
        if (job.result?.empty) {
          this.figurenStatus = 'Keine Seiten gefunden.';
          return;
        }
        await this.loadFiguren(bookId);
        this.figurenUpdatedAt = new Date().toISOString();
        this.figurenStatus = `${job.result?.count || this.figuren.length} Figuren ermittelt und gespeichert.`;
        await this.$nextTick();
        this.renderFigurGraph();
      } catch (e) {
        console.error('[figuren poll]', e);
      }
    }, 2000);
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
