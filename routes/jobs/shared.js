'use strict';
const express = require('express');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const logger = require('../../logger');
const { db, insertJobRun, startJobRun, endJobRun, getBookLocale, getAllUserTokens } = require('../../db/schema');
const { callAI, parseJSON, CHARS_PER_TOKEN } = require('../../lib/ai');

// prompt-config.json synchron lesen (einmalig bei Modulstart); fehlt die Datei, bricht der Server ab.
const _promptConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../prompt-config.json'), 'utf8'));

// System-Prompts aus dem Browser-Modul laden (Single Source of Truth: public/js/prompts.js)
let _prompts = null;
async function getPrompts() {
  if (!_prompts) {
    _prompts = await import(pathToFileURL(path.resolve(__dirname, '../../public/js/prompts.js')).href);
    _prompts.configurePrompts(_promptConfig);
  }
  return _prompts;
}

/**
 * Gibt das Locale-Prompts-Objekt für ein Buch zurück.
 * Liest Sprache+Region aus book_settings, fällt auf de-CH zurück wenn nicht konfiguriert.
 * @param {number|string} bookId
 */
async function getBookPrompts(bookId) {
  const { getLocalePrompts } = await getPrompts();
  const locale = bookId ? getBookLocale(bookId) : 'de-CH';
  return getLocalePrompts(locale);
}

const jsonBody = express.json();
const jsonBodyLarge = express.json({ limit: '5mb' });

// ── Job store ─────────────────────────────────────────────────────────────────
// key: jobId → { id, type, bookId, status, progress, statusText, result, error }
const jobs = new Map();
// key: `${type}:${bookId}:${userEmail}` → jobId  (verhindert Doppel-Starts)
const runningJobs = new Map();
// key: jobId → AbortController  (für Job-Abbruch)
const jobAbortControllers = new Map();

function makeJobLogger(jobId) {
  const j = jobs.get(jobId);
  if (!j) return logger;
  return logger.child({ job: j.type, user: j.userEmail || '-', book: j.bookId });
}

// ── Globale Queue ─────────────────────────────────────────────────────────────
// Maximale Anzahl gleichzeitig laufender Jobs (über alle User)
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_JOBS, 10) || 2;
let activeCount = 0;
const jobQueue = []; // { jobId, fn }

function drainQueue() {
  while (activeCount < MAX_CONCURRENT && jobQueue.length > 0) {
    const { jobId, fn } = jobQueue.shift();
    const job = jobs.get(jobId);
    if (!job) continue; // Job wurde zwischenzeitlich entfernt
    activeCount++;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try { startJobRun(jobId, job.startedAt); } catch (e) { logger.error(`[${job.type}|${job.userEmail || '-'}|${job.bookId}] startJobRun: ${e.message}`); }
    fn()
      .catch(e => logger.error(`[${job.type}|${job.userEmail || '-'}|${job.bookId}] Unkontrollierter Job-Fehler (${jobId}): ${e.message}`))
      .finally(() => { activeCount--; drainQueue(); });
  }
}

function enqueueJob(jobId, fn) {
  jobQueue.push({ jobId, fn });
  drainQueue();
}

function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function jobKey(type, bookId, userEmail) {
  return `${type}:${bookId}:${userEmail || ''}`;
}

function createJob(type, bookId, userEmail, label) {
  const id = randomUUID();
  const key = jobKey(type, bookId, userEmail);
  jobs.set(id, {
    id, type, bookId: String(bookId), userEmail: userEmail || null,
    label: label || null,
    status: 'queued', progress: 0, statusText: 'In Warteschlange…',
    tokensIn: 0, tokensOut: 0, tokensPerSec: null,
    maxTokensOut: parseInt(process.env.MODEL_TOKEN, 10) || 64000,
    result: null, error: null,
    startedAt: null, endedAt: null,
    cancelled: false,
  });
  jobAbortControllers.set(id, new AbortController());
  try { insertJobRun({ id, type, bookId: String(bookId), userEmail, label }); } catch (e) { logger.error(`[${type}|${userEmail || '-'}|${bookId}] insertJobRun: ${e.message}`); }
  runningJobs.set(key, id);
  // Auto-Cleanup nach 2 Stunden
  setTimeout(() => {
    jobs.delete(id);
    if (runningJobs.get(key) === id) runningJobs.delete(key);
  }, 7200000);
  return id;
}

