import { escHtml, fmtTok, fetchJson } from './utils.js';
import { startPoll as _startPollFn, runningJobStatus as _runningJobStatusFn } from './cards/job-helpers.js';

// Factory für standard job-driven Feature-Cards (Review, Kontinuität,
// Kapitel-Review, Figuren, …). Die Features folgen alle demselben Muster:
// toggle → POST /jobs/… → localStorage-Backup → poll bis done →
// Status-HTML ins x-html-Feld. Die Factory deklariert die generischen
// Methoden (`start`, `run`, `toggle`) und das Feature-Modul liefert nur
// die variablen Teile (Endpoint, Render, Payload, Post-Processing).
//
// cfg:
//   name              — logischer Feature-Name (z. B. 'review'), Default für
//                       LS-Key und activeType.
//   endpoint          — POST-Ziel, z. B. '/jobs/review'.
//   activeType        — Override für /jobs/active?type=…; Default = name.
//   timerProp         — z. B. '_reviewPollTimer'.
//   closeCardKey      — Argument für _closeOtherMainCards(…).
//   methodNames       — { start, run, toggle? }.
//   fields            — { show, loading, progress, status, out?, result? }.
//   lsKey             — optional: (bookId, self) => string.
//                       Default `lektorat_${name}_job_${bookId}`.
//   i18n              — { starting, interrupted, alreadyRunning,
//                         alreadyRunningSpinner?, empty? }.
//   buildPayload      — (self) => body-Objekt für den POST.
//   render            — (job, self) => html für `fields.out`. Optional.
//   onDone            — async (job, self) => void — nach render.
//   onError           — (job, self) => void — Override des Default-Rendering.
//   onNotFound        — (self) => void — Zusatz nach NotFound.
//   onOpen            — async (self) => void — nach frischem Öffnen.
//   onOpenWhenOpen    — async (self) => void — wenn toggle auf offene Karte.
//   beforeRun         — (self) => void — vor POST (z. B. Result-Reset).
//   resetProgressOnDone — bool (Default: true) — Progress auf 0 nach onDone.
//   progressResetDelay  — ms (Default: 0) — verzögerter Reset nach Erfolg
//                         (lässt die Fortschrittsleiste ausfüllen, bevor sie
//                         zurückspringt). Bei empty/error sofortiger Reset.
export function createJobFeature(cfg) {
  const { show, loading, progress, status, out } = cfg.fields;
  const timerProp  = cfg.timerProp;
  const activeType = cfg.activeType || cfg.name;
  const lsKeyFn    = cfg.lsKey || ((bookId) => `lektorat_${cfg.name}_job_${bookId}`);
  const names      = cfg.methodNames;
  const i18n       = cfg.i18n || {};

  function writeStatus(msg, spinner) {
    this[status] = spinner ? `<span class="spinner"></span>${msg}` : msg;
  }
  function jobErrHtml(job) {
    return `<span class="error-msg">${this.t('common.errorColon')}${escHtml(this.t(job.error, job.errorParams))}</span>`;
  }
  function errHtml(err) {
    return `<span class="error-msg">${this.t('common.errorColon')}${escHtml(err.message)}</span>`;
  }

  const startPoll = function (jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp,
      jobId,
      lsKey: lsKeyFn(bookId, this),
      progressProp: progress,
      onProgress: (job) => {
        this[status] = this._runningJobStatus(
          job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
          job.progress, job.tokensPerSec, job.statusParams,
        );
      },
      onNotFound: () => {
        this[loading] = false;
        if (progress) this[progress] = 0;
        writeStatus.call(this, this.t(i18n.interrupted), false);
        cfg.onNotFound?.call(this);
      },
      onError: (job) => {
        this[loading] = false;
        if (progress) this[progress] = 0;
        if (cfg.onError) { cfg.onError.call(this, job); return; }
        if (out) {
          this[out] = jobErrHtml.call(this, job);
          writeStatus.call(this, '', false);
        } else {
          this[status] = jobErrHtml.call(this, job);
        }
      },
      onDone: async (job) => {
        this[loading] = false;
        if (i18n.empty && job.result?.empty) {
          writeStatus.call(this, this.t(i18n.empty), false);
          if (cfg.resetProgressOnDone !== false && progress) this[progress] = 0;
          return;
        }
        if (cfg.render && out) {
          const html = cfg.render.call(this, job);
          if (html !== undefined) this[out] = html;
        }
        if (cfg.onDone) await cfg.onDone.call(this, job);
        if (cfg.resetProgressOnDone !== false && progress) {
          const delay = cfg.progressResetDelay || 0;
          if (delay > 0) setTimeout(() => { this[progress] = 0; }, delay);
          else this[progress] = 0;
        }
      },
    });
  };

  const run = async function () {
    const bookId = this.selectedBookId;
    this[loading] = true;
    if (progress) this[progress] = 0;
    this[show] = true;
    if (out) this[out] = '';
    writeStatus.call(this, this.t(i18n.starting), true);
    if (cfg.beforeRun) cfg.beforeRun.call(this);
    try {
      const { jobId } = await fetchJson(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg.buildPayload.call(this)),
      });
      localStorage.setItem(lsKeyFn(bookId, this), jobId);
      this[names.start](jobId);
    } catch (e) {
      console.error(`[${names.run}]`, e);
      if (out) {
        this[out] = errHtml.call(this, e);
        writeStatus.call(this, '', false);
      } else {
        this[status] = errHtml.call(this, e);
      }
      this[loading] = false;
      if (progress) this[progress] = 0;
    }
  };

  const toggle = async function () {
    if (this[show]) {
      if (cfg.onOpenWhenOpen) await cfg.onOpenWhenOpen.call(this);
      return;
    }
    this._closeOtherMainCards(cfg.closeCardKey);
    this[show] = true;
    if (cfg.onOpen) await cfg.onOpen.call(this);
    if (!this[timerProp] && !this[loading] && this.selectedBookId) {
      try {
        const { jobId } = await fetchJson(
          `/jobs/active?type=${activeType}&book_id=${this.selectedBookId}`
        );
        if (jobId) {
          this[loading] = true;
          if (progress) this[progress] = 0;
          if (out) this[out] = '';
          const spinner = i18n.alreadyRunningSpinner !== false;
          writeStatus.call(this, this.t(i18n.alreadyRunning), spinner);
          this[names.start](jobId);
        }
      } catch (e) {
        console.error(`[${names.toggle || 'toggle-' + cfg.name}] active-job check:`, e);
      }
    }
  };

  const methods = {};
  if (names.start)  methods[names.start]  = startPoll;
  if (names.run)    methods[names.run]    = run;
  if (names.toggle) methods[names.toggle] = toggle;
  return methods;
}

