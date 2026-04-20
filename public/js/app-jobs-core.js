import { escHtml, fmtTok, fetchJson } from './utils.js';

// Generische Job-Infrastruktur: Polling, Wiederaufnahme nach Tab-Wechsel,
// Job-Queue-Sichtbarkeit. Von jedem Feature-Modul via `this.` referenziert.
export const appJobsCoreMethods = {
  // Generischer Job-Poller.
  // config: { timerProp, jobId, lsKey?, progressProp?, onProgress, onNotFound, onError, onDone }
  _startPoll(config) {
    if (this[config.timerProp]) clearInterval(this[config.timerProp]);
    this[config.timerProp] = setInterval(async () => {
      try {
        const resp = await fetch('/jobs/' + config.jobId);
        if (resp.status === 404) {
          clearInterval(this[config.timerProp]);
          this[config.timerProp] = null;
          if (config.lsKey) localStorage.removeItem(config.lsKey);
          config.onNotFound?.();
          return;
        }
        if (!resp.ok) return;
        const job = await resp.json();
        if (config.progressProp) this[config.progressProp] = job.progress || 0;
        if (job.status === 'running' || job.status === 'queued') { config.onProgress?.(job); return; }
        clearInterval(this[config.timerProp]);
        this[config.timerProp] = null;
        if (config.lsKey) localStorage.removeItem(config.lsKey);
        if (job.status === 'cancelled') { await config.onError?.(job); return; }
        if (job.status === 'error') await config.onError?.(job);
        else await config.onDone?.(job);
      } catch (e) { console.error('[poll ' + config.timerProp + ']', e); }
    }, 2000);
  },

  _fmtTok(n) { return fmtTok(n || 0); },

  // Generiertes Status-HTML für laufende Jobs: Spinner + statusText + Token-Info.
  // Wird von review.js, figuren.js und lektorat.js (batchCheck) verwendet.
  _runningJobStatus(statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams) {
    let tokInfo = '';
    if ((tokIn || 0) + (tokOut || 0) > 0) {
      const pctPart = (progress > 0 && progress < 100) ? ` ~${progress}%` : '';
      const tpsPart = tokPerSec ? ` · ${Math.round(tokPerSec)} tok/s` : '';
      const inPart = (tokIn || 0) > 0 ? `↑${fmtTok(tokIn)} ` : '';
      tokInfo = ` · ${inPart}↓${fmtTok(tokOut || 0)} Tokens${pctPart}${tpsPart}`;
    }
    // statusText kann ein i18n-Key sein (z.B. 'job.phase.extracting') oder freier Text.
    // tRaw gibt unbekannte Keys 1:1 zurück, damit Legacy-Text pass-through funktioniert.
    const label = statusText ? this.t(statusText, statusParams) : '…';
    return `<span class="spinner"></span>${escHtml(label)}${tokInfo}`;
  },

  async toggleJobStats() {
    this.showJobStats = !this.showJobStats;
    if (this.showJobStats) {
      try {
        this.jobStats = await fetchJson('/jobs/stats');
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
  // (z.B. Tab versehentlich geschlossen während Analyse lief).
  async checkPendingJobs(bookId) {
    await this._reconnectJob('lektorat_review_job_' + bookId, (job, jobId) => {
      this.bookReviewLoading = true;
      this.bookReviewProgress = job.progress || 0;
      this.showBookReviewCard = true;
      this.bookReviewOut = '';
      this.setReviewStatus(job.statusText ? this.t(job.statusText, job.statusParams) : this.t('common.analysisRunning'), true);
      this.startReviewPoll(jobId);
    });

    // Kapitel-Review: nur einen laufenden Job pro Buch reconnecten – erste
    // Fundstelle gewinnt (Dedup läuft pro Kapitel, gleichzeitige Läufe sind rar).
    for (const item of (this.tree || [])) {
      if (item.type !== 'chapter') continue;
      const lsKey = `lektorat_chapter_review_job_${bookId}_${item.id}`;
      const jobIdLs = localStorage.getItem(lsKey);
      if (!jobIdLs) continue;
      await this._reconnectJob(lsKey, (job, jobId) => {
        this.kapitelReviewLoading = true;
        this.kapitelReviewProgress = job.progress || 0;
        this.kapitelReviewChapterId = String(item.id);
        this._kapitelReviewRunningChapterId = String(item.id);
        this.showKapitelReviewCard = true;
        this.kapitelReviewOut = '';
        this.setKapitelReviewStatus(job.statusText ? this.t(job.statusText, job.statusParams) : this.t('common.analysisRunning'), true);
        this.startKapitelReviewPoll(jobId, item.id);
      });
      if (this._kapitelReviewPollTimer) break;
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