function updateJob(id, updates) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return;
  if (updates.progress != null && updates.progress < (job.progress || 0)) {
    // Parallel-Branch mit niedrigerem Fortschritt darf progress nicht zurücksetzen,
    // statusText darf aber aktualisiert werden – der User sieht so, was gerade läuft.
    const { progress: _, ...rest } = updates;
    Object.assign(job, rest);
  } else {
    Object.assign(job, updates);
  }
}

function tps(tok) {
  return tok.ms > 0 ? tok.out / (tok.ms / 1000) : null;
}

function completeJob(id, result, tokensPerSec = null) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, { status: 'done', progress: 100, result, tokensPerSec, endedAt: new Date().toISOString() });
  try { endJobRun(id, 'done', job.endedAt, job.tokensIn, job.tokensOut, tokensPerSec, null); } catch (e) { logger.error(`[${job.type}|${job.userEmail || '-'}|${job.bookId}] endJobRun: ${e.message}`); }
  runningJobs.delete(jobKey(job.type, job.bookId, job.userEmail));
  jobAbortControllers.delete(id);
}

function failJob(id, err) {
  const job = jobs.get(id);
  if (!job) return;
  const isCancelled = job.cancelled || err?.name === 'AbortError';
  const status = isCancelled ? 'cancelled' : 'error';
  const errorMsg = isCancelled ? 'Abgebrochen' : (err.message || String(err));
  Object.assign(job, { status, error: errorMsg, progress: isCancelled ? job.progress : 0, endedAt: new Date().toISOString() });
  try { endJobRun(id, status, job.endedAt, job.tokensIn, job.tokensOut, null, errorMsg); } catch (e) { logger.error(`[${job.type}|${job.userEmail || '-'}|${job.bookId}] endJobRun: ${e.message}`); }
  runningJobs.delete(jobKey(job.type, job.bookId, job.userEmail));
  jobAbortControllers.delete(id);
}

function cancelJob(id, userEmail) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.userEmail !== (userEmail || null)) return false;
  if (job.status === 'queued') {
    const idx = jobQueue.findIndex(e => e.jobId === id);
    if (idx !== -1) jobQueue.splice(idx, 1);
    const endedAt = new Date().toISOString();
    Object.assign(job, { status: 'cancelled', error: 'Abgebrochen', endedAt });
    try { endJobRun(id, 'cancelled', endedAt, 0, 0, null, 'Abgebrochen'); } catch (e) { logger.error(`[${job.type}|${job.userEmail || '-'}|${job.bookId}] endJobRun: ${e.message}`); }
    runningJobs.delete(jobKey(job.type, job.bookId, job.userEmail));
    jobAbortControllers.delete(id);
    logger.info(`Job ${id} (${job.type}|${job.userEmail || '-'}|${job.bookId}) aus Warteschlange entfernt und abgebrochen.`);
    return true;
  }
  if (job.status === 'running') {
    job.cancelled = true;
    const ctrl = jobAbortControllers.get(id);
    if (ctrl) ctrl.abort();
    logger.info(`Job ${id} (${job.type}|${job.userEmail || '-'}|${job.bookId}) Abbruch signalisiert.`);
    return true;
  }
  return false;
}

// Gibt den konfigurierten Modellnamen für den angegebenen Provider zurück.
function _modelName(prov) {
  if (prov === 'ollama') return process.env.OLLAMA_MODEL || 'llama3.2';
  if (prov === 'llama')  return process.env.LLAMA_MODEL  || 'llama3.2';
  return process.env.MODEL_NAME || 'claude-sonnet-4-6';
}

// ── Lokaler-Provider-kompatibler Promise.allSettled-Ersatz ────────────────────
// Ollama und Llama verarbeiten Requests sequenziell. Bei parallelen Calls mit
// grossem Kontext läuft der VRAM voll → fetch failed. Daher serialisieren.
async function settledAll(thunks) {
  if ((process.env.API_PROVIDER || 'claude') === 'claude')
    return Promise.allSettled(thunks.map(fn => fn()));
  const results = [];
  for (const fn of thunks) {
    try { results.push({ status: 'fulfilled', value: await fn() }); }
    catch (e) {
      if (e.name === 'AbortError') throw e;
      results.push({ status: 'rejected', reason: e });
    }
  }
  return results;
}

