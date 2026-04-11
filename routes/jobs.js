'use strict';
const express = require('express');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const logger = require('../logger');
const { db, saveFigurenToDb, updateFigurenEvents, updateFigurenSoziogramm, saveZeitstrahlEvents, saveCharacterArcs, saveOrteToDb, saveCheckpoint, loadCheckpoint, deleteCheckpoint, insertJobRun, startJobRun, endJobRun, getBookLocale, getAllUserTokens } = require('../db/schema');
const { callAI, parseJSON } = require('../lib/ai');

// prompt-config.json synchron lesen (einmalig bei Modulstart); fehlt die Datei, bricht der Server ab.
const _promptConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../prompt-config.json'), 'utf8'));

// System-Prompts aus dem Browser-Modul laden (Single Source of Truth: public/js/prompts.js)
let _prompts = null;
async function getPrompts() {
  if (!_prompts) {
    _prompts = await import(pathToFileURL(path.resolve(__dirname, '../public/js/prompts.js')).href);
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

const router = express.Router();
const jsonBody = express.json();
const jsonBodyLarge = express.json({ limit: '5mb' });

// ── Job store ─────────────────────────────────────────────────────────────────
// key: jobId → { id, type, bookId, status, progress, statusText, result, error }
const jobs = new Map();
// key: `${type}:${bookId}:${userEmail}` → jobId  (verhindert Doppel-Starts)
const runningJobs = new Map();
// key: jobId → AbortController  (für Job-Abbruch)
const jobAbortControllers = new Map();

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
    try { startJobRun(jobId, job.startedAt); } catch (e) { logger.error(`startJobRun: ${e.message}`); }
    fn()
      .catch(e => logger.error(`Unkontrollierter Job-Fehler (${jobId}): ${e.message}`))
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
  try { insertJobRun({ id, type, bookId: String(bookId), userEmail, label }); } catch (e) { logger.error(`insertJobRun: ${e.message}`); }
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
    // Parallel-Branch mit niedrigerem Fortschritt darf weder progress noch statusText überschreiben
    const { progress: _, statusText: __, ...rest } = updates;
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
  try { endJobRun(id, 'done', job.endedAt, job.tokensIn, job.tokensOut, tokensPerSec, null); } catch (e) { logger.error(`endJobRun: ${e.message}`); }
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
  try { endJobRun(id, status, job.endedAt, job.tokensIn, job.tokensOut, null, errorMsg); } catch (e) { logger.error(`endJobRun: ${e.message}`); }
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
    try { endJobRun(id, 'cancelled', endedAt, 0, 0, null, 'Abgebrochen'); } catch (e) { logger.error(`endJobRun: ${e.message}`); }
    runningJobs.delete(jobKey(job.type, job.bookId, job.userEmail));
    jobAbortControllers.delete(id);
    logger.info(`Job ${id} (${job.type}) aus Warteschlange entfernt und abgebrochen.`);
    return true;
  }
  if (job.status === 'running') {
    job.cancelled = true;
    const ctrl = jobAbortControllers.get(id);
    if (ctrl) ctrl.abort();
    logger.info(`Job ${id} (${job.type}) Abbruch signalisiert.`);
    return true;
  }
  return false;
}

