'use strict';
const express = require('express');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const logger = require('../logger');
const { db, saveFigurenToDb, updateFigurenEvents, saveOrteToDb, saveCheckpoint, loadCheckpoint, deleteCheckpoint } = require('../db/schema');
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

const router = express.Router();
const jsonBody = express.json();
const jsonBodyLarge = express.json({ limit: '5mb' });

// ── Job store ─────────────────────────────────────────────────────────────────
// key: jobId → { id, type, bookId, status, progress, statusText, result, error }
const jobs = new Map();
// key: `${type}:${bookId}:${userEmail}` → jobId  (verhindert Doppel-Starts)
const runningJobs = new Map();

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
    tokensIn: 0, tokensOut: 0,
    maxTokensOut: parseInt(process.env.MODEL_TOKEN, 10) || 64000,
    result: null, error: null,
  });
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
  if (job && job.status === 'running') Object.assign(job, updates);
}

function completeJob(id, result) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, { status: 'done', progress: 100, result });
  runningJobs.delete(jobKey(job.type, job.bookId, job.userEmail));
}

function failJob(id, err) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, { status: 'error', error: err.message || String(err), progress: 0 });
  runningJobs.delete(jobKey(job.type, job.bookId, job.userEmail));
}

// ── BookStack-Helfer ──────────────────────────────────────────────────────────
const BS_URL = (process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80').replace(/\/$/, '');

async function bsGet(path) {
  const resp = await fetch(`${BS_URL}/api/${path}`, {
    headers: { Authorization: `Token ${process.env.TOKEN_ID || ''}:${process.env.TOKEN_KENNWORT || ''}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`BookStack ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function bsGetAll(path) {
  let offset = 0;
  const all = [];
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await bsGet(`${path}${sep}count=500&offset=${offset}`);
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

function _chatGetFiguren(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT f.fig_id, f.name, f.kurzname, f.typ, f.beschreibung, f.beruf, f.geschlecht,
           GROUP_CONCAT(DISTINCT ft.tag)         AS tags,
           GROUP_CONCAT(DISTINCT fa.chapter_name) AS kapitel
    FROM figures f
    LEFT JOIN figure_tags        ft ON ft.figure_id = f.id
    LEFT JOIN figure_appearances fa ON fa.figure_id = f.id
    WHERE f.book_id = ? AND f.user_email = ?
    GROUP BY f.id
    ORDER BY f.sort_order
  `).all(bookId, userEmail);
  return rows.map(r => ({
    id: r.fig_id, name: r.name, kurzname: r.kurzname, typ: r.typ,
    beschreibung: r.beschreibung, beruf: r.beruf, geschlecht: r.geschlecht,
    eigenschaften: r.tags ? r.tags.split(',') : [],
    kapitel: r.kapitel ? r.kapitel.split(',') : [],
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
async function callAIChat(messages, systemPrompt, onProgress) {
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
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', tokensIn = 0, tokensOut = 0;
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
            tokensOut = chunk.eval_count || 0;
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          } else {
            text += chunk.message?.content || '';
            if (onProgress) onProgress({ chars: text.length, tokIn: estimatedTokIn });
          }
        } catch { }
      }
    }
    return { text, tokensIn, tokensOut };
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
    });
    if (!resp.ok) throw new Error(`Claude ${resp.status}: ${JSON.stringify(await resp.json())}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let text = '', buf = '', tokensIn = 0, tokensOut = 0;
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
            text += ev.delta.text;
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          }
        } catch { }
      }
    }
    return { text, tokensIn, tokensOut };
  }
}

const SINGLE_PASS_LIMIT = 60000;
const BATCH_SIZE = 5;

async function loadPageContents(pages, chMap, minLength, onBatch) {
  const contents = [];
  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    if (onBatch) onBatch(i, pages.length);
    const results = await Promise.allSettled(pages.slice(i, i + BATCH_SIZE).map(async p => {
      const pd = await bsGet('pages/' + p.id);
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
async function aiCall(jobId, tok, prompt, system, fromPct, toPct, expectedChars = 3000, outputRatio = 0.2, maxTokens = null) {
  let dynExpectedChars = expectedChars;
  let calibrated = false;
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
    // Live-Token-Anzeige: tok.in/tok.out = bisherige abgeschlossene Calls;
    // aktueller Call: Input aus message_start, Output approximiert (chars / 4)
    if (tokIn > 0) updates.tokensIn = tok.in + tokIn;
    if (chars > 0) updates.tokensOut = tok.out + Math.floor(chars / 4);
    if (Object.keys(updates).length) updateJob(jobId, updates);
  };
  const globalMax = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
  const maxTokensOverride = maxTokens != null
    ? Math.min(maxTokens, globalMax)
    : globalMax;
  const { text, truncated, tokensIn, tokensOut } = await callAI(prompt, system, onProgress, maxTokensOverride);
  tok.in += tokensIn;
  tok.out += tokensOut;
  updateJob(jobId, { tokensIn: tok.in, tokensOut: tok.out });
  if (truncated) throw new Error(`KI-Antwort wurde bei ${maxTokensOverride} Tokens abgeschnitten (stop_reason: max_tokens). JSON ist unvollständig.`);
  return parseJSON(text);
}

// ── Job: Buchbewertung ────────────────────────────────────────────────────────
async function runReviewJob(jobId, bookId, bookName, userEmail) {
  const { SYSTEM_BUCHBEWERTUNG, SYSTEM_KAPITELANALYSE, buildBookReviewSinglePassPrompt, buildChapterAnalysisPrompt, buildBookReviewMultiPassPrompt } = await getPrompts();
  try {
    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId),
      bsGetAll('pages?book_id=' + bookId),
    ]);

    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0 }; // akkumulierte Token über alle KI-Calls
    const pageContents = await loadPageContents(pages, chMap, 50, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 60),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    });

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

    completeJob(jobId, { review: r, pageCount: pageContents.length, tokensIn: tok.in, tokensOut: tok.out });
    logger.info(`Job ${jobId}: Buchbewertung Buch ${bookId} abgeschlossen (${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Buchbewertung Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Figurenextraktion (Basis – ohne Lebensereignisse) ───────────────────
async function runFiguresJob(jobId, bookId, bookName, userEmail) {
  const { SYSTEM_FIGUREN, buildFiguresBasisSinglePassPrompt, buildFiguresBasisChapterPrompt, buildFiguresBasisConsolidationPrompt } = await getPrompts();

  try {
    const cp = loadCheckpoint('figures', bookId, userEmail);
    if (cp) logger.info(`Job ${jobId}: Figurenextraktion Buch ${bookId} – Checkpoint gefunden (Phase: ${cp.phase}), setze fort.`);

    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId),
      bsGetAll('pages?book_id=' + bookId),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0 };
    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 55),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    });

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    let result;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      updateJob(jobId, { progress: 65, statusText: 'KI analysiert Figuren…' });
      const bookText = pageContents
        .map(p => `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`)
        .join('\n\n---\n\n');
      result = await aiCall(jobId, tok,
        buildFiguresBasisSinglePassPrompt(bookName, pageContents.length, bookText),
        SYSTEM_FIGUREN,
        65, 96, 4000,
      );
    } else {
      const { groupOrder, groups } = groupByChapter(pageContents);
      const chapterTexts = groupOrder.map(key => {
        const group = groups.get(key);
        return { group, chText: group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n') };
      });

      // Phase 1: Figuren parallel pro Kapitel extrahieren
      let chapterFiguren;
      if (cp?.phase === 'phase1_done') {
        chapterFiguren = cp.chapterFiguren;
        updateJob(jobId, { progress: 82, statusText: 'Phase 1 aus Checkpoint geladen…' });
      } else {
        updateJob(jobId, {
          progress: 55,
          statusText: `Figuren in ${groupOrder.length} Kapiteln parallel analysieren…`,
        });
        const settled = await Promise.allSettled(
          chapterTexts.map(({ group, chText }) =>
            aiCall(jobId, tok,
              buildFiguresBasisChapterPrompt(group.name, bookName, group.pages.length, chText),
              SYSTEM_FIGUREN,
              55, 82, 4000,
            )
          )
        );
        chapterFiguren = settled.map((r, gi) => ({
          kapitel: chapterTexts[gi].group.name,
          figuren: r.status === 'fulfilled' ? (r.value?.figuren || []) : [],
          ...(r.status === 'rejected' && logger.warn(`Job ${jobId}: Kapitel «${chapterTexts[gi].group.name}» übersprungen: ${r.reason?.message}`) && {}),
        }));
        saveCheckpoint('figures', bookId, userEmail, { phase: 'phase1_done', chapterFiguren });
      }

      // Phase 2: Konsolidierung
      updateJob(jobId, { progress: 85, statusText: `KI konsolidiert Figuren…` });
      result = await aiCall(jobId, tok,
        buildFiguresBasisConsolidationPrompt(bookName, chapterFiguren),
        SYSTEM_FIGUREN,
        85, 96, 8000,
      );
    }

    if (!Array.isArray(result?.figuren)) throw new Error('KI-Antwort ungültig: figuren-Array fehlt');

    const figuren = result.figuren.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
    const idMapsFig = {
      chNameToId:   Object.fromEntries(chaptersData.map(c => [c.name, c.id])),
      pageNameToId: Object.fromEntries(pages.map(p => [p.name, p.id])),
    };
    saveFigurenToDb(parseInt(bookId), figuren, userEmail || null, idMapsFig);
    deleteCheckpoint('figures', bookId, userEmail);
    completeJob(jobId, { count: figuren.length, tokensIn: tok.in, tokensOut: tok.out });
    logger.info(`Job ${jobId}: Figurenextraktion Buch ${bookId} abgeschlossen (${figuren.length} Figuren, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Figurenextraktion Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Lebensereignisse-Zuordnung ──────────────────────────────────────────
async function runFigureEventsJob(jobId, bookId, bookName, userEmail) {
  const { SYSTEM_FIGUREN, buildFiguresEventAssignmentPrompt } = await getPrompts();

  try {
    updateJob(jobId, { statusText: 'Lade Figuren und Seiten…', progress: 0 });

    const figRows = db.prepare(
      'SELECT fig_id, name, typ FROM figures WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(parseInt(bookId), userEmail || null);
    if (!figRows.length) {
      failJob(jobId, new Error('Keine Figuren gefunden – bitte zuerst Figuren ermitteln.'));
      return;
    }
    const figurenList = figRows.map(f => ({ id: f.fig_id, name: f.name, typ: f.typ || 'andere' }));

    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId),
      bsGetAll('pages?book_id=' + bookId),
    ]);
    if (!pages.length) { completeJob(jobId, { eventCount: 0 }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0 };
    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 35),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    });

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    let allAssignments;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      updateJob(jobId, { progress: 45, statusText: 'KI analysiert Ereignisse…' });
      const bookText = pageContents
        .map(p => `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`)
        .join('\n\n---\n\n');
      const result = await aiCall(jobId, tok,
        buildFiguresEventAssignmentPrompt('Gesamtbuch', bookName, pageContents.length, figurenList, bookText),
        SYSTEM_FIGUREN,
        45, 90, 6000,
      );
      allAssignments = result?.assignments || [];
    } else {
      const { groupOrder, groups } = groupByChapter(pageContents);
      updateJob(jobId, {
        progress: 35,
        statusText: `Ereignisse in ${groupOrder.length} Kapiteln parallel analysieren…`,
      });

      const settled = await Promise.allSettled(
        groupOrder.map(key => {
          const group = groups.get(key);
          const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
          return aiCall(jobId, tok,
            buildFiguresEventAssignmentPrompt(group.name, bookName, group.pages.length, figurenList, chText),
            SYSTEM_FIGUREN,
            35, 88, 3000,
          );
        })
      );

      // Merge: alle lebensereignisse pro fig_id sammeln und nach datum sortieren
      const mergedMap = new Map();
      settled.forEach((r, gi) => {
        if (r.status === 'rejected') {
          logger.warn(`Job ${jobId}: Ereignis-Analyse Kapitel «${groups.get(groupOrder[gi]).name}» übersprungen: ${r.reason?.message}`);
          return;
        }
        for (const assignment of (r.value?.assignments || [])) {
          if (!mergedMap.has(assignment.fig_id)) mergedMap.set(assignment.fig_id, []);
          for (const ev of (assignment.lebensereignisse || [])) mergedMap.get(assignment.fig_id).push(ev);
        }
      });
      allAssignments = [];
      for (const [fig_id, events] of mergedMap) {
        events.sort((a, b) => (parseInt(a.datum) || 0) - (parseInt(b.datum) || 0));
        allAssignments.push({ fig_id, lebensereignisse: events });
      }
    }

    updateJob(jobId, { progress: 92, statusText: 'Ereignisse speichern…' });
    const idMapsEvt = {
      chNameToId:   Object.fromEntries(chaptersData.map(c => [c.name, c.id])),
      pageNameToId: Object.fromEntries(pages.map(p => [p.name, p.id])),
    };
    updateFigurenEvents(parseInt(bookId), allAssignments, userEmail || null, idMapsEvt);
    const eventCount = allAssignments.reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
    deleteCheckpoint('figure-events', bookId, userEmail);
    completeJob(jobId, { eventCount, tokensIn: tok.in, tokensOut: tok.out });
    logger.info(`Job ${jobId}: Ereignis-Zuordnung Buch ${bookId} abgeschlossen (${eventCount} Ereignisse, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Ereignis-Zuordnung Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}
// ── Job: Szenenanalyse ────────────────────────────────────────────────────────
async function runSzenenAnalyseJob(jobId, bookId, bookName, userEmail) {
  const { SYSTEM_FIGUREN, buildSzenenAnalysePrompt } = await getPrompts();
  try {
    const cp = loadCheckpoint('szenen', bookId, userEmail);
    if (cp) logger.info(`Job ${jobId}: Szenenanalyse Buch ${bookId} – Checkpoint gefunden (${cp.nextGi} Kapitel bereits fertig), setze fort.`);

    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId),
      bsGetAll('pages?book_id=' + bookId),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const figRows = db.prepare(
      'SELECT fig_id, name, typ FROM figures WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(parseInt(bookId), userEmail || null);
    if (!figRows.length) {
      failJob(jobId, new Error('Keine Figuren gefunden – bitte zuerst Figuren ermitteln.'));
      return;
    }
    const figurenKompakt = figRows.map(f => ({ id: f.fig_id, name: f.name, typ: f.typ || 'andere' }));

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0 };
    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 40),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    });

    const { groupOrder, groups } = groupByChapter(pageContents);

    let allSzenen = cp?.allSzenen ?? [];
    const startGi = cp?.nextGi ?? 0;

    if (startGi > 0) {
      updateJob(jobId, {
        progress: 40 + Math.round((startGi / groupOrder.length) * 55),
        statusText: `Setze Szenenanalyse fort (${startGi}/${groupOrder.length} Kapitel bereits fertig)…`,
      });
    }

    for (let gi = startGi; gi < groupOrder.length; gi++) {
      const group = groups.get(groupOrder[gi]);
      const fromPct = 40 + Math.round((gi / groupOrder.length) * 55);
      const toPct   = 40 + Math.round(((gi + 1) / groupOrder.length) * 55);
      updateJob(jobId, {
        progress: fromPct,
        statusText: `Szenen in «${group.name}» (${gi + 1}/${groupOrder.length})…`,
      });
      const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
      let chResult;
      try {
        chResult = await aiCall(jobId, tok,
          buildSzenenAnalysePrompt(group.name, figurenKompakt, chText),
          SYSTEM_FIGUREN,
          fromPct, toPct, 2000,
        );
      } catch (e) {
        logger.warn(`Job ${jobId}: Szenenanalyse Kapitel «${group.name}» übersprungen: ${e.message}`);
        saveCheckpoint('szenen', bookId, userEmail, { allSzenen, nextGi: gi + 1 });
        continue;
      }
      for (const s of (chResult.szenen || [])) {
        allSzenen.push({
          kapitel: group.name,
          seite:     s.seite     || null,
          titel:     s.titel     || '(unbekannt)',
          wertung:   s.wertung   || null,
          kommentar: s.kommentar || null,
          fig_ids:   JSON.stringify(Array.isArray(s.figuren) ? s.figuren : []),
          sort_order: allSzenen.length,
        });
      }
      saveCheckpoint('szenen', bookId, userEmail, { allSzenen, nextGi: gi + 1 });
    }

    const chNameToIdSz   = Object.fromEntries(chaptersData.map(c => [c.name, c.id]));
    const pageNameToIdSz = Object.fromEntries(pages.map(p => [p.name, p.id]));
    db.transaction(() => {
      db.prepare('DELETE FROM figure_scenes WHERE book_id = ? AND user_email = ?').run(parseInt(bookId), userEmail || null);
      const now = new Date().toISOString();
      const ins = db.prepare(`INSERT INTO figure_scenes
        (book_id, user_email, kapitel, seite, titel, wertung, kommentar, fig_ids, chapter_id, page_id, sort_order, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const s of allSzenen) {
        ins.run(
          parseInt(bookId), userEmail || null,
          s.kapitel, s.seite, s.titel, s.wertung, s.kommentar, s.fig_ids,
          chNameToIdSz[s.kapitel] ?? null,
          s.seite ? (pageNameToIdSz[s.seite] ?? null) : null,
          s.sort_order, now
        );
      }
    })();

    deleteCheckpoint('szenen', bookId, userEmail);
    completeJob(jobId, { count: allSzenen.length, tokensIn: tok.in, tokensOut: tok.out });
    logger.info(`Job ${jobId}: Szenenanalyse Buch ${bookId} abgeschlossen (${allSzenen.length} Szenen, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Szenenanalyse Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}
// ── Job: Zeitstrahl-Konsolidierung ────────────────────────────────────────────
async function runConsolidateZeitstrahlJob(jobId, events, bookId, userEmail) {
  const { SYSTEM_FIGUREN, buildZeitstrahlConsolidationPrompt } = await getPrompts();
  try {
    updateJob(jobId, { statusText: 'Konsolidiere Zeitstrahl…', progress: 5 });
    const tok = { in: 0, out: 0 };
    const result = await aiCall(jobId, tok,
      buildZeitstrahlConsolidationPrompt(events),
      SYSTEM_FIGUREN,
      5, 97, 3000, 0.2, null,
    );
    if (!Array.isArray(result?.ereignisse)) throw new Error('KI-Antwort ungültig: ereignisse-Array fehlt');
    completeJob(jobId, { ereignisse: result.ereignisse, tokensIn: tok.in, tokensOut: tok.out });
    logger.info(`Job ${jobId}: Zeitstrahl-Konsolidierung Buch ${bookId} abgeschlossen (${result.ereignisse.length} Ereignisse, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Zeitstrahl-Konsolidierung Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Seiten-Lektorat ──────────────────────────────────────────────────────
async function runCheckJob(jobId, pageId, bookId, userEmail, userToken) {
  const { SYSTEM_LEKTORAT, buildLektoratPrompt } = await getPrompts();
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

    const tok = { in: 0, out: 0 };
    updateJob(jobId, { statusText: 'KI analysiert…', progress: 10 });

    const result = await aiCall(jobId, tok,
      buildLektoratPrompt(text, html),
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
    });
    logger.info(`Job ${jobId}: Seiten-Check Seite ${pageId} abgeschlossen (${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Seiten-Check Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Batch-Lektorat ───────────────────────────────────────────────────────
async function runBatchCheckJob(jobId, bookId, userEmail) {
  const { SYSTEM_LEKTORAT, buildBatchLektoratPrompt } = await getPrompts();
  try {
    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const pages = await bsGetAll('pages?book_id=' + bookId);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const tok = { in: 0, out: 0 };
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
        const pd = await bsGet('pages/' + p.id);
        const text = htmlToText(pd.html).trim();
        if (!text) continue;

        const result = await aiCall(jobId, tok,
          buildBatchLektoratPrompt(text),
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
        logger.warn(`Job ${jobId}: Batch-Check Seite ${p.id} («${p.name}») übersprungen: ${e.message}`);
      }
    }

    completeJob(jobId, { pageCount: pages.length, done, totalErrors, tokensIn: tok.in, tokensOut: tok.out });
    logger.info(`Job ${jobId}: Batch-Check Buch ${bookId} abgeschlossen (${done}/${pages.length} Seiten, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Batch-Check Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Chat ─────────────────────────────────────────────────────────────────
async function runChatJob(jobId, sessionId, userMsgId, message, pageText, userEmail) {
  const { buildChatSystemPrompt } = await getPrompts();
  try {
    updateJob(jobId, { statusText: 'Vorbereitung…', progress: 5 });

    const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_email = ?')
      .get(parseInt(sessionId), userEmail);
    if (!session) throw new Error('Session nicht gefunden');

    // User-Nachricht wurde bereits im Route-Handler gespeichert (userMsgId)

    // Kontext aus DB laden
    const figuren = _chatGetFiguren(session.book_id, userEmail);
    const review  = _chatGetLatestReview(session.book_id, userEmail);
    const systemPrompt = buildChatSystemPrompt(session.page_name || 'Unbekannte Seite', pageText, figuren, review);

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

    const { text, tokensIn, tokensOut } = await callAIChat(aiMessages, systemPrompt, onProgress);

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

    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      tokensIn, tokensOut,
    });
    logger.info(`Job ${jobId}: Chat session ${sessionId} abgeschlossen (${fmtTok(tokensIn)}↑ ${fmtTok(tokensOut)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Chat Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Buch-Chat ────────────────────────────────────────────────────────────

const _BOOK_CHAT_STOPWORDS = new Set(_promptConfig.stopwords || []);

// Seiten-Cache: Key `${bookId}:${userEmail}` → { pages: [{name, id, slug, book_slug, text}], loadedAt }
// TTL 10 Minuten – verhindert, dass jede Nachricht alle BookStack-API-Calls wiederholt.
const _bookPageCache = new Map();
const _BOOK_PAGE_CACHE_TTL_MS = 10 * 60 * 1000;

function _scorePageRelevance(query, text) {
  const tokens = query.toLowerCase()
    .split(/[\s,\.!?;:«»"'()\[\]{}]+/)
    .filter(w => w.length >= 3 && !_BOOK_CHAT_STOPWORDS.has(w));
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
    const scored = pageContents.map(p => ({ ...p, score: _scorePageRelevance(message, p.text) }));
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
    const systemPrompt = buildBookChatSystemPrompt(session.book_name || '', selectedPages, figuren, review);
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

    const { text, tokensIn, tokensOut } = await callAIChat(aiMessages, systemPrompt, onProgress);

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

    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      tokensIn, tokensOut,
      pagesUsed: selectedPages.length,
      pagesTotal: pageContents.length,
    });
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
  const existing = runningJobs.get(jobKey('review', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Buchbewertung · ${book_name}` : `Buchbewertung`;
  const jobId = createJob('review', book_id, userEmail, label);
  enqueueJob(jobId, () => runReviewJob(jobId, book_id, book_name || '', userEmail));
  res.json({ jobId });
});

router.post('/figures', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const existing = runningJobs.get(jobKey('figures', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Figuren · ${book_name}` : `Figuren`;
  const jobId = createJob('figures', book_id, userEmail, label);
  enqueueJob(jobId, () => runFiguresJob(jobId, book_id, book_name || '', userEmail));
  res.json({ jobId });
});

router.post('/figure-events', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const existing = runningJobs.get(jobKey('figure-events', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Ereignisse · ${book_name}` : `Ereignisse`;
  const jobId = createJob('figure-events', book_id, userEmail, label);
  enqueueJob(jobId, () => runFigureEventsJob(jobId, book_id, book_name || '', userEmail));
  res.json({ jobId });
});

router.post('/szenen', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const existing = runningJobs.get(jobKey('szenen', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Szenenanalyse · ${book_name}` : `Szenenanalyse`;
  deleteCheckpoint('szenen', book_id, userEmail);
  const jobId = createJob('szenen', book_id, userEmail, label);
  enqueueJob(jobId, () => runSzenenAnalyseJob(jobId, book_id, book_name || '', userEmail));
  res.json({ jobId });
});

router.post('/consolidate-zeitstrahl', jsonBodyLarge, (req, res) => {
  const { book_id, events, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  if (!Array.isArray(events) || !events.length) return res.json({ jobId: null, empty: true });
  const userEmail = req.session?.user?.email || null;
  const existing = runningJobs.get(jobKey('consolidate-zeitstrahl', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Zeitstrahl · ${book_name}` : `Zeitstrahl`;
  const jobId = createJob('consolidate-zeitstrahl', book_id, userEmail, label);
  enqueueJob(jobId, () => runConsolidateZeitstrahlJob(jobId, events, book_id, userEmail));
  res.json({ jobId });
});

router.post('/batch-check', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const existing = runningJobs.get(jobKey('batch-check', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Serien-Lektorat · ${book_name}` : `Serien-Lektorat`;
  const jobId = createJob('batch-check', book_id, userEmail, label);
  enqueueJob(jobId, () => runBatchCheckJob(jobId, book_id, userEmail));
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

  const chatLabel = session.page_name ? `Chat · ${session.page_name}` : `Chat`;
  const jobId = createJob('chat', session_id, userEmail, chatLabel);
  enqueueJob(jobId, () => runChatJob(jobId, session_id, userMsgResult.lastInsertRowid, message.trim(), page_text || '', userEmail));
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

// ── Job: Schauplatz-Extraktion ────────────────────────────────────────────────
async function runLocationsJob(jobId, bookId, bookName, userEmail) {
  const { SYSTEM_ORTE, buildLocationsSinglePassPrompt, buildLocationsChapterPrompt, buildLocationsConsolidationPrompt } = await getPrompts();

  try {
    const cp = loadCheckpoint('locations', bookId, userEmail);
    if (cp) logger.info(`Job ${jobId}: Schauplatz-Extraktion Buch ${bookId} – Checkpoint gefunden (${cp.nextGi} Kapitel bereits fertig), setze fort.`);

    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId),
      bsGetAll('pages?book_id=' + bookId),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0 };

    // Bekannte Figuren für ID-Referenzen laden
    const figRows = db.prepare(
      'SELECT fig_id, name, typ FROM figures WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(parseInt(bookId), userEmail || null);
    const figurenKompakt = figRows.map(f => ({ id: f.fig_id, name: f.name, typ: f.typ || 'andere' }));

    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 55),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    });

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    let result;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      updateJob(jobId, { progress: 65, statusText: 'KI analysiert Schauplätze…' });
      const bookText = pageContents
        .map(p => `### ${p.chapter ? '[' + p.chapter + '] ' : ''}${p.title}\n${p.text}`)
        .join('\n\n---\n\n');
      result = await aiCall(jobId, tok,
        buildLocationsSinglePassPrompt(bookName, pageContents.length, bookText, figurenKompakt),
        SYSTEM_ORTE,
        65, 96, 4000,
      );
    } else {
      const { groupOrder, groups } = groupByChapter(pageContents);

      let chapterOrte = cp?.chapterOrte ?? [];
      const startGi = cp?.nextGi ?? 0;

      if (startGi > 0) {
        updateJob(jobId, {
          progress: 55 + Math.round((startGi / groupOrder.length) * 30),
          statusText: `Setze Schauplatz-Analyse fort (${startGi}/${groupOrder.length} Kapitel bereits fertig)…`,
        });
      }

      for (let gi = startGi; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const fromPct = 55 + Math.round((gi / groupOrder.length) * 30);
        const toPct   = 55 + Math.round(((gi + 1) / groupOrder.length) * 30);
        updateJob(jobId, {
          progress: fromPct,
          statusText: `Schauplätze in «${group.name}» (${gi + 1}/${groupOrder.length})…`,
        });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        let chResult;
        try {
          chResult = await aiCall(jobId, tok,
            buildLocationsChapterPrompt(group.name, bookName, group.pages.length, chText, figurenKompakt),
            SYSTEM_ORTE,
            fromPct, toPct, 2000,
          );
          chapterOrte.push({ kapitel: group.name, orte: chResult.orte || [] });
        } catch (e) {
          logger.warn(`Job ${jobId}: Schauplatz-Analyse Kapitel «${group.name}» übersprungen: ${e.message}`);
          chapterOrte.push({ kapitel: group.name, orte: [] });
        }
        saveCheckpoint('locations', bookId, userEmail, { chapterOrte, nextGi: gi + 1 });
      }

      updateJob(jobId, {
        progress: 88,
        statusText: `KI konsolidiert Schauplätze…`,
      });
      result = await aiCall(jobId, tok,
        buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompakt),
        SYSTEM_ORTE,
        88, 96, 4000,
      );
    }

    if (!Array.isArray(result?.orte)) throw new Error('KI-Antwort ungültig: orte-Array fehlt');

    const orte = result.orte.map((o, i) => ({ ...o, id: o.id || ('ort_' + (i + 1)) }));
    saveOrteToDb(parseInt(bookId), orte, userEmail || null);
    deleteCheckpoint('locations', bookId, userEmail);
    completeJob(jobId, { count: orte.length, tokensIn: tok.in, tokensOut: tok.out });
    logger.info(`Job ${jobId}: Schauplatz-Extraktion Buch ${bookId} abgeschlossen (${orte.length} Orte, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Schauplatz-Extraktion Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}
// ── Job: Kontinuitätsprüfung ──────────────────────────────────────────────────
async function runKontinuitaetJob(jobId, bookId, bookName, userEmail) {
  const { SYSTEM_KONTINUITAET, buildKontinuitaetSinglePassPrompt, buildKontinuitaetChapterFactsPrompt, buildKontinuitaetCheckPrompt } = await getPrompts();

  try {
    const cp = loadCheckpoint('kontinuitaet', bookId, userEmail);
    if (cp) logger.info(`Job ${jobId}: Kontinuitätsprüfung Buch ${bookId} – Checkpoint gefunden (${cp.nextGi} Kapitel bereits fertig), setze fort.`);

    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId),
      bsGetAll('pages?book_id=' + bookId),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0 };

    // Bekannte Figuren + Orte aus DB laden
    const figRows = db.prepare(`
      SELECT f.name, f.typ, f.beschreibung FROM figures f
      WHERE f.book_id = ? AND f.user_email = ? ORDER BY f.sort_order
    `).all(parseInt(bookId), userEmail || null);
    const figurenKompakt = figRows.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));

    const ortRows = db.prepare(
      'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(parseInt(bookId), userEmail || null);
    const orteKompakt = ortRows.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));

    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 50),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    });

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

    const model = process.env.API_PROVIDER === 'ollama'
      ? (process.env.OLLAMA_MODEL || 'llama3.2')
      : (process.env.MODEL_NAME || 'claude-sonnet-4-6');

    db.prepare(`INSERT INTO continuity_checks (book_id, user_email, checked_at, issues_json, summary, model)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(parseInt(bookId), userEmail || null, new Date().toISOString(),
        JSON.stringify(result.probleme || []), result.zusammenfassung || '', model);

    deleteCheckpoint('kontinuitaet', bookId, userEmail);
    completeJob(jobId, {
      count: (result.probleme || []).length,
      issues: result.probleme || [],
      zusammenfassung: result.zusammenfassung,
      tokensIn: tok.in, tokensOut: tok.out,
    });
    logger.info(`Job ${jobId}: Kontinuitätsprüfung Buch ${bookId} abgeschlossen (${(result.probleme || []).length} Probleme, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Kontinuitätsprüfung Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}
router.post('/locations', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const existing = runningJobs.get(jobKey('locations', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Schauplätze · ${book_name}` : `Schauplätze`;
  const jobId = createJob('locations', book_id, userEmail, label);
  enqueueJob(jobId, () => runLocationsJob(jobId, book_id, book_name || '', userEmail));
  res.json({ jobId });
});

router.post('/kontinuitaet', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const existing = runningJobs.get(jobKey('kontinuitaet', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Kontinuität · ${book_name}` : `Kontinuität`;
  const jobId = createJob('kontinuitaet', book_id, userEmail, label);
  enqueueJob(jobId, () => runKontinuitaetJob(jobId, book_id, book_name || '', userEmail));
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
    });
  }
  res.json(result);
});

router.get('/active', (req, res) => {
  const { type, book_id } = req.query;
  if (!type || !book_id) return res.status(400).json({ error: 'type und book_id erforderlich' });
  const userEmail = req.session?.user?.email || null;
  const jobId = runningJobs.get(jobKey(type, book_id, userEmail));
  if (!jobId || !jobs.has(jobId)) return res.json({ jobId: null });
  const job = jobs.get(jobId);
  res.json({ jobId: job.id, status: job.status, progress: job.progress, statusText: job.statusText });
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
    result: job.result, error: job.error,
  });
});

module.exports = router;