// ── BookStack-Helfer ──────────────────────────────────────────────────────────
const BS_URL = (process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80').replace(/\/$/, '');

async function bsGet(path, userToken) {
  const auth = userToken
    ? `Token ${userToken.id}:${userToken.pw}`
    : `Token ${process.env.TOKEN_ID || ''}:${process.env.TOKEN_KENNWORT || ''}`;
  const resp = await fetch(`${BS_URL}/api/${path}`, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`BookStack ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function bsGetAll(path, userToken) {
  let offset = 0;
  const all = [];
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await bsGet(`${path}${sep}count=500&offset=${offset}`, userToken);
    const items = data.data || [];
    all.push(...items);
    if (all.length >= (data.total || 0) || !items.length) break;
    offset += items.length;
  }
  return all;
}

function htmlToText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

const SINGLE_PASS_LIMIT = 60000;
const BATCH_SIZE = 15;

async function loadPageContents(pages, chMap, minLength, onBatch, userToken, signal = null) {
  const contents = [];
  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (onBatch) onBatch(i, pages.length);
    const results = await Promise.allSettled(pages.slice(i, i + BATCH_SIZE).map(async p => {
      const pd = await bsGet('pages/' + p.id, userToken);
      const text = htmlToText(pd.html).trim();
      if (text.length < minLength) return null;
      return {
        title: p.name,
        chapter_id: p.chapter_id || null,
        chapter: p.chapter_id ? (chMap[p.chapter_id] || 'Kapitel') : null,
        text,
      };
    }));
    for (const r of results) if (r.status === 'fulfilled' && r.value) contents.push(r.value);
  }
  return contents;
}

function groupByChapter(pageContents) {
  const groupOrder = [], groups = new Map();
  for (const p of pageContents) {
    const key = p.chapter_id != null ? String(p.chapter_id) : '__ungrouped__';
    if (!groups.has(key)) { groupOrder.push(key); groups.set(key, { name: p.chapter || 'Sonstige Seiten', pages: [] }); }
    groups.get(key).pages.push(p);
  }
  return { groupOrder, groups };
}

// Formatiert den Buchtext für Single-Pass-KI-Calls mit klarer Kapitelstruktur:
// ## Kapitelname als Abschnittsmarker, ### Seitentitel innerhalb.
// Die KI kann so kapitel-Felder zuverlässig aus dem ## Header ableiten.
function buildSinglePassBookText(groups, groupOrder) {
  return groupOrder
    .map(key => {
      const group = groups.get(key);
      return `## ${group.name}\n\n` +
        group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
    })
    .join('\n\n===\n\n');
}

