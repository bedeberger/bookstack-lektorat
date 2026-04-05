'use strict';
const express = require('express');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const logger = require('../logger');
const { db, saveFigurenToDb } = require('../db/schema');

// prompt-config.json synchron lesen (einmalig bei Modulstart)
let _promptConfig;
try {
  _promptConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../prompt-config.json'), 'utf8'));
} catch {
  _promptConfig = null; // Fehlt die Datei, verwendet prompts.js seine Defaults
}

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

function createJob(type, bookId, userEmail) {
  const id = randomUUID();
  const key = jobKey(type, bookId, userEmail);
  jobs.set(id, {
    id, type, bookId: String(bookId), userEmail: userEmail || null,
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

// ── KI-Aufruf ─────────────────────────────────────────────────────────────────
// Gibt { text, tokensIn, tokensOut } zurück.
// tokensIn/tokensOut: aus Claude message_start/message_delta bzw. Ollama done-Chunk.
// onProgress({ chars, tokIn }): optionaler Callback während des Streamings
//   chars:  akkumulierte Ausgabe-Zeichenanzahl
//   tokIn:  Input-Token-Zahl (bekannt ab message_start; 0 solange noch nicht bekannt)
async function callAI(userPrompt, systemPrompt, onProgress) {
  const provider = process.env.API_PROVIDER || 'claude';

  if (provider === 'ollama') {
    const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
    const model = process.env.OLLAMA_MODEL || 'llama3.2';
    const maxTokens = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    const resp = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, options: { num_ctx: maxTokens } }),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);

    // Input-Token-Schätzung aus Prompt-Länge (Ollama meldet prompt_eval_count erst im done-Chunk)
    const estimatedTokIn = Math.ceil(messages.reduce((s, m) => s + (m.content?.length || 0), 0) / 4);

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
            // Letzter Chunk enthält Token-Statistiken (prompt_eval_count kann 0 sein bei Cache-Hit)
            tokensIn = chunk.prompt_eval_count || estimatedTokIn;
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
    const model = process.env.MODEL_NAME || 'claude-sonnet-4-6';
    const maxTokens = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
    const body = {
      model, max_tokens: maxTokens, temperature: 0.2,
      messages: [{ role: 'user', content: userPrompt }], stream: true,
    };
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
          // message_start: Input-Token-Zahl (kommt gleich zu Beginn des Streams)
          if (ev.type === 'message_start' && ev.message?.usage) {
            tokensIn = ev.message.usage.input_tokens || 0;
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          }
          // message_delta: Output-Token-Zahl (finaler Wert)
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

function parseJSON(text) {
  const clean = text.replace(/```json\s*|```/g, '').trim();
  try { return JSON.parse(clean); } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('KI-Antwort konnte nicht als JSON geparst werden');
  }
}

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
// von fromPct auf toPct gefüllt (basierend auf akkumulierten Output-Zeichen vs. expectedChars).
async function aiCall(jobId, tok, prompt, system, fromPct, toPct, expectedChars = 3000) {
  const onProgress = ({ chars, tokIn }) => {
    const updates = {};
    // Fortschrittsbalken auf Basis akkumulierter Zeichen
    if (fromPct != null && toPct != null) {
      updates.progress = Math.round(fromPct + (toPct - fromPct) * Math.min(1, chars / expectedChars));
    }
    // Live-Token-Anzeige: tok.in/tok.out = bisherige abgeschlossene Calls;
    // aktueller Call: Input aus message_start, Output approximiert (chars / 4)
    if (tokIn > 0) updates.tokensIn = tok.in + tokIn;
    if (chars > 0) updates.tokensOut = tok.out + Math.floor(chars / 4);
    if (Object.keys(updates).length) updateJob(jobId, updates);
  };
  const { text, tokensIn, tokensOut } = await callAI(prompt, system, onProgress);
  tok.in += tokensIn;
  tok.out += tokensOut;
  updateJob(jobId, { tokensIn: tok.in, tokensOut: tok.out });
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
        65, 97, 5000,
      );
    } else {
      const { groupOrder, groups } = groupByChapter(pageContents);
      const chapterAnalyses = [];

      for (let gi = 0; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const tokStr = tok.in + tok.out > 0 ? ` · ↑${fmtTok(tok.in)} ↓${fmtTok(tok.out)} Tokens` : '';
        const fromPct = 65 + Math.round((gi / groupOrder.length) * 25);
        const toPct   = 65 + Math.round(((gi + 1) / groupOrder.length) * 25);
        updateJob(jobId, {
          progress: fromPct,
          statusText: `Analysiere ${gi + 1}/${groupOrder.length}: «${group.name}»…${tokStr}`,
        });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        const ca = await aiCall(jobId, tok,
          buildChapterAnalysisPrompt(group.name, bookName, group.pages.length, chText),
          SYSTEM_KAPITELANALYSE,
          fromPct, toPct, 1500,
        );
        chapterAnalyses.push({ name: group.name, pageCount: group.pages.length, ...ca });
      }

      updateJob(jobId, {
        progress: 90,
        statusText: `KI erstellt Gesamtbewertung… · ↑${fmtTok(tok.in)} ↓${fmtTok(tok.out)} Tokens`,
      });
      r = await aiCall(jobId, tok,
        buildBookReviewMultiPassPrompt(bookName, chapterAnalyses, pageContents.length),
        SYSTEM_BUCHBEWERTUNG,
        90, 97, 5000,
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

// ── Job: Figurenextraktion ────────────────────────────────────────────────────
async function runFiguresJob(jobId, bookId, bookName, userEmail) {
  const { SYSTEM_FIGUREN, buildFiguresSinglePassPrompt, buildFiguresChapterPrompt, buildFiguresConsolidationPrompt } = await getPrompts();

  try {
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
        buildFiguresSinglePassPrompt(bookName, pageContents.length, bookText),
        SYSTEM_FIGUREN,
        65, 96, 6000,
      );
    } else {
      const { groupOrder, groups } = groupByChapter(pageContents);
      const chapterFiguren = [];

      for (let gi = 0; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const tokStr = tok.in + tok.out > 0 ? ` · ↑${fmtTok(tok.in)} ↓${fmtTok(tok.out)} Tokens` : '';
        const fromPct = 55 + Math.round((gi / groupOrder.length) * 30);
        const toPct   = 55 + Math.round(((gi + 1) / groupOrder.length) * 30);
        updateJob(jobId, {
          progress: fromPct,
          statusText: `Figuren in «${group.name}» (${gi + 1}/${groupOrder.length})…${tokStr}`,
        });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        const chResult = await aiCall(jobId, tok,
          buildFiguresChapterPrompt(group.name, bookName, group.pages.length, chText),
          SYSTEM_FIGUREN,
          fromPct, toPct, 2000,
        );
        chapterFiguren.push({ kapitel: group.name, figuren: chResult.figuren || [] });
      }

      updateJob(jobId, {
        progress: 88,
        statusText: `KI konsolidiert Figuren… · ↑${fmtTok(tok.in)} ↓${fmtTok(tok.out)} Tokens`,
      });
      result = await aiCall(jobId, tok,
        buildFiguresConsolidationPrompt(bookName, chapterFiguren),
        SYSTEM_FIGUREN,
        88, 96, 6000,
      );
    }

    if (!Array.isArray(result?.figuren)) throw new Error('KI-Antwort ungültig: figuren-Array fehlt');

    const figuren = result.figuren.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
    saveFigurenToDb(parseInt(bookId), figuren, userEmail || null);
    completeJob(jobId, { count: figuren.length, tokensIn: tok.in, tokensOut: tok.out });
    logger.info(`Job ${jobId}: Figurenextraktion Buch ${bookId} abgeschlossen (${figuren.length} Figuren, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Figurenextraktion Fehler: ${e.message}`);
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

    const info = db.prepare(`INSERT INTO page_checks
      (page_id, page_name, book_id, checked_at, error_count, errors_json, stilanalyse, fazit, model, user_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(parseInt(pageId), pd.name, parseInt(bookId) || null,
        new Date().toISOString(), result.fehler.length, JSON.stringify(result.fehler),
        result.stilanalyse || null, result.fazit || null, model, userEmail || null);

    completeJob(jobId, {
      fehler: result.fehler,
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
      const tokStr  = tok.in + tok.out > 0 ? ` · ↑${fmtTok(tok.in)} ↓${fmtTok(tok.out)} Tokens` : '';
      updateJob(jobId, {
        progress: fromPct,
        statusText: `${i + 1}/${pages.length}: ${p.name}…${tokStr}`,
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

        db.prepare(`INSERT INTO page_checks
          (page_id, page_name, book_id, checked_at, error_count, errors_json, stilanalyse, fazit, model, user_email)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(p.id, p.name, parseInt(bookId), new Date().toISOString(),
            fehler.length, JSON.stringify(fehler),
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

const _BOOK_CHAT_STOPWORDS = new Set([
  'und','die','der','das','ist','ein','eine','zu','in','mit','von','auf','für',
  'den','dem','des','an','am','im','auch','nicht','als','wie','durch','über',
  'bis','bei','nach','vor','aus','war','hat','sind','werden','wurde','haben',
  'sein','aber','oder','wenn','dann','noch','schon','nur','kann','mehr','sehr',
]);

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

    // Alle Seiten des Buchs aus BookStack laden
    updateJob(jobId, { statusText: 'Seitenliste laden…', progress: 8 });
    const pagesListResp = await fetch(
      `${BS_URL}/api/pages?filter[book_id]=${session.book_id}&count=500`,
      { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(30000) }
    );
    if (!pagesListResp.ok) throw new Error(`BookStack Seitenliste ${pagesListResp.status}`);
    const pages = (await pagesListResp.json()).data || [];

    // Token-Budget dynamisch aus MODEL_TOKEN ableiten
    const MODEL_TOKEN = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
    // 60 % der Modell-Token für Seitentext reservieren (~4 Zeichen/Token)
    const TEXT_CHAR_BUDGET = Math.floor(MODEL_TOKEN * 0.6) * 4;

    // Seiteninhalt in Batches laden
    const BATCH = 5;
    const pageContents = [];
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

    // Relevanz-Scoring – bei Score=0 überall bleibt die ursprüngliche Reihenfolge
    updateJob(jobId, { statusText: 'Relevante Seiten auswählen…', progress: 42 });
    const scored = pageContents.map(p => ({ ...p, score: _scorePageRelevance(message, p.text) }));
    const anyScore = scored.some(p => p.score > 0);
    if (anyScore) scored.sort((a, b) => b.score - a.score);

    // Budget-Kontrolle: Seiten zufügen bis Zeichenbudget erschöpft
    const selectedPages = [];
    let usedChars = 0;
    for (const p of scored) {
      if (usedChars >= TEXT_CHAR_BUDGET) break;
      const remaining = TEXT_CHAR_BUDGET - usedChars;
      const text = p.text.slice(0, remaining);
      selectedPages.push({ name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug, text });
      usedChars += text.length;
    }

    logger.info(`Job ${jobId}: Buch-Chat – ${selectedPages.length}/${pageContents.length} Seiten im Kontext (${usedChars} / ${TEXT_CHAR_BUDGET} Zeichen).`);

    // System-Prompt + Konversationshistorie
    const figuren = _chatGetFiguren(session.book_id, userEmail);
    const review  = _chatGetLatestReview(session.book_id, userEmail);
    const systemPrompt = buildBookChatSystemPrompt(session.book_name || '', selectedPages, figuren, review);
    const contextInfo = {
      pages:      selectedPages.map(p => ({ name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug })),
      totalPages: pageContents.length,
      figuren:    figuren.length > 0,
      review:     !!review,
    };

    const historyWithoutLast = _chatBuildMessageHistory(session.id).slice(0, -1);
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
  const { page_id, book_id } = req.body;
  if (!page_id) return res.status(400).json({ error: 'page_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken
    ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw }
    : null;
  const existing = runningJobs.get(jobKey('check', page_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('check', page_id, userEmail);
  enqueueJob(jobId, () => runCheckJob(jobId, page_id, book_id || null, userEmail, userToken));
  res.json({ jobId });
});

router.post('/review', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const existing = runningJobs.get(jobKey('review', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('review', book_id, userEmail);
  enqueueJob(jobId, () => runReviewJob(jobId, book_id, book_name || '', userEmail));
  res.json({ jobId });
});

router.post('/figures', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const existing = runningJobs.get(jobKey('figures', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('figures', book_id, userEmail);
  enqueueJob(jobId, () => runFiguresJob(jobId, book_id, book_name || '', userEmail));
  res.json({ jobId });
});

router.post('/batch-check', jsonBody, (req, res) => {
  const { book_id } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const existing = runningJobs.get(jobKey('batch-check', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('batch-check', book_id, userEmail);
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
  const session = db.prepare('SELECT id FROM chat_sessions WHERE id = ? AND user_email = ?')
    .get(parseInt(session_id), userEmail);
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden' });

  const now = new Date().toISOString();
  const userMsgResult = db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)`
  ).run(session.id, message.trim(), now);
  db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(now, session.id);

  const jobId = createJob('chat', session_id, userEmail);
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

  const session = db.prepare('SELECT id FROM chat_sessions WHERE id = ? AND user_email = ?')
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

  const jobId = createJob('book-chat', session_id, userEmail);
  enqueueJob(jobId, () => runBookChatJob(jobId, session_id, userMsgResult.lastInsertRowid, message.trim(), userEmail, userToken));
  res.json({ jobId });
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