// Generische Job-Infrastruktur: Polling, Wiederaufnahme nach Tab-Wechsel,
// Job-Queue-Sichtbarkeit. Von jedem Feature-Modul via `this.` referenziert.
export const appJobsCoreMethods = {
  // Root-Wrapper: delegiert an die pure Helper (cards/job-helpers.js). Die
  // Sub-Komponenten rufen die Funktionen direkt, der Root nutzt weiter `this._startPoll(…)`.
  _startPoll(config) {
    return _startPollFn(this, config);
  },

  _fmtTok(n) { return fmtTok(n || 0); },

  // Root-Wrapper für Status-HTML. Sub-Komponenten nutzen runningJobStatus() direkt.
  _runningJobStatus(statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams) {
    return _runningJobStatusFn(
      (k, p) => this.t(k, p),
      statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams,
    );
  },

  async toggleJobStats() {
    this.showJobStats = !this.showJobStats;
    if (this.showJobStats) {
      try {
        const url = this.selectedBookId
          ? `/jobs/stats?book_id=${encodeURIComponent(this.selectedBookId)}`
          : '/jobs/stats';
        this.jobStats = await fetchJson(url);
      } catch (e) {
        console.error('[toggleJobStats]', e);
        this.jobStats = [];
      }
    }
  },

  _startJobQueuePoll() {
    if (this._jobQueueTimer) clearInterval(this._jobQueueTimer);
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        this.jobQueueItems = await fetchJson('/jobs/queue');
        consecutiveFailures = 0;
      } catch (e) {
        // Ein Setzer schlägt fehl, wenn der Server down ist oder die Session
        // abgelaufen ist – kein Grund für dauerndes Poll-Spam. Nach mehreren
        // Fehlern in Folge aussetzen; der Fehler bleibt via Logger sichtbar.
        consecutiveFailures++;
        console.error('[jobQueuePoll]', e);
        if (consecutiveFailures >= 5 && this._jobQueueTimer) {
          clearInterval(this._jobQueueTimer);
          this._jobQueueTimer = null;
        }
      }
    };
    poll();
    this._jobQueueTimer = setInterval(poll, 5000);
  },

  async cancelJob(jobId) {
    try {
      const res = await fetch('/jobs/' + jobId, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      this.jobQueueItems = this.jobQueueItems.filter(j => j.id !== jobId);
    } catch (e) {
      console.error('[cancelJob]', e);
      this.setStatus(this.t('app.jobCancelFailed'), false, 4000);
    }
  },

  navigateToJob(job) {
    const map = {
      'review':           'toggleBookReviewCard',
      'komplett-analyse': 'toggleFiguresCard',
      'kontinuitaet':     'toggleKontinuitaetCard',
      'batch-check':      'toggleTreeCard',
      'book-chat':        'toggleBookChatCard',
    };
    if (job.type === 'check') {
      const page = this.pages.find(p => String(p.id) === String(job.bookId));
      if (page) this.selectPage(page);
      return;
    }
    const method = map[job.type];
    if (method && this[method]) this[method]();
  },

  // Prüft ob ein gespeicherter Job noch läuft und reconnected ggf.
  // onRunning(job, jobId) wird aufgerufen wenn der Job aktiv ist.
  async _reconnectJob(lsKey, onRunning) {
    const jobId = localStorage.getItem(lsKey);
    if (!jobId) return;
    try {
      const resp = await fetch('/jobs/' + jobId);
      if (resp.ok) {
        const job = await resp.json();
        if (job.status === 'running') { onRunning(job, jobId); return; }
      }
    } catch { /* ignore */ }
    localStorage.removeItem(lsKey);
  },

  // Prüft beim Laden eines Buchs ob noch ein Job aus einer früheren Session läuft
  // (z.B. Tab versehentlich geschlossen während Analyse lief). Migrierte
  // Sub-Komponenten lauschen auf `job:reconnect { type, jobId, job, extra? }`
  // und stellen dort selbst ihren Loading/Progress/Status-State her.
  async checkPendingJobs(bookId) {
    await this._reconnectJob('lektorat_review_job_' + bookId, (job, jobId) => {
      this.showBookReviewCard = true;
      window.dispatchEvent(new CustomEvent('job:reconnect', {
        detail: { type: 'review', jobId, job },
      }));
    });

    // Kapitel-Review: nur einen laufenden Job pro Buch reconnecten – erste
    // Fundstelle gewinnt (Dedup läuft pro Kapitel, gleichzeitige Läufe sind rar).
    for (const item of (this.tree || [])) {
      if (item.type !== 'chapter') continue;
      const lsKey = `lektorat_chapter_review_job_${bookId}_${item.id}`;
      const jobIdLs = localStorage.getItem(lsKey);
      if (!jobIdLs) continue;
      let dispatched = false;
      await this._reconnectJob(lsKey, (job, jobId) => {
        this.showKapitelReviewCard = true;
        window.dispatchEvent(new CustomEvent('job:reconnect', {
          detail: { type: 'kapitel-review', jobId, job, extra: { chapterId: item.id } },
        }));
        dispatched = true;
      });
      if (dispatched) break;
    }

    await this._reconnectJob('lektorat_figures_job_' + bookId, (job, jobId) => {
      this.figurenLoading = true;
      this.figurenProgress = job.progress || 0;
      this.showFiguresCard = true;
      this.figurenStatus = job.statusText ? this.t(job.statusText, job.statusParams) : this.t('common.analysisRunning');
      this.startFiguresPoll(jobId);
    });

    await this._reconnectJob('lektorat_batchcheck_job_' + bookId, (job, jobId) => {
      this.batchLoading = true;
      this.batchProgress = job.progress || 0;
      this.batchStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
      this.startBatchPoll(jobId);
    });

    // Prüfen ob ein komplett-analyse Job vom Server noch läuft (z.B. Tab geschlossen)
    if (!this.alleAktualisierenLoading) {
      try {
        const { jobId, status, progress, statusText, statusParams } = await fetchJson(
          `/jobs/active?type=komplett-analyse&book_id=${bookId}`
        );
        if (jobId && (status === 'running' || status === 'queued')) {
          this.alleAktualisierenLoading = true;
          this.alleAktualisierenProgress = progress || 0;
          this.alleAktualisierenTokIn = 0;
          this.alleAktualisierenTokOut = 0;
          this.alleAktualisierenTps = null;
          this.alleAktualisierenStatus = statusText ? this.t(statusText, statusParams) : this.t('komplett.running');
          this.showKomplettStatus = true;
          this._startKomplettPoll(jobId, bookId);
        }
      } catch (e) { console.error('[checkPendingJobs komplett-active]', e); }
    }
  },
};