// Hilfsfunktion: callAI aufrufen, Token-Zähler akkumulieren, Job aktualisieren.
// fromPct/toPct: optionaler Fortschrittsbereich – während des Streamings wird der Balken
// von fromPct auf toPct gefüllt (basierend auf akkumulierten Output-Zeichen vs. dynExpectedChars).
// outputRatio: erwartetes Output/Input-Verhältnis für dynamische Recalibrierung (Default 0.2).
//   Sobald tokIn bekannt ist (Claude: message_start; Ollama: erster Chunk), wird dynExpectedChars
//   auf max(staticFallback, tokIn * 4 * outputRatio) gesetzt.
// maxTokens: explizites Token-Limit (überschreibt die expectedChars-Formel). null = globalMax.
async function aiCall(jobId, tok, prompt, system, fromPct, toPct, expectedChars = 3000, outputRatio = 0.2, maxTokens = null, provider = undefined) {
  let dynExpectedChars = expectedChars;
  let calibrated = false;
  // Eindeutige ID für diesen Call – wird in tok.inflight eingetragen wenn vorhanden
  // (tok.inflight ist ein Map, der nur vom komplett-analyse-Job gesetzt wird, damit
  // bei parallelen Kapitel-Calls die Live-Anzeige alle in-flight-Tokens summiert.)
  const callId = Symbol();
  const onProgress = ({ chars, tokIn }) => {
    const updates = {};
    // Einmalige Recalibrierung sobald tokIn bekannt ist
    if (!calibrated && tokIn > 0) {
      dynExpectedChars = Math.max(expectedChars, Math.round(tokIn * 4 * outputRatio));
      calibrated = true;
    }
    // Fortschrittsbalken auf Basis akkumulierter Zeichen
    if (fromPct != null && toPct != null) {
      updates.progress = Math.round(fromPct + (toPct - fromPct) * Math.min(1, chars / dynExpectedChars));
    }
    // Live-Token-Anzeige: tok.in/tok.out = bisherige abgeschlossene Calls.
    // Wenn tok.inflight vorhanden (parallele Calls), werden alle in-flight-Tokens
    // aller laufenden Calls summiert – sonst nur der aktuelle Call.
    if (tok.inflight) {
      const entry = tok.inflight.get(callId) || { tokIn: 0, outEst: 0 };
      tok.inflight.set(callId, {
        tokIn:   tokIn > 0  ? tokIn              : entry.tokIn,
        outEst:  chars > 0  ? Math.floor(chars / CHARS_PER_TOKEN) : entry.outEst,
      });
      const vals = [...tok.inflight.values()];
      if (tokIn > 0) updates.tokensIn  = tok.in  + vals.reduce((s, v) => s + v.tokIn,  0);
      if (chars > 0) updates.tokensOut = tok.out + vals.reduce((s, v) => s + v.outEst, 0);
    } else {
      if (tokIn > 0) updates.tokensIn  = tok.in  + tokIn;
      if (chars > 0) updates.tokensOut = tok.out + Math.floor(chars / CHARS_PER_TOKEN);
    }
    if (Object.keys(updates).length) updateJob(jobId, updates);
  };
  const globalMax = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
  const maxTokensOverride = maxTokens != null
    ? Math.min(maxTokens, globalMax)
    : globalMax;
  const signal = jobAbortControllers.get(jobId)?.signal;
  const { text, truncated, tokensIn, tokensOut, genDurationMs } = await callAI(prompt, system, onProgress, maxTokensOverride, signal, provider);
  tok.inflight?.delete(callId);
  tok.in += tokensIn;
  tok.out += tokensOut;
  if (genDurationMs != null) tok.ms += genDurationMs;
  const liveTps = tok.ms > 0 ? tok.out / (tok.ms / 1000) : null;
  updateJob(jobId, { tokensIn: tok.in, tokensOut: tok.out, tokensPerSec: liveTps });
  if (truncated) throw new Error(`KI-Antwort wurde bei ${maxTokensOverride} max_tokens abgeschnitten (tokIn=${tokensIn}, tokOut=${tokensOut}, total=${tokensIn + tokensOut}). JSON ist unvollständig.`);
  return parseJSON(text);
}

// ── Statistik-Konfiguration ───────────────────────────────────────────────────
const JOB_TYPE_LABELS = {
  'check':            'Lektorat',
  'batch-check':      'Stapel-Check',
  'komplett-analyse': 'Komplettanalyse',
  'review':           'Buchbewertung',
  'book-chat':        'Buch-Chat',
  'chat':             'Seiten-Chat',
};

function fmtDuration(seconds) {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function fmtLastRun(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  const now = new Date();
  const time = d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  // Mitternacht in lokaler Zeitzone vergleichen, nicht rohe ms-Differenz
  const dDay  = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today - dDay) / 86400000);
  if (diffDays === 0) return `heute, ${time}`;
  if (diffDays === 1) return `gestern, ${time}`;
  if (diffDays < 7) return `vor ${diffDays} Tagen, ${time}`;
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' }) + `, ${time}`;
}

// Job-Typen, die vom Superjob (komplett-analyse) abgedeckt werden und nicht in der Statistik erscheinen sollen
const STATS_EXCLUDED_TYPES = ['figures', 'soziogramm', 'szenen', 'locations', 'figure-events', 'consolidate-zeitstrahl', 'kontinuitaet'];

// ── Shared-Router: Job-Status, Queue, Statistiken ─────────────────────────────
// Diese Routen sind job-typ-übergreifend und müssen NACH allen Feature-Routen gemountet werden,
// weil GET /:id und DELETE /:id als Catch-All wirken.
const sharedRouter = express.Router();

sharedRouter.get('/queue', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const result = [];
  for (const [, job] of jobs) {
    if (job.userEmail !== userEmail) continue;
    if (job.status !== 'queued' && job.status !== 'running') continue;
    let statusText = job.statusText;
    if (job.status === 'queued') {
      const pos = jobQueue.findIndex(e => e.jobId === job.id) + 1;
      statusText = pos > 0 ? `Warteschlange #${pos}` : 'Warteschlange';
    }
    result.push({
      id: job.id,
      type: job.type,
      label: job.label || job.type,
      status: job.status,
      progress: job.progress,
      statusText,
      canCancel: true,
    });
  }
  res.json(result);
});

