import { fetchJson, clearStatusAfter, formatLastRun } from '../utils.js';
import { EVT } from '../events.js';

// Komplett-Analyse-Pipeline-UI: Start, Polling, Phasen-Indikator,
// Last-Run-Anzeige, Kapitel-Cache-Reset.
// Server-seitiger Job-Typ: `komplett-analyse` (siehe routes/jobs/komplett.js).
export const appKomplettMethods = {
  async clearChapterCache() {
    if (!this.$store.nav.selectedBookId) return;
    if (!await this.appConfirm({
      message: this.t('app.cacheClearConfirm'),
      confirmLabel: this.t('common.delete'),
      danger: true,
    })) return;
    const { deleted } = await fetchJson(`/jobs/chapter-cache/${this.$store.nav.selectedBookId}`, { method: 'DELETE' });
    await this.appAlert({ message: this.t('app.cacheCleared', { n: deleted }) });
  },

  async alleAktualisieren() {
    if (!this.$store.nav.selectedBookId || this.$store.jobs.alleAktualisierenLoading) return;
    if (!await this.appConfirm({ message: this.t('komplett.confirm') })) return;
    this.$store.jobs.alleAktualisierenLoading = true;
    this.$store.jobs.alleAktualisierenProgress = 0;
    this.$store.jobs.alleAktualisierenTokIn = 0;
    this.$store.jobs.alleAktualisierenTokOut = 0;
    this.$store.jobs.alleAktualisierenTps = null;
    this.$store.jobs.alleAktualisierenPassMode = null;
    this.$store.jobs.alleAktualisierenWarnings = [];
    this.$store.jobs.alleAktualisierenCoverage = null;
    this.$store.jobs.alleAktualisierenCost = null;
    this.showKomplettStatus = true;
    const bookId = this.$store.nav.selectedBookId;
    const bookName = this.selectedBookName;
    try {
      this.$store.jobs.alleAktualisierenStatus = this.t('komplett.started');
      const { jobId } = await fetchJson('/jobs/komplett-analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: parseInt(bookId), book_name: bookName,
          // Teil-Lauf: read-only Endphasen abwählbar (Zeit + Kosten). Server-Default
          // ist „alles an", die Flags werden nur gesetzt, wenn der User sie anklickt.
          skip_continuity: !!this.komplettSkipContinuity,
          skip_narrative_profile: !!this.komplettSkipNarrativeProfile,
        }),
      });
      // Sofort-Refresh des Footer-Polls, sonst sieht die Job-Queue-Bar den Job
      // erst nach bis zu 5 s und driftet so lange gegen die 2-s-Karten-Bar.
      window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: 'komplett-analyse', jobId } }));
      this._startKomplettPoll(jobId, bookId);
    } catch (e) {
      console.error('[alleAktualisieren]', e);
      this.$store.jobs.alleAktualisierenStatus = `${this.t('common.errorColon')}${e.message}`;
      this.$store.jobs.alleAktualisierenLoading = false;
    }
  },

  _startKomplettPoll(jobId, bookId) {
    this._startPoll({
      timerProp: '_komplettPollTimer',
      progressProp: 'alleAktualisierenProgress',
      progressTarget: this.$store.jobs,
      jobId,
      lsKey: null,
      onProgress: (job) => {
        if (job.statusText) this.$store.jobs.alleAktualisierenStatus = this.t(job.statusText, job.statusParams);
        if (job.tokensIn != null) this.$store.jobs.alleAktualisierenTokIn = job.tokensIn;
        if (job.tokensOut != null) this.$store.jobs.alleAktualisierenTokOut = job.tokensOut;
        if (job.tokensPerSec != null) this.$store.jobs.alleAktualisierenTps = job.tokensPerSec;
        if (job.passMode) this.$store.jobs.alleAktualisierenPassMode = job.passMode;
      },
      onNotFound: () => {
        this.$store.jobs.alleAktualisierenLoading = false;
        this.$store.jobs.alleAktualisierenStatus = this.t('komplett.interrupted');
      },
      onError: (job) => {
        this.$store.jobs.alleAktualisierenLoading = false;
        this.$store.jobs.alleAktualisierenStatus = `${this.t('common.errorColon')}${job.error ? this.t(job.error, job.errorParams) : this.t('app.jobFailed')}`;
      },
      onDone: async (job) => {
        // Non-critical-Degradierungen (Soziogramm/P3b/Kontinuität) persistent im
        // Status-Panel zeigen – sonst ununterscheidbar von „alles ok".
        this.$store.jobs.alleAktualisierenWarnings = Array.isArray(job?.result?.warnings) ? job.result.warnings : [];
        // Coverage-Self-Audit (F2): Recall-Score der Stichprobe im Status-Panel zeigen.
        this.$store.jobs.alleAktualisierenCoverage = job?.result?.coverage || null;
        // Kosten pro Call-Klasse: neben dem Coverage-Score, damit „billiger geworden"
        // und „schlechterer Recall" im selben Blick vergleichbar sind.
        this.$store.jobs.alleAktualisierenCost = job?.result?.costByPhase || null;
        try {
          // _loadKontinuitaetHistory lebt auf kontinuitaetCard (nicht im Root) —
          // Card per card:refresh-Event reloaden lassen (Lifecycle hört darauf).
          window.dispatchEvent(new CustomEvent(EVT.CARD_REFRESH, { detail: { name: 'kontinuitaet' } }));
          await Promise.all([
            this.loadFiguren(bookId),
            this.loadOrte(bookId),
            this.loadSzenen(bookId),
            this.loadSongs(bookId),
            this.loadLastKomplettRun(bookId),
            this._reloadZeitstrahl(),
          ]);
        } finally {
          // Loading-Flag MUSS auch dann zurück, wenn ein Sibling-Reload wirft —
          // sonst bleibt Button-Ring + Status-Panel auf "running" hängen.
          this.$store.jobs.alleAktualisierenLoading = false;
          const doneMsg = this.t('common.finished');
          this.$store.jobs.alleAktualisierenStatus = doneMsg;
          clearStatusAfter(this.$store.jobs, 'alleAktualisierenStatus', doneMsg, 4000);
        }
      },
    });
  },

  async loadLastKomplettRun(bookId, { signal } = {}) {
    if (!bookId) return;
    try {
      const { lastRun } = await fetchJson(`/jobs/last-run?type=komplett-analyse&book_id=${bookId}`, { signal });
      this.$store.jobs.alleAktualisierenLastRun = lastRun ? formatLastRun(lastRun, (k, p) => this.t(k, p), this.$store.shell.uiLocale) : null;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.error('[loadLastKomplettRun]', e);
      this.$store.jobs.alleAktualisierenLastRun = null;
    }
  },

  _komplettPhasen() {
    const p = this.$store.jobs.alleAktualisierenProgress;
    // Thresholds entsprechen den Server-Progress-Punkten nach den jeweiligen aiCalls:
    //   orteConsolidate=55  = Ende Phase 3 (43→55)
    //   songsConsolidate=56 = Ende Phase 3 Songs (55→56)
    //   chapterRelations=58 = Ende Phase 3b (56→58, nur Multi-Pass)
    //   szenenEvents=78     = Ende Szenen-Remap/Save (58→78)
    //   timeline=82         = Ende aiCall Phase 6 (78→82)
    //   continuity=97       = Ende aiCall Phase 8 (82→97, breite Range für langen Call)
    // Im Single-Pass wird Phase 3b übersprungen (Server setzt passMode='single'),
    // damit sie auch im UI nicht als „erledigt" erscheint.
    const phases = [
      { key: 'phase.loadPages',          threshold: 12  },
      { key: 'phase.extract',            threshold: 30  },
      { key: 'phase.figurenConsolidate', threshold: 43  },
      { key: 'phase.orteConsolidate',    threshold: 55  },
      { key: 'phase.songsConsolidate',   threshold: 56  },
      { key: 'phase.chapterRelations',   threshold: 58, onlyMulti: true },
      { key: 'phase.szenenEvents',       threshold: 78  },
      { key: 'phase.timeline',           threshold: 82  },
      { key: 'phase.continuity',         threshold: 97  },
    ];
    const visible = phases.filter(ph => !(ph.onlyMulti && this.$store.jobs.alleAktualisierenPassMode === 'single'));
    return visible.map((ph, i) => {
      const done = p >= ph.threshold;
      const prevThreshold = i === 0 ? 0 : visible[i - 1].threshold;
      const active = !done && p >= prevThreshold;
      return { label: this.t(ph.key), done, active };
    });
  },
};
