// Card-Variante von createJobFeature. `show` lebt am Root (Single Source of
// Truth für Hash-Router), alle anderen Felder lokal auf der Card. Root-Zugriffe
// gehen über window.__app. Kein toggle() — die Root-Methode toggleXxxCard()
// setzt nur das Flag.

import { fetchJson, escHtml } from '../utils.js';
import { startPoll, runningJobStatus } from './job-helpers.js';

// cfg:
//   name              — logischer Feature-Name (z. B. 'review').
//   endpoint          — POST-Ziel, z. B. '/jobs/review'.
//   activeType        — Override für /jobs/active?type=…; Default = name.
//   timerProp         — z. B. '_reviewPollTimer' (lokal auf der Sub).
//   methodNames       — { start, run }.
//   fields            — { show, loading, progress, status, out?, result? }.
//                       `show` wird auf $root angewendet, die anderen lokal.
//   lsKey             — optional: (bookId, self) => string.
//   i18n              — { starting, interrupted, alreadyRunning,
//                         alreadyRunningSpinner?, empty? }.
//   buildPayload      — (self) => body-Objekt.
//   render            — (job, self) => html für `fields.out`.
//   onDone            — async (job, self) => void.
//   onError           — (job, self) => void.
//   onNotFound        — (self) => void.
//   onOpen            — async (self) => void — vom $watch(show) der Sub getriggert.
//   beforeRun         — (self) => void.
//   resetProgressOnDone — bool (Default: true).
//   progressResetDelay  — ms (Default: 0).
export function createCardJobFeature(cfg) {
  const { show, loading, progress, status, out } = cfg.fields;
  const timerProp  = cfg.timerProp;
  const activeType = cfg.activeType || cfg.name;
  const lsKeyFn    = cfg.lsKey || ((bookId) => `lektorat_${cfg.name}_job_${bookId}`);
  const names      = cfg.methodNames;
  const i18n       = cfg.i18n || {};

  function writeStatus(msg, spinner) {
    const safe = escHtml(msg);
    this[status] = spinner ? `<span class="spinner"></span>${safe}` : safe;
  }
  function jobErrHtml(job) {
    return `<span class="error-msg">${window.__app.t('common.errorColon')}${escHtml(window.__app.t(job.error, job.errorParams))}</span>`;
  }
  function errHtml(err) {
    return `<span class="error-msg">${window.__app.t('common.errorColon')}${escHtml(err.message)}</span>`;
  }

  const startPollMethod = function (jobId) {
    const bookId = window.__app.selectedBookId;
    startPoll(this, {
      timerProp,
      jobId,
      lsKey: lsKeyFn(bookId, this),
      progressProp: progress,
      onProgress: (job) => {
        this[status] = runningJobStatus(
          (k, p) => window.__app.t(k, p),
          job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
          job.progress, job.tokensPerSec, job.statusParams,
        );
      },
      onNotFound: () => {
        this[loading] = false;
        if (progress) this[progress] = 0;
        writeStatus.call(this, window.__app.t(i18n.interrupted), false);
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
          writeStatus.call(this, window.__app.t(i18n.empty), false);
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

  const runMethod = async function () {
    const bookId = window.__app.selectedBookId;
    this[loading] = true;
    if (progress) this[progress] = 0;
    if (show) window.__app[show] = true;
    if (out) this[out] = '';
    writeStatus.call(this, window.__app.t(i18n.starting), true);
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

  // Wird beim $watch($root[show]) von der Sub aufgerufen, wenn die Karte offen.
  // Prüft, ob bereits ein Job serverseitig läuft — dann reconnecten. Sonst
  // cfg.onOpen für Erst-Initialisierung (z.B. History laden).
  const onVisibleMethod = async function () {
    if (cfg.onOpen) await cfg.onOpen.call(this);
    if (!this[timerProp] && !this[loading] && window.__app.selectedBookId) {
      try {
        const { jobId } = await fetchJson(
          `/jobs/active?type=${activeType}&book_id=${window.__app.selectedBookId}`
        );
        if (jobId) {
          this[loading] = true;
          if (progress) this[progress] = 0;
          if (out) this[out] = '';
          const spinner = i18n.alreadyRunningSpinner !== false;
          writeStatus.call(this, window.__app.t(i18n.alreadyRunning), spinner);
          this[names.start](jobId);
        }
      } catch (e) {
        console.error(`[onVisible-${cfg.name}] active-job check:`, e);
      }
    }
  };

  const methods = {};
  if (names.start) methods[names.start] = startPollMethod;
  if (names.run)   methods[names.run]   = runMethod;
  if (names.onVisible) methods[names.onVisible] = onVisibleMethod;
  return methods;
}
