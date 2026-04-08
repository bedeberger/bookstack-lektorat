import { escHtml } from './utils.js';

// Zeitstrahl-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const zeitstrahlMethods = {
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
          seite: ev.seite || '',
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
        kapitel: ev.kapitel ? [ev.kapitel] : [],
        seiten: ev.seite ? [ev.seite] : [],
        figuren: [ev.figur],
      };
      for (let j = i + 1; j < allEvents.length; j++) {
        if (used.has(j)) continue;
        const ev2 = allEvents[j];
        if (ev2.datum === ev.datum && ev2.ereignis === ev.ereignis) {
          group.figuren.push(ev2.figur);
          if (ev2.kapitel && !group.kapitel.includes(ev2.kapitel)) group.kapitel.push(ev2.kapitel);
          if (ev2.seite && !group.seiten.includes(ev2.seite)) group.seiten.push(ev2.seite);
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

  async runEreignisseExtraction() {
    if (this.ereignisseLoading) return;
    const bookId = this.selectedBookId;
    this.ereignisseLoading = true;
    this.ereignisseProgress = 0;
    this.ereignisseStatus = 'Starte Ermittlung…';
    try {
      const { jobId } = await fetch('/jobs/figure-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(bookId), book_name: this.selectedBookName }),
      }).then(r => r.json());
      localStorage.setItem('lektorat_figure_events_job_' + bookId, jobId);
      this.startEreignisseExtractPoll(jobId);
    } catch (e) {
      console.error('[runEreignisseExtraction]', e);
      this.ereignisseLoading = false;
      this.ereignisseProgress = 0;
      this.ereignisseStatus = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
    }
  },

  startEreignisseExtractPoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_ereignisseExtractPollTimer',
      jobId,
      lsKey: 'lektorat_figure_events_job_' + bookId,
      onProgress: (job) => {
        this.ereignisseProgress = job.progress || 0;
        this.ereignisseStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, this.ereignisseProgress);
      },
      onNotFound: () => {
        this.ereignisseLoading = false;
        this.ereignisseProgress = 0;
        this.ereignisseStatus = 'Ermittlung unterbrochen (Server-Neustart). Bitte neu starten.';
      },
      onError: (job) => {
        this.ereignisseLoading = false;
        this.ereignisseProgress = 0;
        this.ereignisseStatus = `<span class="error-msg">Fehler: ${escHtml(job.error)}</span>`;
      },
      onDone: async (job) => {
        this.ereignisseLoading = false;
        this.ereignisseProgress = 0;
        await this.loadFiguren(bookId);
        const evCount = job.result?.eventCount ?? '?';
        this.ereignisseStatus = `${evCount} Ereignisse ermittelt und gespeichert.`;
        this._buildGlobalZeitstrahl();
      },
    });
  },

  async toggleEreignisseCard() {
    if (this.showEreignisseCard) { this.showEreignisseCard = false; return; }
    this._closeOtherMainCards('ereignisse');
    this.showEreignisseCard = true;
    if (!this.figuren.length) {
      await this.loadFiguren(this.selectedBookId);
    }
    // Prüfen ob auf dem Server bereits ein Ereignis-Ermittlungsjob läuft
    if (!this._ereignisseExtractPollTimer && !this.ereignisseLoading) {
      try {
        const { jobId } = await fetch(`/jobs/active?type=figure-events&book_id=${this.selectedBookId}`).then(r => r.json());
        if (jobId) {
          this.ereignisseLoading = true;
          this.ereignisseProgress = 0;
          this.ereignisseStatus = 'Ermittlung läuft bereits…';
          this.startEreignisseExtractPoll(jobId);
        }
      } catch (e) {
        console.error('[toggleEreignisseCard] active-job check:', e);
      }
    }
  },
};
