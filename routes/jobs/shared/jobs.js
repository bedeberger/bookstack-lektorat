'use strict';
const { randomUUID } = require('crypto');
const logger = require('../../../logger');
const { insertJobRun, endJobRun } = require('../../../db/schema');
const { MAX_TOKENS_OUT } = require('../../../lib/ai');
const appSettings = require('../../../lib/app-settings');
const { jobs, runningJobs, jobAbortControllers, jobQueue, jobKey, jobDedupKey } = require('./state');
const { _scheduleJobCleanup } = require('./queue');
const { _modelName } = require('./model');
const jobLogBuffer = require('../../../lib/job-log-buffer');

// Job-Ctx (type/user/book) wird via ALS in `drainQueue` gesetzt – jeder
// `logger.*`-Call innerhalb der Job-Funktion erbt ihn automatisch.
// Der frühere Child-Logger ist damit überflüssig; die Funktion bleibt als
// reiner Pass-Through erhalten, damit die zahlreichen Aufruf-Sites
// (`const logger = makeJobLogger(jobId)`) unverändert weiterlaufen.
function makeJobLogger(_jobId) {
  return logger;
}

function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtDuration(seconds) {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function _jobDurationFmt(startedAt) {
  if (!startedAt) return '?';
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function _jobLogCtx(job) {
  return { job: job.type, user: job.userEmail, book: job.bookId, jobId: job.id };
}

function tps(tok) {
  return tok.ms > 0 ? tok.out / (tok.ms / 1000) : null;
}

/**
 * Baut einen Error, dessen `message` ein i18n-Key ist und der optionale Params trägt.
 * `failJob` liest diese Params und stellt sie dem Frontend als `errorParams` zur Verfügung,
 * damit `t(key, params)` die Meldung in der User-Locale rendern kann.
 */
function i18nError(key, params = null) {
  const err = new Error(key);
  if (params) err.i18nParams = params;
  return err;
}

/**
 * Helper: content-store-Errors mit `e.status` in i18nError-Form uebersetzen.
 * Job-Handler wrappen ihre content-store-Calls damit. Andere Fehler (Abort,
 * AssertionError, ...) werden unveraendert weitergeworfen.
 */
function contentHttpError(e) {
  if (e?.status) return i18nError('job.error.contentStore', { status: e.status, text: e.bodyText });
  return e;
}

/**
 * Liefert die jobId eines AKTIVEN (queued/running) Dedup-Matches oder null.
 * `runningJobs` hält Einträge auch nach Abschluss noch CLEANUP_DELAY_MS lang;
 * die nackte Map-Lookup würde abgeschlossene Jobs (status='done'/'error'/
 * 'cancelled') wie laufende behandeln und das Frontend pollt einen toten Job.
 */
function findActiveJobId(type, entityId, userEmail) {
  const id = runningJobs.get(jobKey(type, entityId, userEmail));
  if (!id) return null;
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'queued' || job.status === 'running') return id;
  return null;
}

function createJob(type, bookId, userEmail, label, labelParams = null, dedupId = null) {
  const id = randomUUID();
  const dedupValue = dedupId != null ? String(dedupId) : null;
  const key = jobKey(type, dedupValue ?? bookId, userEmail);
  const provider = String(appSettings.get('ai.provider') || 'claude').toLowerCase();
  let model = _modelName(provider);
  // Einzelne Job-Familien fahren ein eigenes Claude-Modell (Per-Job-Override in den
  // App-Settings, gespiegelt von _komplettClaudeOverrides bzw. _bookChatClaudeOverrides).
  // Dann muss job_runs.model das TATSÄCHLICH genutzte Modell spiegeln, nicht das globale —
  // sonst verbucht das Kosten-Tracking z.B. einen Opus-Lauf zum Sonnet-Default-Tarif.
  // Greift nur bei globalem Provider=claude (Override wird sonst ohnehin verworfen).
  if (provider === 'claude') {
    let overrideKey = null;
    if (type === 'komplett-analyse' || type === 'kontinuitaet') overrideKey = 'ai.claude.model.komplett';
    else if (type === 'book-chat') overrideKey = 'ai.claude.model.bookchat';
    if (overrideKey) {
      const overrideModel = String(appSettings.get(overrideKey) || '').trim();
      if (overrideModel) model = overrideModel;
    }
  }
  jobs.set(id, {
    id, type, bookId: String(bookId), dedupId: dedupValue, userEmail: userEmail || null,
    label: label || null,
    labelParams: labelParams || null,
    provider, model,
    status: 'queued', progress: 0, statusText: 'job.queued', statusParams: null,
    tokensIn: 0, tokensOut: 0, cacheReadIn: 0, cacheCreationIn: 0, cacheCreation1hIn: 0, tokensPerSec: null,
    maxTokensOut: MAX_TOKENS_OUT,
    result: null, error: null, errorParams: null,
    startedAt: null, endedAt: null,
    cancelled: false,
  });
  jobAbortControllers.set(id, new AbortController());
  try { insertJobRun({ id, type, bookId: String(bookId), userEmail, label, provider, model }); } catch (e) {
    logger.error(`insertJobRun: ${e.message}`, { job: type, user: userEmail, book: bookId });
  }
  runningJobs.set(key, id);
  return id;
}

function updateJob(id, updates) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return;
  // statusText-Setzer dürfen statusParams gezielt zurücksetzen: wenn nur
  // statusText gesetzt wird, wird ein evtl. alter statusParams geleert,
  // damit Platzhalter aus älteren Meldungen nicht nachwirken.
  if ('statusText' in updates && !('statusParams' in updates)) {
    updates = { ...updates, statusParams: null };
  }
  if (updates.progress != null && updates.progress < (job.progress || 0)) {
    // Parallel-Branch mit niedrigerem Fortschritt darf progress nicht zurücksetzen,
    // statusText darf aber aktualisiert werden – der User sieht so, was gerade läuft.
    const { progress: _, ...rest } = updates;
    Object.assign(job, rest);
  } else {
    Object.assign(job, updates);
  }
}

