import { fetchJson, clearStatusAfter } from './utils.js';

// Komplett-Analyse-Pipeline-UI: Start, Polling, Phasen-Indikator,
// Last-Run-Anzeige, Kapitel-Cache-Reset.
// Server-seitiger Job-Typ: `komplett-analyse` (siehe routes/jobs/komplett.js).
export const appKomplettMethods = {
  async clearChapterCache() {
    if (!this.selectedBookId) return;
    if (!confirm(this.t('app.cacheClearConfirm'))) return;
    const { deleted } = await fetchJson(`/jobs/chapter-cache/${this.selectedBookId}`, { method: 'DELETE' });
    alert(this.t('app.cacheCleared', { n: deleted }));
  },

  async alleAktualisieren() {
    if (!this.selectedBookId || this.alleAktualisierenLoading) return;
    if (!confirm(this.t('komplett.confirm'))) return;
    this.alleAktualisierenLoading = true;
    this.alleAktualisierenProgress = 0;
    this.alleAktualisierenTokIn = 0;
    this.alleAktualisierenTokOut = 0;
    this.alleAktualisierenTps = null;
    this.showKomplettStatus = true;
    const bookId = this.selectedBookId;
    const bookName = this.selectedBookName;
    try {
      this.alleAktualisierenStatus = this.t('komplett.started');
      const { jobId } = await fetchJson('/jobs/komplett-analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(bookId), book_name: bookName }),
      });
      this._startKomplettPoll(jobId, bookId);
    } catch (e) {
      console.error('[alleAktualisieren]', e);
      this.alleAktualisierenStatus = `${this.t('common.errorColon')}${e.message}`;
      this.alleAktualisierenLoading = false;
    }
  },

  _startKomplettPoll(jobId, bookId) {
    this._startPoll({
      timerProp: '_komplettPollTimer',
      progressProp: 'alleAktualisierenProgress',
      jobId,
      lsKey: null,
      onProgress: (job) => {
        if (job.statusText) this.alleAktualisierenStatus = this.t(job.statusText, job.statusParams);
        if (job.tokensIn != null) this.alleAktualisierenTokIn = job.tokensIn;
        if (job.tokensOut != null) this.alleAktualisierenTokOut = job.tokensOut;
        if (job.tokensPerSec != null) this.alleAktualisierenTps = job.tokensPerSec;
      },
      onNotFound: () => {
        this.alleAktualisierenLoading = false;
        this.alleAktualisierenStatus = this.t('komplett.interrupted');
      },
      onError: (job) => {
        this.alleAktualisierenLoading = false;
        this.alleAktualisierenStatus = `${this.t('common.errorColon')}${job.error ? this.t(job.error, job.errorParams) : this.t('app.jobFailed')}`;
      },
      onDone: async () => {
        await Promise.all([
          this.loadFiguren(bookId),
          this.loadOrte(bookId),
          this.loadSzenen(bookId),
          this._loadKontinuitaetHistory(),
          this.loadLastKomplettRun(bookId),
          this._reloadZeitstrahl(),
        ]);
        this.alleAktualisierenLoading = false;
        const doneMsg = this.t('common.finished');
        this.alleAktualisierenStatus = doneMsg;
        clearStatusAfter(this, 'alleAktualisierenStatus', doneMsg, 4000);
      },
    });
  },

  async loadLastKomplettRun(bookId) {
    if (!bookId) return;
    try {
      const { lastRunFmt } = await fetchJson(`/jobs/last-run?type=komplett-analyse&book_id=${bookId}`);
      this.alleAktualisierenLastRun = lastRunFmt || null;
    } catch (e) {
      console.error('[loadLastKomplettRun]', e);
      this.alleAktualisierenLastRun = null;
    }
  },

  _komplettPhasen() {
    const p = this.alleAktualisierenProgress;
    const phases = [
      { key: 'phase.loadPages',          threshold: 12  },
      { key: 'phase.extract',            threshold: 30  },
      { key: 'phase.figurenConsolidate', threshold: 43  },
      { key: 'phase.orteConsolidate',    threshold: 56  },
      { key: 'phase.chapterRelations',   threshold: 58  },
      { key: 'phase.szenenEvents',       threshold: 83  },
      { key: 'phase.timeline',           threshold: 89  },
      { key: 'phase.continuity',         threshold: 97  },
    ];
    return phases.map((ph, i) => {
      const done = p >= ph.threshold;
      const prevThreshold = i === 0 ? 0 : phases[i - 1].threshold;
      const active = !done && p >= prevThreshold;
      return { label: this.t(ph.key), done, active };
    });
  },
};