// ── Ollama-kompatibler Promise.allSettled-Ersatz ──────────────────────────────
// Ollama verarbeitet Requests sequenziell. Bei parallelen Calls mit grossem
// num_ctx läuft der VRAM voll → fetch failed. Für Ollama daher serialisieren.
async function settledAll(thunks) {
  if ((process.env.API_PROVIDER || 'claude') !== 'ollama')
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

// callAI und parseJSON werden aus lib/ai.js importiert

function htmlToText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

// ── Chat-Hilfsfunktionen ──────────────────────────────────────────────────────

function _chatGetFiguren(bookId, userEmail, chapterName = null) {
  const figParams = chapterName ? [bookId, userEmail, chapterName] : [bookId, userEmail];
  const rows = db.prepare(`
    SELECT f.fig_id, f.name, f.kurzname, f.typ, f.beschreibung, f.beruf, f.geschlecht,
           GROUP_CONCAT(DISTINCT ft.tag)         AS tags,
           GROUP_CONCAT(DISTINCT fa.chapter_name) AS kapitel
    FROM figures f
    LEFT JOIN figure_tags        ft ON ft.figure_id = f.id
    LEFT JOIN figure_appearances fa ON fa.figure_id = f.id
    WHERE f.book_id = ? AND f.user_email = ?
    ${chapterName ? 'AND EXISTS (SELECT 1 FROM figure_appearances fa2 WHERE fa2.figure_id = f.id AND fa2.chapter_name = ?)' : ''}
    GROUP BY f.id
    ORDER BY f.sort_order
  `).all(...figParams);

  const evtRows = db.prepare(`
    SELECT f.fig_id, fe.datum, fe.ereignis, fe.bedeutung, fe.typ, fe.kapitel
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    WHERE f.book_id = ? AND f.user_email = ?
    ORDER BY fe.sort_order
  `).all(bookId, userEmail);
  const eventsByFigId = {};
  for (const e of evtRows) {
    if (!eventsByFigId[e.fig_id]) eventsByFigId[e.fig_id] = [];
    eventsByFigId[e.fig_id].push({
      datum: e.datum, ereignis: e.ereignis,
      ...(e.bedeutung ? { bedeutung: e.bedeutung } : {}),
      typ: e.typ,
      ...(e.kapitel  ? { kapitel: e.kapitel }     : {}),
    });
  }

  const relRows = db.prepare(`
    SELECT from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis
    FROM figure_relations
    WHERE book_id = ? AND user_email = ?
  `).all(bookId, userEmail);
  const relsByFigId = {};
  for (const r of relRows) {
    const entry = {
      typ: r.typ,
      ...(r.beschreibung    ? { beschreibung: r.beschreibung }       : {}),
      ...(r.machtverhaltnis != null ? { machtverhaltnis: r.machtverhaltnis } : {}),
    };
    if (!relsByFigId[r.from_fig_id]) relsByFigId[r.from_fig_id] = [];
    relsByFigId[r.from_fig_id].push({ mit: r.to_fig_id, ...entry });
    if (!relsByFigId[r.to_fig_id]) relsByFigId[r.to_fig_id] = [];
    relsByFigId[r.to_fig_id].push({ mit: r.from_fig_id, ...entry });
  }

  const locParams = chapterName ? [chapterName, bookId, userEmail] : [bookId, userEmail];
  const locRows = db.prepare(chapterName ? `
    SELECT lf.fig_id, l.name, l.typ, l.beschreibung, l.stimmung
    FROM location_figures lf
    JOIN locations l ON l.id = lf.location_id
    JOIN location_chapters lc ON lc.location_id = l.id AND lc.chapter_name = ?
    WHERE l.book_id = ? AND l.user_email = ?
    ORDER BY l.sort_order
  ` : `
    SELECT lf.fig_id, l.name, l.typ, l.beschreibung, l.stimmung
    FROM location_figures lf
    JOIN locations l ON l.id = lf.location_id
    WHERE l.book_id = ? AND l.user_email = ?
    ORDER BY l.sort_order
  `).all(...locParams);
  const locsByFigId = {};
  for (const l of locRows) {
    if (!locsByFigId[l.fig_id]) locsByFigId[l.fig_id] = [];
    locsByFigId[l.fig_id].push({
      name: l.name,
      ...(l.typ         ? { typ:         l.typ         } : {}),
      ...(l.beschreibung? { beschreibung: l.beschreibung} : {}),
      ...(l.stimmung    ? { stimmung:     l.stimmung    } : {}),
    });
  }

  const sceneParams = chapterName ? [bookId, userEmail, chapterName] : [bookId, userEmail];
  const sceneRows = db.prepare(chapterName ? `
    SELECT sf.fig_id, fs.titel, fs.kapitel, fs.wertung, fs.kommentar
    FROM scene_figures sf
    JOIN figure_scenes fs ON fs.id = sf.scene_id
    WHERE fs.book_id = ? AND fs.user_email = ? AND fs.kapitel = ?
    ORDER BY fs.sort_order
  ` : `
    SELECT sf.fig_id, fs.titel, fs.kapitel, fs.wertung, fs.kommentar
    FROM scene_figures sf
    JOIN figure_scenes fs ON fs.id = sf.scene_id
    WHERE fs.book_id = ? AND fs.user_email = ?
    ORDER BY fs.sort_order
  `).all(...sceneParams);
  const scenesByFigId = {};
  for (const s of sceneRows) {
    if (!scenesByFigId[s.fig_id]) scenesByFigId[s.fig_id] = [];
    scenesByFigId[s.fig_id].push({
      titel: s.titel,
      ...(s.kapitel   ? { kapitel:   s.kapitel   } : {}),
      ...(s.wertung  != null ? { wertung:  s.wertung  } : {}),
      ...(s.kommentar ? { kommentar: s.kommentar } : {}),
    });
  }

  return rows.map(r => ({
    id: r.fig_id, name: r.name, kurzname: r.kurzname, typ: r.typ,
    beschreibung: r.beschreibung, beruf: r.beruf, geschlecht: r.geschlecht,
    eigenschaften: r.tags ? r.tags.split(',') : [],
    kapitel: r.kapitel ? r.kapitel.split(',') : [],
    ...(eventsByFigId[r.fig_id]?.length  ? { lebensereignisse: eventsByFigId[r.fig_id]  } : {}),
    ...(relsByFigId[r.fig_id]?.length    ? { beziehungen:      relsByFigId[r.fig_id]    } : {}),
    ...(locsByFigId[r.fig_id]?.length    ? { schauplätze:      locsByFigId[r.fig_id]    } : {}),
    ...(scenesByFigId[r.fig_id]?.length  ? { szenen:           scenesByFigId[r.fig_id]  } : {}),
  }));
}

function _chatGetLatestReview(bookId, userEmail) {
  const row = db.prepare(`
    SELECT review_json FROM book_reviews
    WHERE book_id = ? AND user_email = ?
    ORDER BY reviewed_at DESC LIMIT 1
  `).get(bookId, userEmail);
  if (!row) return null;
  try { return JSON.parse(row.review_json); } catch { return null; }
}

function _chatBuildMessageHistory(sessionId) {
  return db.prepare(`
    SELECT role, content FROM chat_messages
    WHERE session_id = ? ORDER BY created_at ASC
  `).all(sessionId).map(r => ({ role: r.role, content: r.content }));
}

/**
 * Rolling-Window für den Buch-Chat: erste user+assistant-Runde als Kontext-Anker
 * + die letzten tailMessages Nachrichten. Verhindert unbegrenztes Historien-Wachstum.
 */
function _bookChatBuildHistory(sessionId, tailMessages = 10) {
  const all = db.prepare(`
    SELECT role, content FROM chat_messages
    WHERE session_id = ? ORDER BY created_at ASC
  `).all(sessionId).map(r => ({ role: r.role, content: r.content }));

  if (all.length <= tailMessages + 2) return all;

  // Erste vollständige Runde sichern (Kontext-Anker)
  const anchor = [];
  if (all[0]?.role === 'user')      anchor.push(all[0]);
  if (all[1]?.role === 'assistant') anchor.push(all[1]);

  // Letzte tailMessages Nachrichten
  const tail = all.slice(-tailMessages);

  // Überschneidung: wenn Anchor bereits im Tail liegt, nur Tail zurückgeben
  const anchorInTail = anchor.length > 0 && all.length - tailMessages <= 0;
  return anchorInTail ? tail : [...anchor, ...tail];
}

// ── callAIChat: Multi-Turn-Variante von callAI ────────────────────────────────
// messages: Array von { role, content } – enthält die vollständige Konversation.
// Entspricht _streamClaude/_streamOllama in chat.js, aber akkumuliert intern (kein SSE).
async function callAIChat(messages, systemPrompt, onProgress, signal) {
  const provider = process.env.API_PROVIDER || 'claude';

  if (provider === 'ollama') {
    const host  = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
    const model = process.env.OLLAMA_MODEL || 'llama3.2';
    const maxTokens = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
    const ollamaMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    const estimatedTokIn = Math.ceil(ollamaMessages.reduce((s, m) => s + (m.content?.length || 0), 0) / 4);

    const resp = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: ollamaMessages, stream: true, options: { num_ctx: maxTokens, think: false } }),
      signal,
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', tokensIn = 0, tokensOut = 0, genDurationMs = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.done) {
            tokensIn  = chunk.prompt_eval_count || estimatedTokIn;
            tokensOut = chunk.eval_count || Math.ceil(text.length / 4);
            if (chunk.eval_duration) genDurationMs = Math.round(chunk.eval_duration / 1e6);
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          } else {
            text += chunk.message?.content || '';
            if (onProgress) onProgress({ chars: text.length, tokIn: estimatedTokIn });
          }
        } catch { }
      }
    }
    return { text, tokensIn, tokensOut, genDurationMs };
  } else {
    const model     = process.env.MODEL_NAME  || 'claude-sonnet-4-6';
    const maxTokens = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
    const body = { model, max_tokens: maxTokens, messages, stream: true };
    if (systemPrompt) body.system = systemPrompt;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) throw new Error(`Claude ${resp.status}: ${JSON.stringify(await resp.json())}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let text = '', buf = '', tokensIn = 0, tokensOut = 0;
    let t_first = 0, t_last = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6);
        if (raw === '[DONE]') break;
        try {
          const ev = JSON.parse(raw);
          if (ev.type === 'message_start' && ev.message?.usage) {
            tokensIn = ev.message.usage.input_tokens || 0;
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          }
          if (ev.type === 'message_delta' && ev.usage) {
            tokensOut = ev.usage.output_tokens || 0;
          }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            const now = Date.now();
            if (!t_first) t_first = now;
            t_last = now;
            text += ev.delta.text;
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          }
        } catch { }
      }
    }
    const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
    return { text, tokensIn, tokensOut, genDurationMs };
  }
}

const SINGLE_PASS_LIMIT = 60000;
const BATCH_SIZE = 5;

async function loadPageContents(pages, chMap, minLength, onBatch, userToken) {
  const contents = [];
  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
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
        outEst:  chars > 0  ? Math.floor(chars / 4) : entry.outEst,
      });
      const vals = [...tok.inflight.values()];
      if (tokIn > 0) updates.tokensIn  = tok.in  + vals.reduce((s, v) => s + v.tokIn,  0);
      if (chars > 0) updates.tokensOut = tok.out + vals.reduce((s, v) => s + v.outEst, 0);
    } else {
      if (tokIn > 0) updates.tokensIn  = tok.in  + tokIn;
      if (chars > 0) updates.tokensOut = tok.out + Math.floor(chars / 4);
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
  updateJob(jobId, { tokensIn: tok.in, tokensOut: tok.out });
  if (truncated) throw new Error(`KI-Antwort wurde bei ${maxTokensOverride} Tokens abgeschnitten (stop_reason: max_tokens). JSON ist unvollständig.`);
  return parseJSON(text);
}

// ── Job: Buchbewertung ────────────────────────────────────────────────────────
async function runReviewJob(jobId, bookId, bookName, userEmail, userToken) {
  const { buildBookReviewSinglePassPrompt, buildChapterAnalysisPrompt, buildBookReviewMultiPassPrompt } = await getPrompts();
  const { SYSTEM_BUCHBEWERTUNG, SYSTEM_KAPITELANALYSE } = await getBookPrompts(bookId);
  try {
    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId, userToken),
      bsGetAll('pages?book_id=' + bookId, userToken),
    ]);

    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0, ms: 0 }; // akkumulierte Token über alle KI-Calls
    const pageContents = await loadPageContents(pages, chMap, 50, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 60),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    }, userToken);

    updateJob(jobId, { progress: 65 });
    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    let r;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      updateJob(jobId, { progress: 65, statusText: 'KI analysiert das Buch…' });
      const bookText = pageContents
        .map(p => `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`)
        .join('\n\n---\n\n');

      r = await aiCall(jobId, tok,
        buildBookReviewSinglePassPrompt(bookName, pageContents.length, bookText),
        SYSTEM_BUCHBEWERTUNG,
        65, 97, 5000, 0.2, null,
      );
    } else {
      const { groupOrder, groups } = groupByChapter(pageContents);
      const chapterAnalyses = [];

      for (let gi = 0; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const fromPct = 65 + Math.round((gi / groupOrder.length) * 25);
        const toPct   = 65 + Math.round(((gi + 1) / groupOrder.length) * 25);
        updateJob(jobId, {
          progress: fromPct,
          statusText: `Analysiere ${gi + 1}/${groupOrder.length}: «${group.name}»…`,
        });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        const ca = await aiCall(jobId, tok,
          buildChapterAnalysisPrompt(group.name, bookName, group.pages.length, chText),
          SYSTEM_KAPITELANALYSE,
          fromPct, toPct, 1500, 0.2, null,
        );
        chapterAnalyses.push({ name: group.name, pageCount: group.pages.length, ...ca });
      }

      updateJob(jobId, {
        progress: 90,
        statusText: `KI erstellt Gesamtbewertung…`,
      });
      r = await aiCall(jobId, tok,
        buildBookReviewMultiPassPrompt(bookName, chapterAnalyses, pageContents.length),
        SYSTEM_BUCHBEWERTUNG,
        90, 97, 5000, 0.2, null,
      );
    }

    if (typeof r?.gesamtnote === 'undefined') throw new Error('KI-Antwort ungültig: gesamtnote fehlt');

    const model = process.env.API_PROVIDER === 'ollama'
      ? (process.env.OLLAMA_MODEL || 'llama3.2')
      : (process.env.MODEL_NAME || 'claude-sonnet-4-6');
    db.prepare('INSERT INTO book_reviews (book_id, book_name, reviewed_at, review_json, model, user_email) VALUES (?, ?, ?, ?, ?, ?)')
      .run(parseInt(bookId), bookName, new Date().toISOString(), JSON.stringify(r), model, userEmail || null);

    completeJob(jobId, { review: r, pageCount: pageContents.length, tokensIn: tok.in, tokensOut: tok.out }, tps(tok));
    logger.info(`Job ${jobId}: Buchbewertung Buch ${bookId} abgeschlossen (${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Buchbewertung Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Komplettanalyse ───────────────────────────────────────────────────────
// Pipeline (optimiert, zwei parallele Blöcke nach P2):
//   P1 (Figuren+Orte, parallel/Kapitel) → P2 (Figuren konsolidieren)
//   Block 1 [P3 Orte · P4 Soziogramm · P7-Kapitel] parallel
//   Block 2 [P5+P6 Szenen/Zeitstrahl · P7-Konsol · P8 Kontinuität] parallel
async function runKomplettAnalyseJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const call = (...args) => aiCall(...args, provider);
  const {
    buildExtraktionFigurenOrteKontinuitaetChapterPrompt,
    buildExtraktionSzenenEreignisseChapterPrompt,
    buildExtraktionSzenenEreignisseEntwicklungsbogenChapterPrompt,
    buildFiguresBasisConsolidationPrompt,
    buildLocationsConsolidationPrompt,
    buildZeitstrahlConsolidationPrompt,
    buildFigurSoziogrammEnrichmentPrompt,
    buildEntwicklungsbogenSinglePassPrompt,
    buildEntwicklungsbogenConsolidationPrompt,
    buildKontinuitaetSinglePassPrompt,
    buildKontinuitaetChapterFactsPrompt,
    buildKontinuitaetCheckPrompt,
  } = await getPrompts();
  const {
    SYSTEM_FIGUREN, SYSTEM_ORTE, SYSTEM_KONTINUITAET,
    SYSTEM_SZENEN, SYSTEM_ZEITSTRAHL, SYSTEM_ENTWICKLUNGSBOGEN,
    SOZIOGRAMM_KONTEXT,
  } = await getBookPrompts(bookId);

  try {
    let cp = loadCheckpoint('komplett-analyse', bookId, userEmail);
    if (cp) logger.info(`Job ${jobId}: Komplettanalyse Buch ${bookId} – Checkpoint (Phase: ${cp.phase}), setze fort.`);

    // Checkpoint-Validierung: p1_done ohne tatsächliche Figuren-Daten verwirft den Checkpoint.
    // Passiert z.B. wenn ein vorheriger Ollama-Lauf alle Kapitel mit leeren Arrays gespeichert hat.
    if (cp?.phase === 'p1_done') {
      const hasFiguren = Array.isArray(cp.chapterFiguren) && cp.chapterFiguren.length > 0
        && cp.chapterFiguren.some(c => Array.isArray(c.figuren) && c.figuren.length > 0);
      if (!hasFiguren) {
        logger.warn(`Job ${jobId}: Checkpoint p1_done enthält keine Figuren-Daten – Phase 1 wird neu ausgeführt.`);
        deleteCheckpoint('komplett-analyse', bookId, userEmail);
        cp = null;
      }
    }

    // ── Seiten laden ──────────────────────────────────────────────────────────
    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId, userToken),
      bsGetAll('pages?book_id=' + bookId, userToken),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };
    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 12),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    }, userToken);

    const idMaps = {
      chNameToId:   Object.fromEntries(chaptersData.map(c => [c.name, c.id])),
      pageNameToId: Object.fromEntries(pages.map(p => [p.name, p.id])),
    };
    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);

    // ── Phase 1: Figuren + Orte + Kontinuitätsfakten kombiniert (parallel pro Kapitel) ──
    let chapterFiguren, chapterOrte, chapterFakten;

    if (cp?.phase === 'p1_done') {
      ({ chapterFiguren, chapterOrte, chapterFakten } = cp);
      if (cp.tokIn != null) { tok.in = cp.tokIn; tok.out = cp.tokOut || 0; tok.ms = cp.tokMs || 0; }
      updateJob(jobId, { progress: 28, statusText: 'Phase 1 aus Checkpoint geladen…', tokensIn: tok.in, tokensOut: tok.out });
    } else {
      updateJob(jobId, {
        progress: 12,
        statusText: totalChars <= SINGLE_PASS_LIMIT
          ? 'KI extrahiert Figuren, Schauplätze und Fakten…'
          : `Figuren + Schauplätze + Fakten in ${groupOrder.length} Kapiteln extrahieren…`,
      });

      if (totalChars <= SINGLE_PASS_LIMIT) {
        const bookText = pageContents
          .map(p => `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`)
          .join('\n\n---\n\n');
        const r = await call(jobId, tok,
          buildExtraktionFigurenOrteKontinuitaetChapterPrompt('Gesamtbuch', bookName, pageContents.length, bookText),
          SYSTEM_FIGUREN, 12, 28, 10000,
        );
        chapterFiguren = [{ kapitel: 'Gesamtbuch', figuren: r?.figuren || [] }];
        chapterOrte    = [{ kapitel: 'Gesamtbuch', orte:    r?.orte    || [] }];
        chapterFakten  = [{ kapitel: 'Gesamtbuch', fakten:  r?.fakten  || [] }];
      } else {
        const chapterTexts = groupOrder.map(key => {
          const group = groups.get(key);
          return { group, chText: group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n') };
        });
        const settled = await settledAll(
          chapterTexts.map(({ group, chText }) => () =>
            call(jobId, tok,
              buildExtraktionFigurenOrteKontinuitaetChapterPrompt(group.name, bookName, group.pages.length, chText),
              SYSTEM_FIGUREN, 12, 28, 10000,
            )
          )
        );
        chapterFiguren = settled.map((r, gi) => ({
          kapitel: chapterTexts[gi].group.name,
          figuren: r.status === 'fulfilled' ? (r.value?.figuren || []) : [],
          ...(r.status === 'rejected' && logger.warn(`Job ${jobId}: Figuren/Orte/Fakten «${chapterTexts[gi].group.name}» übersprungen: ${r.reason?.message}`) && {}),
        }));
        chapterOrte = settled.map((r, gi) => ({
          kapitel: chapterTexts[gi].group.name,
          orte: r.status === 'fulfilled' ? (r.value?.orte || []) : [],
        }));
        chapterFakten = settled.map((r, gi) => ({
          kapitel: chapterTexts[gi].group.name,
          fakten: r.status === 'fulfilled' ? (r.value?.fakten || []) : [],
        }));
        logger.info(`Job ${jobId}: Phase 1 – ${settled.filter(r => r.status === 'fulfilled').length}/${settled.length} Kapitel OK. Figuren/Kap: [${chapterFiguren.map(c => c.figuren.length).join(', ')}], Orte/Kap: [${chapterOrte.map(c => c.orte.length).join(', ')}]`);
      }
      saveCheckpoint('komplett-analyse', bookId, userEmail, { phase: 'p1_done', chapterFiguren, chapterOrte, chapterFakten, tokIn: tok.in, tokOut: tok.out, tokMs: tok.ms });
    }

    // ── Phase 2: Figuren konsolidieren ────────────────────────────────────────
    updateJob(jobId, { progress: 30, statusText: 'KI konsolidiert Figuren…' });
    const figResult = await call(jobId, tok,
      buildFiguresBasisConsolidationPrompt(bookName, chapterFiguren),
      SYSTEM_FIGUREN, 30, 43, 8000,
    );
    logger.info(`Job ${jobId}: figResult Keys: [${Object.keys(figResult || {}).join(', ')}] – figuren: ${figResult?.figuren?.length ?? 'FEHLT'}`);
    if (!Array.isArray(figResult?.figuren)) throw new Error('Figuren-Konsolidierung ungültig: figuren-Array fehlt');
    const figuren = figResult.figuren.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
    logger.info(`Job ${jobId}: Speichere ${figuren.length} Figuren…`);
    saveFigurenToDb(parseInt(bookId), figuren, userEmail || null, idMaps);
    logger.info(`Job ${jobId}: ${figuren.length} Figuren gespeichert.`);

    // ── P7-Kontext aufbauen (direkt nach saveFigurenToDb, noch vor dem Parallel-Block) ──
    // figurenKompaktForArcsChapter: nur Name+Typ für Kapitel-Calls – spart ~15–20k Input-Tokens.
    // figurenKontextForArcs: vollständig (mit Ereignissen) nur für den Konsolidierungs-Call.
    const figurenKompakt = figuren.map(f => ({ id: f.id, name: f.name, typ: f.typ || 'andere' }));
    const figRowsForArcs = db.prepare(
      'SELECT id, fig_id, name, typ, beschreibung FROM figures WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(parseInt(bookId), userEmail || null);
    let figurenKontextForArcs = '';
    if (figRowsForArcs.length) {
      const evtRowsForArcs = db.prepare(`
        SELECT fe.figure_id, fe.datum, fe.ereignis, fe.typ
        FROM figure_events fe
        WHERE fe.figure_id IN (${figRowsForArcs.map(() => '?').join(',')})
        ORDER BY fe.figure_id, fe.sort_order
      `).all(...figRowsForArcs.map(f => f.id));
      const evtMapForArcs = {};
      for (const ev of evtRowsForArcs) (evtMapForArcs[ev.figure_id] ??= []).push(ev);
      figurenKontextForArcs = figRowsForArcs.map(f => {
        let line = `${f.fig_id}: ${f.name} (${f.typ || 'andere'})${f.beschreibung ? ' – ' + f.beschreibung : ''}`;
        const evts = evtMapForArcs[f.id];
        if (evts?.length) {
          line += `\n  Lebensereignisse:\n` + evts.map(e =>
            `  • ${e.datum || '?'}: ${e.ereignis}${e.typ === 'extern' ? ' [extern]' : ''}`
          ).join('\n');
        }
        return line;
      }).join('\n\n');
    }

    // ── Parallel-Block 1: P3 (Orte) + P4 (Soziogramm) ───────────────────────
    // P7-Kapitel wurde in Block 2 verschoben (kombiniert mit P5 Szenen+Ereignisse).
    // settledAll serialisiert für Ollama (VRAM-Schutz); für Claude bleibt es parallel.
    updateJob(jobId, { progress: 43, statusText: 'Schauplätze und Soziogramm analysieren…' });
    const block1Settled = await settledAll([

      // P3: Orte konsolidieren
      () => call(jobId, tok,
        buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompakt),
        SYSTEM_ORTE, 43, 55, 6000,
      ),

      // P4: Soziogramm – nicht-fatal: Fehler werden geloggt, Job läuft weiter
      () => (async () => {
        const figRowsForSoz = db.prepare(
          'SELECT fig_id, name, typ, beruf, beschreibung FROM figures WHERE book_id = ? AND user_email IS ? ORDER BY sort_order'
        ).all(parseInt(bookId), userEmail || null);
        const relRows = db.prepare(
          'SELECT from_fig_id, to_fig_id, typ, beschreibung FROM figure_relations WHERE book_id = ? AND user_email IS ?'
        ).all(parseInt(bookId), userEmail || null);
        const sozResult = await call(jobId, tok,
          buildFigurSoziogrammEnrichmentPrompt(bookName, figRowsForSoz, relRows, SOZIOGRAMM_KONTEXT),
          SYSTEM_FIGUREN, 43, 55, 2000,
        );
        if (Array.isArray(sozResult?.figuren)) {
          updateFigurenSoziogramm(parseInt(bookId), sozResult.figuren, sozResult.beziehungen || [], userEmail || null);
        }
      })().catch(e => {
        if (e.name === 'AbortError') throw e;
        logger.warn(`Job ${jobId}: Soziogramm übersprungen: ${e.message}`);
      }),
    ]);
    if (block1Settled[0].status === 'rejected') throw block1Settled[0].reason;
    const orteResultRaw = block1Settled[0].value;

    logger.info(`Job ${jobId}: orteResult Keys: [${Object.keys(orteResultRaw || {}).join(', ')}] – orte: ${orteResultRaw?.orte?.length ?? 'FEHLT'}`);
    if (!Array.isArray(orteResultRaw?.orte)) throw new Error('Orte-Konsolidierung ungültig: orte-Array fehlt');
    const orte = orteResultRaw.orte.map((o, i) => ({ ...o, id: o.id || ('ort_' + (i + 1)) }));
    logger.info(`Job ${jobId}: Speichere ${orte.length} Schauplätze…`);
    saveOrteToDb(parseInt(bookId), orte, userEmail || null);
    logger.info(`Job ${jobId}: ${orte.length} Schauplätze gespeichert.`);

    // ── Parallel-Block 2: Szenen/Zeitstrahl/Entwicklungsbögen + Kontinuität ──
    // Multi-Pass: kombinierter P5+P7-Kap-Call pro Kapitel → P6 + P7-Kons parallel.
    //             P8 nutzt chapterFakten aus Phase 1 – kein separater Extraktions-Call.
    // Single-Pass: P5 (per-Kapitel) + P7 (Single-Pass) parallel; P8 Buchtext-Pfad.
    let allSzenen = [];
    updateJob(jobId, { progress: 56, statusText: 'Szenen, Entwicklungsbögen und Kontinuität analysieren…' });

    // Hilfsfunktion: Szenen + Events aus settled-Ergebnissen extrahieren und speichern.
    // Wird von beiden Pfaden (multi-pass + single-pass) verwendet.
    async function processSzenenEreignisse(settled, locIdToDbId) {
      const mergedEvtMap = new Map();
      settled.forEach((r, gi) => {
        const group = groups.get(groupOrder[gi]);
        if (r.status === 'rejected') {
          logger.warn(`Job ${jobId}: Szenen/Ereignisse «${group.name}» übersprungen: ${r.reason?.message}`);
          return;
        }
        for (const s of (r.value?.szenen || [])) {
          allSzenen.push({
            kapitel:    group.name,
            seite:      s.seite     || null,
            titel:      s.titel     || '(unbekannt)',
            wertung:    s.wertung   || null,
            kommentar:  s.kommentar || null,
            fig_ids:    Array.isArray(s.figuren) ? s.figuren : [],
            ort_ids:    Array.isArray(s.orte)    ? s.orte    : [],
            sort_order: allSzenen.length,
          });
        }
        for (const assignment of (r.value?.assignments || [])) {
          if (!mergedEvtMap.has(assignment.fig_id)) mergedEvtMap.set(assignment.fig_id, []);
          for (const ev of (assignment.lebensereignisse || [])) mergedEvtMap.get(assignment.fig_id).push(ev);
        }
      });

      logger.info(`Job ${jobId}: Speichere ${allSzenen.length} Szenen (${mergedEvtMap.size} Figuren mit Ereignissen)…`);
      updateJob(jobId, { progress: 81, statusText: 'Szenen speichern…' });
      db.transaction(() => {
        db.prepare('DELETE FROM figure_scenes WHERE book_id = ? AND user_email = ?').run(parseInt(bookId), userEmail || null);
        const now = new Date().toISOString();
        const ins = db.prepare(`INSERT INTO figure_scenes
          (book_id, user_email, kapitel, seite, titel, wertung, kommentar, chapter_id, page_id, sort_order, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insSf = db.prepare('INSERT INTO scene_figures (scene_id, fig_id) VALUES (?, ?)');
        const insSl = db.prepare('INSERT OR IGNORE INTO scene_locations (scene_id, location_id) VALUES (?, ?)');
        for (const s of allSzenen) {
          const { lastInsertRowid: sceneId } = ins.run(
            parseInt(bookId), userEmail || null,
            s.kapitel, s.seite, s.titel, s.wertung, s.kommentar,
            idMaps.chNameToId[s.kapitel]  ?? null,
            s.seite ? (idMaps.pageNameToId[s.seite] ?? null) : null,
            s.sort_order, now,
          );
          for (const fid of s.fig_ids) insSf.run(sceneId, fid);
          for (const locIdStr of s.ort_ids) {
            const dbLocId = locIdToDbId[locIdStr];
            if (dbLocId) insSl.run(sceneId, dbLocId);
          }
        }
      })();

      const allAssignments = [];
      for (const [fig_id, events] of mergedEvtMap) {
        const seen = new Set();
        const deduped = [];
        for (const ev of events) {
          const key = (ev.datum || '') + '||' + (ev.ereignis || '').trim().toLowerCase();
          if (!seen.has(key)) { seen.add(key); deduped.push(ev); }
        }
        deduped.sort((a, b) => (parseInt(a.datum) || 0) - (parseInt(b.datum) || 0));
        allAssignments.push({ fig_id, lebensereignisse: deduped });
      }
      logger.info(`Job ${jobId}: Speichere ${allAssignments.length} Figur-Ereignis-Sets…`);
      saveZeitstrahlEvents(parseInt(bookId), userEmail || null, []);
      updateFigurenEvents(parseInt(bookId), allAssignments, userEmail || null, idMaps);
      logger.info(`Job ${jobId}: ${allSzenen.length} Szenen und ${allAssignments.reduce((s, a) => s + a.lebensereignisse.length, 0)} Ereignisse gespeichert.`);
    }

    // Hilfsfunktion: P6 Zeitstrahl konsolidieren (identisch für beide Pfade).
    async function runZeitstrahlKonsolidierung() {
      updateJob(jobId, { progress: 83, statusText: 'Zeitstrahl konsolidieren…' });
      const rawEvtRows = db.prepare(`
        SELECT f.fig_id, f.name AS fig_name, f.typ AS fig_typ,
               fe.datum, fe.ereignis, fe.typ AS evt_typ, fe.bedeutung, fe.kapitel, fe.seite
        FROM figure_events fe
        JOIN figures f ON f.id = fe.figure_id
        WHERE f.book_id = ? AND f.user_email IS ?
        ORDER BY fe.datum, f.sort_order
      `).all(parseInt(bookId), userEmail || null);
      if (!rawEvtRows.length) return;
      const evtGroupMap = new Map();
      for (const row of rawEvtRows) {
        const key = `${row.datum}||${(row.ereignis || '').trim().toLowerCase()}`;
        if (!evtGroupMap.has(key)) {
          evtGroupMap.set(key, {
            datum: row.datum, ereignis: row.ereignis, typ: row.evt_typ,
            bedeutung: row.bedeutung || '',
            kapitel: row.kapitel ? [row.kapitel] : [],
            seiten:  row.seite   ? [row.seite]   : [],
            figuren: [],
          });
        }
        const ev = evtGroupMap.get(key);
        if (!ev.figuren.some(f => f.id === row.fig_id))
          ev.figuren.push({ id: row.fig_id, name: row.fig_name, typ: row.fig_typ || 'andere' });
        if (row.kapitel && !ev.kapitel.includes(row.kapitel)) ev.kapitel.push(row.kapitel);
        if (row.seite   && !ev.seiten.includes(row.seite))   ev.seiten.push(row.seite);
      }
      const zeitstrahlEvents = [...evtGroupMap.values()].sort((a, b) => parseInt(a.datum) - parseInt(b.datum));
      const ztResult = await call(jobId, tok,
        buildZeitstrahlConsolidationPrompt(zeitstrahlEvents),
        SYSTEM_ZEITSTRAHL, 83, 89, 3000, 0.2, null,
      );
      logger.info(`Job ${jobId}: ztResult Keys: [${Object.keys(ztResult || {}).join(', ')}] – ereignisse: ${ztResult?.ereignisse?.length ?? 'FEHLT'}`);
      if (Array.isArray(ztResult?.ereignisse)) {
        logger.info(`Job ${jobId}: Speichere ${ztResult.ereignisse.length} Zeitstrahl-Ereignisse…`);
        saveZeitstrahlEvents(parseInt(bookId), userEmail || null, ztResult.ereignisse);
        logger.info(`Job ${jobId}: ${ztResult.ereignisse.length} Zeitstrahl-Ereignisse gespeichert.`);
      }
    }

    await Promise.all([

      // ── P5+P7 (multi-pass) oder P5+P7 separat (single-pass) ─────────────
      totalChars > SINGLE_PASS_LIMIT
        ? (async () => {
            // Multi-Pass: ein kombinierter Call pro Kapitel für Szenen + Entwicklungsbögen
            const orteKompakt = orte.map(o => ({ id: o.id, name: o.name }));
            const figurenList = figuren.map(f => ({ id: f.id, name: f.name, typ: f.typ || 'andere' }));
            updateJob(jobId, { progress: 63, statusText: `Szenen + Entwicklungsbögen in ${groupOrder.length} Kapiteln…` });
            const locRows = db.prepare(
              'SELECT id, loc_id FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
            ).all(parseInt(bookId), userEmail || null);
            const locIdToDbId = Object.fromEntries(locRows.map(r => [r.loc_id, r.id]));

            const kombinedSettled = await settledAll(
              groupOrder.map(key => () => {
                const group = groups.get(key);
                const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
                return call(jobId, tok,
                  buildExtraktionSzenenEreignisseEntwicklungsbogenChapterPrompt(
                    group.name, bookName, group.pages.length, figurenList, orteKompakt, chText
                  ),
                  SYSTEM_SZENEN, 63, 80, 6000,
                );
              })
            );

            // Etappen für P7-Kons sammeln; Szenen + Events wie gehabt verarbeiten
            const etappenPerChapter = [];
            kombinedSettled.forEach((r, gi) => {
              if (r.status === 'fulfilled' && Array.isArray(r.value?.etappen) && r.value.etappen.length)
                etappenPerChapter.push({ kapitel: groups.get(groupOrder[gi]).name, etappen: r.value.etappen });
            });
            await processSzenenEreignisse(kombinedSettled, locIdToDbId);

            // P6 + P7-Kons parallel (keine gegenseitige Abhängigkeit)
            await Promise.all([
              runZeitstrahlKonsolidierung(),

              (async () => {
                if (!figRowsForArcs.length || !etappenPerChapter.length) return;
                updateJob(jobId, { progress: 94, statusText: 'Konsolidiere Entwicklungsbögen…' });
                const arcConsolidation = await call(jobId, tok,
                  buildEntwicklungsbogenConsolidationPrompt(bookName, figurenKontextForArcs, etappenPerChapter),
                  SYSTEM_ENTWICKLUNGSBOGEN, 94, 97, 4000, 0.2, null,
                );
                logger.info(`Job ${jobId}: arcConsolidation Keys: [${Object.keys(arcConsolidation || {}).join(', ')}] – entwicklungsboegen: ${arcConsolidation?.entwicklungsboegen?.length ?? 'FEHLT'}`);
                if (!Array.isArray(arcConsolidation?.entwicklungsboegen)) throw new Error('Entwicklungsbögen-Konsolidierung ungültig: entwicklungsboegen-Array fehlt');
                logger.info(`Job ${jobId}: Speichere ${arcConsolidation.entwicklungsboegen.length} Entwicklungsbögen (Konsolidierung)…`);
                saveCharacterArcs(parseInt(bookId), userEmail || null, arcConsolidation.entwicklungsboegen, idMaps.chNameToId);
                logger.info(`Job ${jobId}: ${arcConsolidation.entwicklungsboegen.length} Entwicklungsbögen gespeichert.`);
              })(),
            ]);
          })()
        : Promise.all([
            // Single-Pass: P5 (per-Kapitel) + P7 (Single-Pass) parallel
            (async () => {
              const orteKompakt = orte.map(o => ({ id: o.id, name: o.name }));
              const figurenList = figuren.map(f => ({ id: f.id, name: f.name, typ: f.typ || 'andere' }));
              updateJob(jobId, { progress: 63, statusText: `Szenen + Ereignisse in ${groupOrder.length} Kapiteln extrahieren…` });
              const locRows = db.prepare(
                'SELECT id, loc_id FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
              ).all(parseInt(bookId), userEmail || null);
              const locIdToDbId = Object.fromEntries(locRows.map(r => [r.loc_id, r.id]));
              const szEvtSettled = await settledAll(
                groupOrder.map(key => () => {
                  const group = groups.get(key);
                  const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
                  return call(jobId, tok,
                    buildExtraktionSzenenEreignisseChapterPrompt(group.name, bookName, group.pages.length, figurenList, orteKompakt, chText),
                    SYSTEM_SZENEN, 63, 80, 4000,
                  );
                })
              );
              await processSzenenEreignisse(szEvtSettled, locIdToDbId);
              await runZeitstrahlKonsolidierung();
            })(),

            (async () => {
              if (!figRowsForArcs.length) return;
              updateJob(jobId, { progress: 89, statusText: 'Entwicklungsbögen analysieren…' });
              const bookText = pageContents
                .map(p => `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`)
                .join('\n\n---\n\n');
              const arcResult = await call(jobId, tok,
                buildEntwicklungsbogenSinglePassPrompt(bookName, figurenKontextForArcs, pageContents.length, bookText),
                SYSTEM_ENTWICKLUNGSBOGEN, 89, 95, 4000, 0.2, null,
              );
              logger.info(`Job ${jobId}: arcResult Keys: [${Object.keys(arcResult || {}).join(', ')}] – entwicklungsboegen: ${arcResult?.entwicklungsboegen?.length ?? 'FEHLT'}`);
              if (!Array.isArray(arcResult?.entwicklungsboegen)) throw new Error('Entwicklungsbögen-Analyse ungültig: entwicklungsboegen-Array fehlt');
              logger.info(`Job ${jobId}: Speichere ${arcResult.entwicklungsboegen.length} Entwicklungsbögen (Single-Pass)…`);
              saveCharacterArcs(parseInt(bookId), userEmail || null, arcResult.entwicklungsboegen, idMaps.chNameToId);
              logger.info(`Job ${jobId}: ${arcResult.entwicklungsboegen.length} Entwicklungsbögen gespeichert.`);
            })(),
          ]),

      // ── P8: Kontinuitätsprüfung ───────────────────────────────────────────
      // Multi-Pass: chapterFakten aus Phase 1 – kein separater Extraktions-Call.
      // Single-Pass: Buchtext direkt (besserer Kontext für kleine Bücher).
      // Fallback: alter Checkpoint ohne chapterFakten → Extraktion nachholen.
      (async () => {
        const figKompaktForKont  = figuren.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
        const figNameToId        = Object.fromEntries(figuren.map(f => [f.name, f.id]));
        const ortRowsForKont     = db.prepare(
          'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
        ).all(parseInt(bookId), userEmail || null);
        const orteKompaktForKont = ortRowsForKont.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));

        let kontResult;
        if (totalChars <= SINGLE_PASS_LIMIT) {
          updateJob(jobId, { progress: 97, statusText: 'Kontinuität prüfen…' });
          const bookText = pageContents
            .map(p => `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`)
            .join('\n\n---\n\n');
          logger.info(`Job ${jobId}: Kontinuität Single-Pass: ${bookText.length} Zeichen Buchtext, ${figKompaktForKont.length} Figuren, ${orteKompaktForKont.length} Orte`);
          kontResult = await call(jobId, tok,
            buildKontinuitaetSinglePassPrompt(bookName, bookText, figKompaktForKont, orteKompaktForKont),
            SYSTEM_KONTINUITAET, 97, 99, 5000,
          );
        } else if (chapterFakten?.length) {
          // Normal-Pfad multi-pass: Fakten aus Phase 1 – kein zusätzlicher API-Call
          updateJob(jobId, { progress: 98, statusText: 'KI prüft Widersprüche…' });
          const totalFaktenChars = chapterFakten.reduce((s, c) => s + JSON.stringify(c.fakten).length, 0);
          logger.info(`Job ${jobId}: Kontinuität Multi-Pass: ${chapterFakten.length} Kapitel, ~${totalFaktenChars} Zeichen Fakten, ${figKompaktForKont.length} Figuren`);
          kontResult = await call(jobId, tok,
            buildKontinuitaetCheckPrompt(bookName, chapterFakten, figKompaktForKont, orteKompaktForKont),
            SYSTEM_KONTINUITAET, 98, 99, 5000,
          );
        } else {
          // Fallback: alter Checkpoint ohne chapterFakten – Extraktion nachholen
          updateJob(jobId, { progress: 97, statusText: `Kontinuität – Fakten in ${groupOrder.length} Kapiteln extrahieren…` });
          const factsSettled = await settledAll(
            groupOrder.map(key => () => {
              const group = groups.get(key);
              const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
              return call(jobId, tok,
                buildKontinuitaetChapterFactsPrompt(group.name, chText),
                SYSTEM_KONTINUITAET, 97, 98, 1500,
              );
            })
          );
          const chFacts = factsSettled.map((r, gi) => {
            const group = groups.get(groupOrder[gi]);
            if (r.status === 'rejected') {
              logger.warn(`Job ${jobId}: Kontinuität-Fakten «${group.name}» übersprungen: ${r.reason?.message}`);
              return { kapitel: group.name, fakten: [] };
            }
            return { kapitel: group.name, fakten: r.value?.fakten || [] };
          });
          updateJob(jobId, { progress: 98, statusText: 'KI prüft Widersprüche…' });
          kontResult = await call(jobId, tok,
            buildKontinuitaetCheckPrompt(bookName, chFacts, figKompaktForKont, orteKompaktForKont),
            SYSTEM_KONTINUITAET, 98, 99, 5000,
          );
        }

        logger.info(`Job ${jobId}: kontResult Keys: [${Object.keys(kontResult || {}).join(', ')}] – probleme: ${kontResult?.probleme?.length ?? '?'}, zusammenfassung: ${kontResult?.zusammenfassung?.length ?? '?'} Zeichen`);
        if (typeof kontResult?.zusammenfassung !== 'undefined') {
          const normalizedProbleme = (kontResult.probleme || []).map(issue => ({
            ...issue,
            fig_ids:     (issue.figuren  || []).map(n => figNameToId[n]).filter(Boolean),
            chapter_ids: (issue.kapitel  || []).map(n => idMaps.chNameToId[n]).filter(Boolean),
          }));
          const effectiveProvider = provider || process.env.API_PROVIDER || 'claude';
          const model = effectiveProvider === 'ollama'
            ? (process.env.OLLAMA_MODEL || 'llama3.2')
            : (process.env.MODEL_NAME || 'claude-sonnet-4-6');
          logger.info(`Job ${jobId}: Speichere Kontinuitätsprüfung (${normalizedProbleme.length} Probleme)…`);
          db.prepare(`INSERT INTO continuity_checks (book_id, user_email, checked_at, issues_json, summary, model)
            VALUES (?, ?, ?, ?, ?, ?)`)
            .run(parseInt(bookId), userEmail || null, new Date().toISOString(),
              JSON.stringify(normalizedProbleme), kontResult.zusammenfassung || '', model);
          logger.info(`Job ${jobId}: Kontinuitätsprüfung abgeschlossen (${normalizedProbleme.length} Probleme).`);
        }
      })(),

    ]); // Ende Parallel-Block 2

    deleteCheckpoint('komplett-analyse', bookId, userEmail);
    completeJob(jobId, {
      figCount:   figuren.length,
      orteCount:  orte.length,
      szenenCount: allSzenen.length,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok));
    logger.info(`Job ${jobId}: Komplettanalyse Buch ${bookId} abgeschlossen (${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Komplettanalyse Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Seiten-Lektorat ──────────────────────────────────────────────────────
async function runCheckJob(jobId, pageId, bookId, userEmail, userToken) {
  const { buildLektoratPrompt } = await getPrompts();
  const { SYSTEM_LEKTORAT, STOPWORDS: lektoratStopwords, ERKLAERUNG_RULE: lektoratErklaerungRule } = await getBookPrompts(bookId);
  try {
    updateJob(jobId, { statusText: 'Lade Seiteninhalt…', progress: 5 });

    const authHeader = userToken
      ? `Token ${userToken.id}:${userToken.pw}`
      : `Token ${process.env.TOKEN_ID || ''}:${process.env.TOKEN_KENNWORT || ''}`;
    const pdResp = await fetch(`${BS_URL}/api/pages/${pageId}`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(30000),
    });
    if (!pdResp.ok) throw new Error(`BookStack ${pdResp.status}: ${await pdResp.text()}`);
    const pd = await pdResp.json();

    const html = pd.html;
    const text = htmlToText(html);
    if (!text.trim()) { completeJob(jobId, { empty: true }); return; }

    const tok = { in: 0, out: 0, ms: 0 };
    updateJob(jobId, { statusText: 'KI analysiert…', progress: 10 });

    const result = await aiCall(jobId, tok,
      buildLektoratPrompt(text, html, { stopwords: lektoratStopwords, erklaerungRule: lektoratErklaerungRule }),
      SYSTEM_LEKTORAT,
      10, 97, 5000,
    );

    if (!Array.isArray(result?.fehler)) throw new Error('fehler-Array fehlt');

    const model = process.env.API_PROVIDER === 'ollama'
      ? (process.env.OLLAMA_MODEL || 'llama3.2')
      : (process.env.MODEL_NAME || 'claude-sonnet-4-6');

    const szenen = Array.isArray(result?.szenen) ? result.szenen : [];

    const info = db.prepare(`INSERT INTO page_checks
      (page_id, page_name, book_id, checked_at, error_count, errors_json, szenen_json, stilanalyse, fazit, model, user_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(parseInt(pageId), pd.name, parseInt(bookId) || null,
        new Date().toISOString(), result.fehler.length, JSON.stringify(result.fehler),
        szenen.length > 0 ? JSON.stringify(szenen) : null,
        result.stilanalyse || null, result.fazit || null, model, userEmail || null);

    completeJob(jobId, {
      fehler: result.fehler,
      szenen,
      stilanalyse: result.stilanalyse || null,
      fazit: result.fazit || null,
      originalHtml: html,
      updatedAt: pd.updated_at || null,
      pageName: pd.name,
      checkId: info.lastInsertRowid,
      tokensIn: tok.in,
      tokensOut: tok.out,
    }, tps(tok));
    logger.info(`Job ${jobId}: Seiten-Check Seite ${pageId} abgeschlossen (${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Seiten-Check Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Batch-Lektorat ───────────────────────────────────────────────────────
async function runBatchCheckJob(jobId, bookId, userEmail, userToken) {
  const { buildBatchLektoratPrompt } = await getPrompts();
  const { SYSTEM_LEKTORAT, STOPWORDS: batchStopwords, ERKLAERUNG_RULE: batchErklaerungRule } = await getBookPrompts(bookId);
  try {
    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const pages = await bsGetAll('pages?book_id=' + bookId, userToken);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const tok = { in: 0, out: 0, ms: 0 };
    const model = process.env.API_PROVIDER === 'ollama'
      ? (process.env.OLLAMA_MODEL || 'llama3.2')
      : (process.env.MODEL_NAME || 'claude-sonnet-4-6');
    let done = 0, totalErrors = 0;

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const fromPct = Math.round((i / pages.length) * 95);
      const toPct   = Math.round(((i + 1) / pages.length) * 95);
      updateJob(jobId, {
        progress: fromPct,
        statusText: `${i + 1}/${pages.length}: ${p.name}…`,
      });

      try {
        const pdResp = await fetch(`${BS_URL}/api/pages/${p.id}`, {
          headers: { Authorization: authHeader },
          signal: AbortSignal.timeout(30000),
        });
        if (!pdResp.ok) throw new Error(`BookStack ${pdResp.status}: ${await pdResp.text()}`);
        const pd = await pdResp.json();
        const text = htmlToText(pd.html).trim();
        if (!text) continue;

        const result = await aiCall(jobId, tok,
          buildBatchLektoratPrompt(text, { stopwords: batchStopwords, erklaerungRule: batchErklaerungRule }),
          SYSTEM_LEKTORAT,
          fromPct, toPct, 2000,
        );

        if (!Array.isArray(result?.fehler)) throw new Error('fehler-Array fehlt');
        const fehler = result.fehler;
        totalErrors += fehler.filter(f => f.typ !== 'stil').length;

        const szenenBatch = Array.isArray(result?.szenen) ? result.szenen : [];
        db.prepare(`INSERT INTO page_checks
          (page_id, page_name, book_id, checked_at, error_count, errors_json, szenen_json, stilanalyse, fazit, model, user_email)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(p.id, p.name, parseInt(bookId), new Date().toISOString(),
            fehler.length, JSON.stringify(fehler),
            szenenBatch.length > 0 ? JSON.stringify(szenenBatch) : null,
            result.stilanalyse || null, result.fazit || null, model, userEmail || null);
        done++;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        logger.warn(`Job ${jobId}: Batch-Check Seite ${p.id} («${p.name}») übersprungen: ${e.message}`);
      }
    }

    completeJob(jobId, { pageCount: pages.length, done, totalErrors, tokensIn: tok.in, tokensOut: tok.out }, tps(tok));
    logger.info(`Job ${jobId}: Batch-Check Buch ${bookId} abgeschlossen (${done}/${pages.length} Seiten, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Batch-Check Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Chat ─────────────────────────────────────────────────────────────────
async function runChatJob(jobId, sessionId, userMsgId, message, userEmail, userToken) {
  const { buildChatSystemPrompt } = await getPrompts();
  try {
    updateJob(jobId, { statusText: 'Vorbereitung…', progress: 5 });

    const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_email = ?')
      .get(parseInt(sessionId), userEmail);
    if (!session) throw new Error('Session nicht gefunden');

    // User-Nachricht wurde bereits im Route-Handler gespeichert (userMsgId)

    // Seiteninhalt frisch aus BookStack laden (User-Token bevorzugt, analog zu runCheckJob)
    let pageText = '';
    if (session.page_id && session.page_id > 0) {
      try {
        const authHeader = userToken
          ? `Token ${userToken.id}:${userToken.pw}`
          : `Token ${process.env.TOKEN_ID || ''}:${process.env.TOKEN_KENNWORT || ''}`;
        const pdResp = await fetch(`${BS_URL}/api/pages/${session.page_id}`, {
          headers: { Authorization: authHeader },
          signal: AbortSignal.timeout(30000),
        });
        if (!pdResp.ok) throw new Error(`BookStack ${pdResp.status}: ${await pdResp.text()}`);
        const pd = await pdResp.json();
        pageText = htmlToText(pd.html || '');
      } catch (e) {
        logger.warn(`Job ${jobId}: Seiteninhalt konnte nicht geladen werden: ${e.message}`);
      }
    }

    // Kontext aus DB laden – nur Figuren/Szenen/Orte des aktuellen Kapitels
    const pageRow = session.page_id
      ? db.prepare('SELECT chapter_name FROM pages WHERE page_id = ?').get(session.page_id)
      : null;
    const figuren = _chatGetFiguren(session.book_id, userEmail, pageRow?.chapter_name ?? null);
    const review  = _chatGetLatestReview(session.book_id, userEmail);
    const { SYSTEM_CHAT: chatSysPrompt } = await getBookPrompts(session.book_id);
    const systemPrompt = buildChatSystemPrompt(session.page_name || 'Unbekannte Seite', pageText, figuren, review, chatSysPrompt);

    // Konversationshistorie aufbauen (identisch zu chat.js /send)
    const historyWithoutLast = _chatBuildMessageHistory(session.id).slice(0, -1);
    const aiMessages = [...historyWithoutLast, { role: 'user', content: message }];

    updateJob(jobId, { statusText: 'KI antwortet…', progress: 10 });

    const onProgress = ({ chars, tokIn }) => {
      const updates = { progress: Math.min(97, 10 + Math.round(chars / 50)) };
      if (tokIn > 0)  updates.tokensIn  = tokIn;
      if (chars > 0)  updates.tokensOut = Math.floor(chars / 4);
      updateJob(jobId, updates);
    };

    const { text, tokensIn, tokensOut, genDurationMs } = await callAIChat(aiMessages, systemPrompt, onProgress, jobAbortControllers.get(jobId)?.signal);

    // Antwort parsen
    let antwort = text;
    let vorschlaege = [];
    try {
      const clean = text.replace(/```json\s*|```/g, '').trim();
      const parsed = JSON.parse(clean);
      antwort     = parsed.antwort     ?? text;
      vorschlaege = parsed.vorschlaege ?? [];
    } catch {
      logger.warn(`Job ${jobId}: Chat-Antwort kein valides JSON – Rohtext wird gespeichert.`);
    }

    // Assistant-Nachricht in DB speichern
    const assistantNow = new Date().toISOString();
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, vorschlaege, tokens_in, tokens_out, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?)
    `).run(
      session.id, antwort,
      vorschlaege.length > 0 ? JSON.stringify(vorschlaege) : null,
      tokensIn, tokensOut, assistantNow
    );
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);

    const chatTps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      tokensIn, tokensOut,
    }, chatTps);
    logger.info(`Job ${jobId}: Chat session ${sessionId} abgeschlossen (${fmtTok(tokensIn)}↑ ${fmtTok(tokensOut)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Chat Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Buch-Chat ────────────────────────────────────────────────────────────

// Fallback-Stoppwörter für Book-Chat (Default-Locale); wird pro Job locale-spezifisch überschrieben
const _BOOK_CHAT_STOPWORDS = new Set(
  (() => {
    const def = _promptConfig.defaultLocale || 'de-CH';
    return (_promptConfig.locales?.[def]?.stopwords) || _promptConfig.stopwords || [];
  })()
);

// Seiten-Cache: Key `${bookId}:${userEmail}` → { pages: [{name, id, slug, book_slug, text}], loadedAt }
// TTL 10 Minuten – verhindert, dass jede Nachricht alle BookStack-API-Calls wiederholt.
const _bookPageCache = new Map();
const _BOOK_PAGE_CACHE_TTL_MS = 10 * 60 * 1000;

function _scorePageRelevance(query, text, stopwords = _BOOK_CHAT_STOPWORDS) {
  const tokens = query.toLowerCase()
    .split(/[\s,\.!?;:«»"'()\[\]{}]+/)
    .filter(w => w.length >= 3 && !stopwords.has(w));
  if (!tokens.length) return 0;
  const textLow = text.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    const re = new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    score += Math.min((textLow.match(re) || []).length, 5);
  }
  return score;
}

async function runBookChatJob(jobId, sessionId, userMsgId, message, userEmail, userToken) {
  const { buildBookChatSystemPrompt } = await getPrompts();
  try {
    updateJob(jobId, { statusText: 'Vorbereitung…', progress: 5 });

    const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_email = ?')
      .get(parseInt(sessionId), userEmail);
    if (!session) throw new Error('Session nicht gefunden');

    const { SYSTEM_BOOK_CHAT: bookChatSys, STOPWORDS: bookChatSW } = await getBookPrompts(session.book_id);
    const bookChatStopwords = new Set(bookChatSW || []);

    if (!userToken) throw new Error('Kein BookStack-Token in der Session – bitte neu einloggen.');

    const authHeader = `Token ${userToken.id}:${userToken.pw}`;
    const cacheKey = `${session.book_id}:${userEmail}`;

    // ── Schritt 1: Seiten aus Cache oder frisch von BookStack laden ─────────────
    let pageContents;
    const cached = _bookPageCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < _BOOK_PAGE_CACHE_TTL_MS) {
      pageContents = cached.pages;
      updateJob(jobId, { statusText: 'Seiten aus Cache…', progress: 40 });
    } else {
      updateJob(jobId, { statusText: 'Seitenliste laden…', progress: 8 });
      const pagesListResp = await fetch(
        `${BS_URL}/api/pages?filter[book_id]=${session.book_id}&count=500`,
        { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(30000) }
      );
      if (!pagesListResp.ok) throw new Error(`BookStack Seitenliste ${pagesListResp.status}`);
      const pages = (await pagesListResp.json()).data || [];

      const BATCH = 5;
      pageContents = [];
      for (let i = 0; i < pages.length; i += BATCH) {
        updateJob(jobId, {
          statusText: `Seiten laden… ${Math.min(i + BATCH, pages.length)}/${pages.length}`,
          progress: 10 + Math.round((i / Math.max(pages.length, 1)) * 30),
        });
        const batch = pages.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(async p => {
          const r = await fetch(`${BS_URL}/api/pages/${p.id}`, {
            headers: { Authorization: authHeader },
            signal: AbortSignal.timeout(30000),
          });
          if (!r.ok) return null;
          const pd = await r.json();
          const text = htmlToText(pd.html || '').trim();
          return text ? { name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug, text } : null;
        }));
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) pageContents.push(r.value);
        }
      }
      _bookPageCache.set(cacheKey, { pages: pageContents, loadedAt: Date.now() });
    }

    // ── Schritt 2: Historien-Rolling-Window (Anker + letzte 10 Nachrichten) ─────
    const historyWithoutLast = _bookChatBuildHistory(session.id).slice(0, -1);
    const historyChars = historyWithoutLast.reduce((s, m) => s + (m.content?.length || 0), 0);

    // ── Schritt 3: Dynamisches Text-Budget ──────────────────────────────────────
    const MODEL_TOKEN = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
    const TOTAL_CHAR_BUDGET     = MODEL_TOKEN * 4;
    const SYSTEM_OVERHEAD_CHARS = 8000;   // ~2k Tokens für System-Prompt-Overhead
    const ANSWER_RESERVE_CHARS  = 8000;   // ~2k Tokens Reserve für Antwort
    const TEXT_CHAR_BUDGET = Math.max(
      20000,
      Math.floor((TOTAL_CHAR_BUDGET - historyChars - SYSTEM_OVERHEAD_CHARS - ANSWER_RESERVE_CHARS) * 0.98)
    );

    // ── Schritt 4: Relevanz-Scoring + Seitenauswahl ─────────────────────────────
    updateJob(jobId, { statusText: 'Relevante Seiten auswählen…', progress: 42 });
    const scored = pageContents.map(p => ({ ...p, score: _scorePageRelevance(message, p.text, bookChatStopwords) }));
    const anyScore = scored.some(p => p.score > 0);
    if (anyScore) scored.sort((a, b) => b.score - a.score);

    const selectedPages = [];
    let usedChars = 0;
    if (!anyScore && scored.length > 0) {
      // Gleichmässige Verteilung: jede Seite bekommt denselben Anteil → Querschnitt durch das Buch
      const perPage = Math.floor(TEXT_CHAR_BUDGET / scored.length);
      for (const p of scored) {
        const text = p.text.slice(0, perPage);
        if (text.length >= 100) {
          selectedPages.push({ name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug, text });
          usedChars += text.length;
        }
      }
    } else {
      // Relevanz-sortiert: Top-Seiten zuerst bis Budget erschöpft
      for (const p of scored) {
        if (usedChars >= TEXT_CHAR_BUDGET) break;
        const remaining = TEXT_CHAR_BUDGET - usedChars;
        const text = p.text.slice(0, remaining);
        selectedPages.push({ name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug, text });
        usedChars += text.length;
      }
    }

    const cacheAge = _bookPageCache.has(cacheKey)
      ? Math.round((Date.now() - _bookPageCache.get(cacheKey).loadedAt) / 1000) + 's'
      : 'MISS';
    logger.info(
      `Job ${jobId}: Buch-Chat – ${selectedPages.length}/${pageContents.length} Seiten im Kontext ` +
      `(${usedChars}/${TEXT_CHAR_BUDGET} Zeichen, Hist ${Math.round(historyChars / 1000)}k Zeichen, ` +
      `${anyScore ? 'Keyword-Scoring' : 'Gleichverteilung'}, Cache ${cacheAge}).`
    );

    // ── System-Prompt + KI-Aufruf ───────────────────────────────────────────────
    const figuren = _chatGetFiguren(session.book_id, userEmail);
    const review  = _chatGetLatestReview(session.book_id, userEmail);
    const systemPrompt = buildBookChatSystemPrompt(session.book_name || '', selectedPages, figuren, review, bookChatSys);
    const contextInfo = {
      pages:      selectedPages.map(p => ({ name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug })),
      totalPages: pageContents.length,
      figuren:    figuren.length > 0,
      review:     !!review,
    };

    const aiMessages = [...historyWithoutLast, { role: 'user', content: message }];

    updateJob(jobId, { statusText: 'KI antwortet…', progress: 50 });

    const onProgress = ({ chars, tokIn }) => {
      const updates = { progress: Math.min(97, 50 + Math.round(chars / 50)) };
      if (tokIn > 0)  updates.tokensIn  = tokIn;
      if (chars > 0)  updates.tokensOut = Math.floor(chars / 4);
      updateJob(jobId, updates);
    };

    const { text, tokensIn, tokensOut, genDurationMs } = await callAIChat(aiMessages, systemPrompt, onProgress, jobAbortControllers.get(jobId)?.signal);

    // Antwort parsen (nur "antwort"-Feld, kein vorschlaege)
    let antwort = text;
    try {
      const clean = text.replace(/```json\s*|```/g, '').trim();
      const parsed = JSON.parse(clean);
      antwort = parsed.antwort ?? text;
    } catch {
      logger.warn(`Job ${jobId}: Buch-Chat-Antwort kein valides JSON – Rohtext wird gespeichert.`);
    }

    // Assistant-Nachricht in DB speichern (vorschlaege=NULL)
    const assistantNow = new Date().toISOString();
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, context_info, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?)
    `).run(session.id, antwort, tokensIn, tokensOut, JSON.stringify(contextInfo), assistantNow);
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);

    const bookChatTps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      tokensIn, tokensOut,
      pagesUsed: selectedPages.length,
      pagesTotal: pageContents.length,
    }, bookChatTps);
    logger.info(`Job ${jobId}: Buch-Chat session ${sessionId} abgeschlossen (${fmtTok(tokensIn)}↑ ${fmtTok(tokensOut)}↓, ${selectedPages.length}/${pageContents.length} Seiten).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Buch-Chat Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Routen ────────────────────────────────────────────────────────────────────
router.post('/check', jsonBody, (req, res) => {
  const { page_id, book_id, page_name } = req.body;
  if (!page_id) return res.status(400).json({ error: 'page_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken
    ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw }
    : null;
  const existing = runningJobs.get(jobKey('check', page_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = page_name ? `Lektorat · ${page_name}` : `Lektorat · Seite #${page_id}`;
  const jobId = createJob('check', page_id, userEmail, label);
  enqueueJob(jobId, () => runCheckJob(jobId, page_id, book_id || null, userEmail, userToken));
  res.json({ jobId });
});

router.post('/review', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw } : null;
  const existing = runningJobs.get(jobKey('review', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Buchbewertung · ${book_name}` : `Buchbewertung`;
  const jobId = createJob('review', book_id, userEmail, label);
  enqueueJob(jobId, () => runReviewJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

router.post('/komplett-analyse', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw } : null;
  const existing = runningJobs.get(jobKey('komplett-analyse', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Komplettanalyse · ${book_name}` : 'Komplettanalyse';
  const jobId = createJob('komplett-analyse', book_id, userEmail, label);
  enqueueJob(jobId, () => runKomplettAnalyseJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

router.post('/batch-check', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken
    ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw }
    : null;
  const existing = runningJobs.get(jobKey('batch-check', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Serien-Lektorat · ${book_name}` : `Serien-Lektorat`;
  const jobId = createJob('batch-check', book_id, userEmail, label);
  enqueueJob(jobId, () => runBatchCheckJob(jobId, book_id, userEmail, userToken));
  res.json({ jobId });
});

router.post('/chat', jsonBody, (req, res) => {
  const { session_id, message, page_text } = req.body;
  if (!session_id || !message?.trim()) return res.status(400).json({ error: 'session_id und message erforderlich' });
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error: 'Nicht eingeloggt' });
  const existing = runningJobs.get(jobKey('chat', session_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });

  // User-Nachricht sofort in DB speichern – bevor der Job überhaupt startet,
  // damit sie auch bei Tab-Schliessen oder Job-Fehler persistent ist.
  const session = db.prepare('SELECT id, page_name, book_name FROM chat_sessions WHERE id = ? AND user_email = ?')
    .get(parseInt(session_id), userEmail);
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden' });

  const now = new Date().toISOString();
  const userMsgResult = db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)`
  ).run(session.id, message.trim(), now);
  db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(now, session.id);

  const userToken = req.session?.bookstackToken
    ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw }
    : null;

  const chatLabel = session.page_name ? `Chat · ${session.page_name}` : `Chat`;
  const jobId = createJob('chat', session_id, userEmail, chatLabel);
  enqueueJob(jobId, () => runChatJob(jobId, session_id, userMsgResult.lastInsertRowid, message.trim(), userEmail, userToken));
  res.json({ jobId });
});

router.post('/book-chat', jsonBody, (req, res) => {
  const { session_id, message } = req.body;
  if (!session_id || !message?.trim()) return res.status(400).json({ error: 'session_id und message erforderlich' });
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error: 'Nicht eingeloggt' });
  const existing = runningJobs.get(jobKey('book-chat', session_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });

  const session = db.prepare('SELECT id, book_name FROM chat_sessions WHERE id = ? AND user_email = ?')
    .get(parseInt(session_id), userEmail);
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden' });

  const now = new Date().toISOString();
  const userMsgResult = db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)`
  ).run(session.id, message.trim(), now);
  db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(now, session.id);

  const userToken = req.session?.bookstackToken
    ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw }
    : null;

  const bookChatLabel = session.book_name ? `Buch-Chat · ${session.book_name}` : `Buch-Chat`;
  const jobId = createJob('book-chat', session_id, userEmail, bookChatLabel);
  enqueueJob(jobId, () => runBookChatJob(jobId, session_id, userMsgResult.lastInsertRowid, message.trim(), userEmail, userToken));
  res.json({ jobId });
});

// ── Job: Kontinuitätsprüfung ──────────────────────────────────────────────────
async function runKontinuitaetJob(jobId, bookId, bookName, userEmail, userToken) {
  const { buildKontinuitaetSinglePassPrompt, buildKontinuitaetChapterFactsPrompt, buildKontinuitaetCheckPrompt } = await getPrompts();
  const { SYSTEM_KONTINUITAET } = await getBookPrompts(bookId);

  try {
    const cp = loadCheckpoint('kontinuitaet', bookId, userEmail);
    if (cp) logger.info(`Job ${jobId}: Kontinuitätsprüfung Buch ${bookId} – Checkpoint gefunden (${cp.nextGi} Kapitel bereits fertig), setze fort.`);

    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId, userToken),
      bsGetAll('pages?book_id=' + bookId, userToken),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const chNameToId = Object.fromEntries(chaptersData.map(c => [c.name, c.id]));
    const tok = { in: 0, out: 0, ms: 0 };

    // Bekannte Figuren + Orte aus DB laden
    const figRows = db.prepare(`
      SELECT f.fig_id, f.name, f.typ, f.beschreibung FROM figures f
      WHERE f.book_id = ? AND f.user_email = ? ORDER BY f.sort_order
    `).all(parseInt(bookId), userEmail || null);
    const figurenKompakt = figRows.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
    const figNameToId = Object.fromEntries(figRows.map(r => [r.name, r.fig_id]));

    const ortRows = db.prepare(
      'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(parseInt(bookId), userEmail || null);
    const orteKompakt = ortRows.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));

    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 50),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    }, userToken);

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    let result;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      updateJob(jobId, { progress: 60, statusText: 'KI prüft Kontinuität…' });
      const bookText = pageContents
        .map(p => `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`)
        .join('\n\n---\n\n');
      result = await aiCall(jobId, tok,
        buildKontinuitaetSinglePassPrompt(bookName, bookText, figurenKompakt, orteKompakt),
        SYSTEM_KONTINUITAET,
        60, 97, 5000,
      );
    } else {
      // Multi-Pass: Fakten pro Kapitel extrahieren – ggf. aus Checkpoint fortsetzen
      const { groupOrder, groups } = groupByChapter(pageContents);

      let chapterFacts = cp?.chapterFacts ?? [];
      const startGi = cp?.nextGi ?? 0;

      if (startGi > 0) {
        updateJob(jobId, {
          progress: 50 + Math.round((startGi / groupOrder.length) * 35),
          statusText: `Setze Fakten-Extraktion fort (${startGi}/${groupOrder.length} Kapitel bereits fertig)…`,
        });
      }

      for (let gi = startGi; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const fromPct = 50 + Math.round((gi / groupOrder.length) * 35);
        const toPct   = 50 + Math.round(((gi + 1) / groupOrder.length) * 35);
        updateJob(jobId, {
          progress: fromPct,
          statusText: `Fakten in «${group.name}» (${gi + 1}/${groupOrder.length})…`,
        });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        let chResult;
        try {
          chResult = await aiCall(jobId, tok,
            buildKontinuitaetChapterFactsPrompt(group.name, chText),
            SYSTEM_KONTINUITAET,
            fromPct, toPct, 1500,
          );
          chapterFacts.push({ kapitel: group.name, fakten: chResult.fakten || [] });
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          logger.warn(`Job ${jobId}: Fakten-Extraktion Kapitel «${group.name}» übersprungen: ${e.message}`);
        }
        saveCheckpoint('kontinuitaet', bookId, userEmail, { chapterFacts, nextGi: gi + 1 });
      }

      updateJob(jobId, {
        progress: 88,
        statusText: `KI prüft Widersprüche…`,
      });
      result = await aiCall(jobId, tok,
        buildKontinuitaetCheckPrompt(bookName, chapterFacts, figurenKompakt, orteKompakt),
        SYSTEM_KONTINUITAET,
        88, 97, 5000,
      );
    }

    if (typeof result?.zusammenfassung === 'undefined') throw new Error('KI-Antwort ungültig: zusammenfassung fehlt');

    const normalizedProbleme = (result.probleme || []).map(issue => ({
      ...issue,
      fig_ids:     (issue.figuren || []).map(n => figNameToId[n]).filter(Boolean),
      chapter_ids: (issue.kapitel || []).map(n => chNameToId[n]).filter(Boolean),
    }));

    const model = process.env.API_PROVIDER === 'ollama'
      ? (process.env.OLLAMA_MODEL || 'llama3.2')
      : (process.env.MODEL_NAME || 'claude-sonnet-4-6');

    db.prepare(`INSERT INTO continuity_checks (book_id, user_email, checked_at, issues_json, summary, model)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(parseInt(bookId), userEmail || null, new Date().toISOString(),
        JSON.stringify(normalizedProbleme), result.zusammenfassung || '', model);

    deleteCheckpoint('kontinuitaet', bookId, userEmail);
    completeJob(jobId, {
      count: normalizedProbleme.length,
      issues: normalizedProbleme,
      zusammenfassung: result.zusammenfassung,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok));
    logger.info(`Job ${jobId}: Kontinuitätsprüfung Buch ${bookId} abgeschlossen (${(result.probleme || []).length} Probleme, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Kontinuitätsprüfung Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

router.post('/kontinuitaet', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw } : null;
  const existing = runningJobs.get(jobKey('kontinuitaet', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Kontinuität · ${book_name}` : `Kontinuität`;
  const jobId = createJob('kontinuitaet', book_id, userEmail, label);
  enqueueJob(jobId, () => runKontinuitaetJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

router.get('/kontinuitaet/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const userEmail = req.session?.user?.email || null;
  const row = db.prepare(`
    SELECT id, checked_at, issues_json, summary, model
    FROM continuity_checks
    WHERE book_id = ? AND user_email = ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(bookId, userEmail);
  if (!row) return res.json(null);
  let issues = [];
  try { issues = JSON.parse(row.issues_json); } catch { /* ignore */ }
  res.json({ id: row.id, checked_at: row.checked_at, issues, summary: row.summary, model: row.model });
});

router.delete('/book-chat-cache', (req, res) => {
  const { book_id } = req.query;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const key = `${book_id}:${userEmail}`;
  _bookPageCache.delete(key);
  res.json({ ok: true });
});

router.get('/queue', (req, res) => {
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

const JOB_TYPE_LABELS = {
  'check':                  'Lektorat',
  'batch-check':            'Stapel-Check',
  'komplett-analyse':       'Komplettanalyse',
  'review':                 'Buchbewertung',
  'figures':                'Figuren',
  'figure-events':          'Figuren-Ereignisse',
  'szenen':                 'Szenen',
  'consolidate-zeitstrahl': 'Zeitleiste',
  'book-chat':              'Buch-Chat',
  'chat':                   'Seiten-Chat',
  'locations':              'Schauplätze',
  'kontinuitaet':           'Kontinuität',
  'soziogramm':             'Soziogramm',
  'character-arcs':         'Entwicklungsbögen',
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
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return 'heute';
  if (diffDays === 1) return 'gestern';
  if (diffDays < 7) return `vor ${diffDays} Tagen`;
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' });
}

// Job-Typen, die vom Superjob (komplett-analyse) abgedeckt werden und nicht in der Statistik erscheinen sollen
const STATS_EXCLUDED_TYPES = ['figures', 'soziogramm', 'szenen', 'locations', 'character-arcs', 'figure-events', 'consolidate-zeitstrahl', 'kontinuitaet'];

router.get('/stats', (req, res) => {
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

router.get('/last-run', (req, res) => {
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

router.get('/active', (req, res) => {
  const { type, book_id, page_id } = req.query;
  const entityId = page_id || book_id;
  if (!type || !entityId) return res.status(400).json({ error: 'type und book_id (oder page_id) erforderlich' });
  const userEmail = req.session?.user?.email || null;
  const jobId = runningJobs.get(jobKey(type, entityId, userEmail));
  if (!jobId || !jobs.has(jobId)) return res.json({ jobId: null });
  const job = jobs.get(jobId);
  res.json({ jobId: job.id, status: job.status, progress: job.progress, statusText: job.statusText });
});

router.delete('/:id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });
  const ok = cancelJob(req.params.id, userEmail);
  if (!ok) return res.status(400).json({ error: `Job kann nicht abgebrochen werden (Status: ${job.status})` });
  res.json({ ok: true });
});

router.get('/:id', (req, res) => {
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

// ── Nacht-Cron: Komplettanalyse für alle Bücher × alle User ──────────────────
async function runKomplettAnalyseAll() {
  if (!process.env.OLLAMA_HOST) {
    logger.info('Nacht-Analyse übersprungen: OLLAMA_HOST nicht konfiguriert.');
    return;
  }

  const users = getAllUserTokens();
  if (!users.length) {
    logger.warn('Nacht-Analyse übersprungen: kein BookStack-Token in der Datenbank.');
    return;
  }

  // Bücherliste mit erstem verfügbaren Token holen
  let books;
  for (const u of users) {
    try {
      books = await bsGetAll('books', { id: u.token_id, pw: u.token_pw });
      break;
    } catch (e) {
      logger.warn(`Nacht-Analyse: Bücherliste mit Token von ${u.email} fehlgeschlagen – nächsten versuchen.`);
    }
  }
  if (!books) {
    logger.error('Nacht-Analyse abgebrochen: kein gültiger Token für Bücherliste gefunden.');
    return;
  }

  logger.info(`Nacht-Analyse: ${books.length} Buch/Bücher × ${users.length} User`);
  let queued = 0;
  for (const book of books) {
    for (const u of users) {
      const key = jobKey('komplett-analyse', book.id, u.email);
      if (runningJobs.has(key)) {
        logger.info(`Nacht-Analyse: Buch ${book.id} / ${u.email} läuft bereits – überspringe.`);
        continue;
      }
      const label = `Nacht · ${book.name}`;
      const userToken = { id: u.token_id, pw: u.token_pw };
      const jobId = createJob('komplett-analyse', book.id, u.email, label);
      enqueueJob(jobId, () => runKomplettAnalyseJob(jobId, book.id, book.name, u.email, userToken, 'ollama'));
      queued++;
    }
  }
  logger.info(`Nacht-Analyse: ${queued} Job(s) in Warteschlange eingereiht.`);
}

module.exports = { router, runKomplettAnalyseAll };