function completeJob(id, result, tokensPerSec = null, detail = null) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, { status: 'done', progress: 100, result, tokensPerSec, endedAt: new Date().toISOString() });
  try {
    endJobRun(id, 'done', job.tokensIn, job.tokensOut, job.cacheReadIn, job.cacheCreationIn, job.cacheCreation1hIn, tokensPerSec, null);
  } catch (e) {
    logger.error(`endJobRun: ${e.message}`, _jobLogCtx(job));
  }
  // Zentrales Done-Log — ALS-Ctx liefert [type|user|book|jobId8].
  // Job-Module geben semantisches Detail (Note, Pages, Beanstandungen…) als 4. Arg mit.
  const cacheSeg = (job.cacheReadIn || job.cacheCreationIn)
    ? ` cache=${fmtTok(job.cacheReadIn)}r/${fmtTok(job.cacheCreationIn)}w`
    : '';
  const detailSeg = detail ? `${detail}, ` : '';
  logger.info(
    `Fertig (${_jobDurationFmt(job.startedAt)}, ${detailSeg}${fmtTok(job.tokensIn)}↑ ${fmtTok(job.tokensOut)}↓${cacheSeg}, ${job.provider}/${job.model})`,
    _jobLogCtx(job),
  );
  runningJobs.delete(jobDedupKey(job));
  jobAbortControllers.delete(id);
  _scheduleJobCleanup(id);
  jobLogBuffer.clear(id);
  if (job.userEmail) {
    const notify = require('../../../lib/notify');
    notify.maybeNotifyBudgetOverrun(job.userEmail)
      .catch(e => logger.warn(`notify budget: ${e.message}`, _jobLogCtx(job)));
  }
}

function failJob(id, err) {
  const job = jobs.get(id);
  if (!job) return;
  const isCancelled = job.cancelled || err?.name === 'AbortError';
  const status = isCancelled ? 'cancelled' : 'error';
  const errorMsg = isCancelled ? 'job.cancelled' : (err.message || String(err));
  const errorParams = isCancelled ? null : (err?.i18nParams || null);
  Object.assign(job, { status, error: errorMsg, errorParams, progress: isCancelled ? job.progress : 0, endedAt: new Date().toISOString() });
  try {
    endJobRun(id, status, job.tokensIn, job.tokensOut, job.cacheReadIn, job.cacheCreationIn, job.cacheCreation1hIn, null, errorMsg, errorParams);
  } catch (e) {
    logger.error(`endJobRun: ${e.message}`, _jobLogCtx(job));
  }
  // Zentrales Terminal-Log: Cancellation als info, echte Fehler als warn
  // (Job-Modul hat ggf. bereits ein Error mit Stack geschrieben).
  if (isCancelled) {
    logger.info(`Abgebrochen (${_jobDurationFmt(job.startedAt)})`, _jobLogCtx(job));
  } else {
    logger.warn(`Fehlgeschlagen (${_jobDurationFmt(job.startedAt)}): ${errorMsg}`, _jobLogCtx(job));
  }
  // Log-Snapshot + Stack synchron auf job stashen, BEVOR Buffer geleert wird;
  // notify-Pfad ist async fire-and-forget und liest die Felder aus job.
  job._logExcerpt = jobLogBuffer.snapshot(id);
  job._errorStack = (err && typeof err.stack === 'string') ? err.stack : null;
  runningJobs.delete(jobDedupKey(job));
  jobAbortControllers.delete(id);
  _scheduleJobCleanup(id);
  jobLogBuffer.clear(id);
  if (!isCancelled) {
    const notify = require('../../../lib/notify');
    const httpStatus = (err && typeof err.status === 'number') ? err.status : null;
    if (errorMsg === 'job.error.aiTruncated') {
      notify.maybeNotifyTokenCapHit(job, errorMsg)
        .catch(e => logger.warn(`notify token-cap: ${e.message}`, _jobLogCtx(job)));
    } else {
      notify.maybeNotifyJobFailed(job, errorMsg, httpStatus)
        .catch(e => logger.warn(`notify job-fail: ${e.message}`, _jobLogCtx(job)));
    }
    if (job.userEmail) {
      notify.maybeNotifyBudgetOverrun(job.userEmail)
        .catch(e => logger.warn(`notify budget: ${e.message}`, _jobLogCtx(job)));
    }
  }
}

