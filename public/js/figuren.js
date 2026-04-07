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
        const year = parseInt(ev.datum);
        if (!year) continue; // Events ohne errechenbare Jahreszahl ignorieren
        allEvents.push({
          datum: String(year),
          ereignis: ev.ereignis || '',
          typ: ev.typ || 'persoenlich',
          bedeutung: ev.bedeutung || '',
          kapitel: ev.kapitel || '',
          figur: { id: f.id, name: f.kurzname || f.name, typ: f.typ },
        });
      }
    }

    // Events mit identischem datum+ereignis zusammenführen (alle Typen)
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
        kapitel: ev.kapitel,
        figuren: [ev.figur],
      };
      for (let j = i + 1; j < allEvents.length; j++) {
        if (used.has(j)) continue;
        const ev2 = allEvents[j];
        if (ev2.datum === ev.datum && ev2.ereignis === ev.ereignis) {
          group.figuren.push(ev2.figur);
          used.add(j);
        }
      }
      used.add(i);
      groups.push(group);
    }

    // Chronologisch sortieren
    groups.sort((a, b) => parseInt(a.datum) - parseInt(b.datum));

    this.globalZeitstrahl = groups;
  },

  async consolidateZeitstrahl() {
    if (!this.globalZeitstrahl.length || this.zeitstrahlConsolidating) return;
    this.zeitstrahlConsolidating = true;
    this.zeitstrahlProgress = 0;
    this.zeitstrahlStatus = 'Starte Konsolidierung…';
    try {
      const { jobId, empty } = await fetch('/jobs/consolidate-zeitstrahl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(this.selectedBookId), book_name: this.selectedBookName || null, events: this.globalZeitstrahl }),
      }).then(r => r.json());
      if (empty) { this.zeitstrahlConsolidating = false; this.zeitstrahlStatus = ''; return; }
      this.startConsolidatePoll(jobId);
    } catch (e) {
      console.error('[consolidateZeitstrahl]', e);
      this.zeitstrahlConsolidating = false;
      this.zeitstrahlProgress = 0;
      this.zeitstrahlStatus = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
    }
  },

  startConsolidatePoll(jobId) {
    this._startPoll({
      timerProp: '_consolidatePollTimer',
      jobId,
      progressProp: 'zeitstrahlProgress',
      onProgress: (job) => {
        this.zeitstrahlStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress);
      },
      onNotFound: () => {
        this.zeitstrahlConsolidating = false;
        this.zeitstrahlProgress = 0;
        this.zeitstrahlStatus = 'Konsolidierung unterbrochen (Server-Neustart). Bitte neu starten.';
      },
      onError: (job) => {
        this.zeitstrahlConsolidating = false;
        this.zeitstrahlProgress = 0;
        this.zeitstrahlStatus = `<span class="error-msg">Fehler: ${escHtml(job.error)}</span>`;
      },
      onDone: (job) => {
        this.zeitstrahlConsolidating = false;
        this.zeitstrahlProgress = 0;
        if (Array.isArray(job.result?.ereignisse)) {
          this.globalZeitstrahl = job.result.ereignisse;
          this.zeitstrahlStatus = `${job.result.ereignisse.length} Ereignisse konsolidiert.`;
        }
      },
    });
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

  async toggleEreignisseCard() {
    if (this.showEreignisseCard) { this.showEreignisseCard = false; return; }
    this._closeOtherMainCards('ereignisse');
    this.showEreignisseCard = true;
    // Figuren laden falls noch nicht geschehen (Zeitstrahl braucht sie)
    if (!this.figuren.length) {
      await this.loadFiguren(this.selectedBookId);
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