sharedRouter.get('/stats', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const placeholders = STATS_EXCLUDED_TYPES.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      type,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS count,
      AVG(CASE WHEN status = 'done' AND started_at IS NOT NULL AND ended_at IS NOT NULL
          THEN (julianday(ended_at) - julianday(started_at)) * 86400 ELSE NULL END) AS avgDuration,
      MAX(CASE WHEN status = 'done' THEN ended_at ELSE NULL END) AS lastRun,
      AVG(CASE WHEN status = 'done' THEN tokens_in  ELSE NULL END) AS avgTokensIn,
      AVG(CASE WHEN status = 'done' THEN tokens_out ELSE NULL END) AS avgTokensOut,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errorCount
    FROM job_runs
    WHERE user_email = ? AND type NOT IN (${placeholders})
    GROUP BY type
    ORDER BY lastRun IS NULL, lastRun DESC
  `).all(userEmail, ...STATS_EXCLUDED_TYPES);

  const result = rows.map(r => ({
    type:         r.type,
    typeLabel:    JOB_TYPE_LABELS[r.type] || r.type,
    count:        r.count || 0,
    errorCount:   r.errorCount || 0,
    avgDurationFmt: fmtDuration(r.avgDuration),
    lastRunFmt:   fmtLastRun(r.lastRun),
    avgTokensIn:  r.avgTokensIn != null ? Math.round(r.avgTokensIn) : null,
    avgTokensOut: r.avgTokensOut != null ? Math.round(r.avgTokensOut) : null,
    avgTokensFmt: r.avgTokensIn != null
      ? fmtTok(Math.round((r.avgTokensIn || 0) + (r.avgTokensOut || 0)))
      : '—',
  }));
  res.json(result);
});

sharedRouter.get('/last-run', (req, res) => {
  const { type, book_id } = req.query;
  if (!type || !book_id) return res.status(400).json({ error: 'type und book_id erforderlich' });
  const userEmail = req.session?.user?.email || null;
  const row = db.prepare(`
    SELECT ended_at FROM job_runs
    WHERE type = ? AND book_id = ? AND user_email = ? AND status = 'done'
    ORDER BY ended_at DESC LIMIT 1
  `).get(type, parseInt(book_id), userEmail);
  res.json({ lastRun: row?.ended_at || null, lastRunFmt: row ? fmtLastRun(row.ended_at) : null });
});

sharedRouter.get('/active', (req, res) => {
  const { type, book_id, page_id } = req.query;
  const entityId = page_id || book_id;
  if (!type || !entityId) return res.status(400).json({ error: 'type und book_id (oder page_id) erforderlich' });
  const userEmail = req.session?.user?.email || null;
  const jobId = runningJobs.get(jobKey(type, entityId, userEmail));
  if (!jobId || !jobs.has(jobId)) return res.json({ jobId: null });
  const job = jobs.get(jobId);
  res.json({ jobId: job.id, status: job.status, progress: job.progress, statusText: job.statusText });
});

sharedRouter.delete('/:id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });
  const ok = cancelJob(req.params.id, userEmail);
  if (!ok) return res.status(400).json({ error: `Job kann nicht abgebrochen werden (Status: ${job.status})` });
  res.json({ ok: true });
});

sharedRouter.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });
  let statusText = job.statusText;
  if (job.status === 'queued') {
    const pos = jobQueue.findIndex(e => e.jobId === job.id) + 1;
    statusText = pos > 0 ? `In Warteschlange (Position ${pos})…` : 'In Warteschlange…';
  }
  res.json({
    id: job.id, type: job.type, status: job.status,
    progress: job.progress, statusText,
    tokensIn: job.tokensIn, tokensOut: job.tokensOut,
    maxTokensOut: job.maxTokensOut,
    tokensPerSec: job.tokensPerSec,
    result: job.result, error: job.error,
  });
});

module.exports = {
  _promptConfig,
  jobs, runningJobs, jobAbortControllers, jobQueue,
  makeJobLogger, enqueueJob, createJob, updateJob,
  tps, completeJob, failJob, cancelJob, jobKey, fmtTok,
  _modelName, settledAll,
  BS_URL, bsGet, bsGetAll,
  htmlToText,
  loadPageContents, groupByChapter, buildSinglePassBookText,
  aiCall,
  getPrompts, getBookPrompts,
  SINGLE_PASS_LIMIT, BATCH_SIZE,
  jsonBody, jsonBodyLarge,
  sharedRouter,
};
