import { escHtml } from './utils.js';

// Figurenübersicht-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Die eigentliche Extraktion läuft serverseitig als Hintergrundjob (POST /jobs/figures).

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

  _buildGlobalZeitstrahl() {
    const allEvents = [];
    for (const f of (this.figuren || [])) {
      for (const ev of (f.lebensereignisse || [])) {
        allEvents.push({
          datum: ev.datum || '',
          ereignis: ev.ereignis || '',
          typ: ev.typ || 'persoenlich',
          bedeutung: ev.bedeutung || '',
          figur: { id: f.id, name: f.kurzname || f.name, typ: f.typ },
        });
      }
    }

    // Externe Events mit identischem datum+ereignis zusammenführen
    const groups = [];
    const used = new Set();
    for (let i = 0; i < allEvents.length; i++) {
      if (used.has(i)) continue;
      const ev = allEvents[i];
      const group = {
        datum: ev.datum,
        ereignis: ev.ereignis,
        typ: ev.typ,
        bedeutung: ev.bedeutung,
        figuren: [ev.figur],
      };
      if (ev.typ === 'extern') {
        for (let j = i + 1; j < allEvents.length; j++) {
          if (used.has(j)) continue;
          const ev2 = allEvents[j];
          if (ev2.typ === 'extern' && ev2.datum === ev.datum && ev2.ereignis === ev.ereignis) {
            group.figuren.push(ev2.figur);
            used.add(j);
          }
        }
      }
      used.add(i);
      groups.push(group);
    }

    // Chronologisch sortieren: Jahrzahl wenn parsebar, sonst String
    groups.sort((a, b) => {
      const ya = parseInt(a.datum) || 0;
      const yb = parseInt(b.datum) || 0;
      if (ya && yb) return ya - yb;
      if (ya) return -1;
      if (yb) return 1;
      return a.datum.localeCompare(b.datum, 'de');
    });

    this.globalZeitstrahl = groups;
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
      if (!this._figuresPollTimer && !this.figurenLoading) {
        try {
          const { jobId } = await fetch(`/jobs/active?type=figures&book_id=${this.selectedBookId}`).then(r => r.json());
          if (jobId) {
            this.figurenLoading = true;
            this.figurenProgress = 0;
            this.figurenStatus = 'Analyse läuft bereits…';
            this.startFiguresPoll(jobId);
          }
        } catch (e) {
          console.error('[toggleFiguresCard] active-job check:', e);
        }
      }
    }
  },

  // Pollt einen laufenden Figuren-Job und aktualisiert den UI-State.
  // Wird sowohl beim frischen Start als auch beim Reconnect nach Tab-Schliessen aufgerufen.
  startFiguresPoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_figuresPollTimer',
      jobId,
      lsKey: 'lektorat_figures_job_' + bookId,
      progressProp: 'figurenProgress',
      onProgress: (job) => {
        this.figurenStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress);
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
        if (job.result?.empty) { this.figurenStatus = 'Keine Seiten gefunden.'; return; }
        await this.loadFiguren(bookId);
        this.figurenUpdatedAt = new Date().toISOString();
        this.figurenStatus = `${job.result?.count || this.figuren.length} Figuren ermittelt und gespeichert.`;
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