function cancelJob(id, userEmail) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.userEmail !== (userEmail || null)) return false;
  if (job.status === 'queued') {
    const idx = jobQueue.findIndex(e => e.jobId === id);
    if (idx !== -1) jobQueue.splice(idx, 1);
    Object.assign(job, { status: 'cancelled', error: 'job.cancelled', errorParams: null, endedAt: new Date().toISOString() });
    try { endJobRun(id, 'cancelled', 0, 0, 0, 0, 0, null, 'Abgebrochen'); } catch (e) {
      logger.error(`endJobRun: ${e.message}`, { job: job.type, user: job.userEmail, book: job.bookId });
    }
    runningJobs.delete(jobDedupKey(job));
    jobAbortControllers.delete(id);
    _scheduleJobCleanup(id);
    jobLogBuffer.clear(id);
    logger.info('Aus Warteschlange entfernt und abgebrochen.', _jobLogCtx(job));
    return true;
  }
  if (job.status === 'running') {
    job.cancelled = true;
    const ctrl = jobAbortControllers.get(id);
    if (ctrl) ctrl.abort();
    logger.info('Abbruch signalisiert.', _jobLogCtx(job));
    return true;
  }
  return false;
}

// ── Statistik-Konfiguration ───────────────────────────────────────────────────
// Werte sind i18n-Keys; Frontend übersetzt über t().
const JOB_TYPE_LABELS = {
  'check':                 'job.label.check',
  'batch-check':           'job.label.batchCheck',
  'komplett-analyse':      'job.label.komplett',
  'review':                'job.label.review',
  'chapter-review':        'job.label.chapterReview',
  'book-chat':             'job.label.bookChat',
  'chat':                  'job.label.chat',
  'synonym':               'job.label.synonym',
  'finetune-export':       'job.label.finetuneExport',
  'folder-import':         'job.label.folderImport',
  'geocode-resolve':       'job.label.geocodeResolveType',
  'pdf-export':            'job.label.pdfExport',
  'epub-export':           'job.label.epubExport',
  'book-import':           'job.label.bookImport',
  'blog-import':           'job.label.blogImport',
  'blog-pull':             'job.label.blogPull',
  'blog-push':             'job.label.blogPush',
  'blog-reconcile':        'job.label.blogReconcile',
  'hubspot-import':        'job.label.hubspotImport',
  'hubspot-push':          'job.label.hubspotPush',
  'hubspot-reconcile':     'job.label.hubspotReconcile',
  'werkstatt-brainstorm':  'job.label.werkstattBrainstorm',
  'werkstatt-consistency': 'job.label.werkstattConsistency',
  'plot-brainstorm':       'job.label.plotBrainstormType',
  'plot-consistency':      'job.label.plotConsistency',
  'docx-export':           'job.label.docxExport',
  'embed-index':           'job.label.embedIndex',
  'motif-scan':            'job.label.motivScan',
  'motif-brainstorm':      'job.label.motivBrainstorm',
  'beat-anchor':           'job.label.beatAnchor',
  'erzaehlprofil':         'job.label.erzaehlprofil',
  'faktencheck':           'job.label.faktencheck',
  'redundancy':            'job.label.redundancy',
  'research-chat':         'job.label.researchChat',
  'research-link':         'job.label.researchLink',
  'rueckblick':            'job.label.rueckblick',
  'source-detect':         'job.label.sourceDetect',
  'stilprofil':            'job.label.stilprofil',
};

// Job-Typen, die vom Superjob (komplett-analyse) abgedeckt werden und nicht in der Statistik erscheinen sollen
const STATS_EXCLUDED_TYPES = ['figures', 'soziogramm', 'szenen', 'locations', 'figure-events', 'consolidate-zeitstrahl', 'kontinuitaet'];

module.exports = {
  makeJobLogger,
  fmtTok, fmtDuration, _jobDurationFmt, _jobLogCtx, tps,
  i18nError, contentHttpError,
  findActiveJobId,
  createJob, updateJob, completeJob, failJob, cancelJob,
  JOB_TYPE_LABELS, STATS_EXCLUDED_TYPES,
};
