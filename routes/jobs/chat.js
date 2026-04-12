'use strict';
const express = require('express');
const { db } = require('../../db/schema');
const { CHARS_PER_TOKEN, MAX_TOKENS_OUT } = require('../../lib/ai');
const {
  _promptConfig,
  makeJobLogger, updateJob, completeJob, failJob,
  getPrompts, getBookPrompts,
  htmlToText, jobAbortControllers,
  fmtTok, BS_URL,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jsonBody,
} = require('./shared');

const chatRouter = express.Router();

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
    const maxTokens = MAX_TOKENS_OUT;
    const ollamaMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    const estimatedTokIn = Math.ceil(ollamaMessages.reduce((s, m) => s + (m.content?.length || 0), 0) / CHARS_PER_TOKEN);

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
            tokensOut = chunk.eval_count || Math.ceil(text.length / CHARS_PER_TOKEN);
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
  } else if (provider === 'llama') {
    const host  = (process.env.LLAMA_HOST || 'http://localhost:8080').replace(/\/$/, '');
    const model = process.env.LLAMA_MODEL || 'llama3.2';
    const maxTokens = MAX_TOKENS_OUT;
    const llamaMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    const estimatedTokIn = Math.ceil(llamaMessages.reduce((s, m) => s + (m.content?.length || 0), 0) / CHARS_PER_TOKEN);

    const resp = await fetch(`${host}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: llamaMessages, stream: true, stream_options: { include_usage: true }, temperature: parseFloat(process.env.LLAMA_TEMPERATURE || '0.1'), max_tokens: maxTokens }),
      signal,
    });
    if (!resp.ok) throw new Error(`Llama ${resp.status}: ${await resp.text()}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', tokensIn = 0, tokensOut = 0, genDurationMs = null;
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
        if (raw === '[DONE]') continue;
        try {
          const chunk = JSON.parse(raw);
          const delta = chunk.choices?.[0]?.delta?.content || '';
          if (delta) {
            const now = Date.now();
            if (!t_first) t_first = now;
            t_last = now;
            text += delta;
            if (onProgress) onProgress({ chars: text.length, tokIn: estimatedTokIn });
          }
          if (chunk.usage) {
            tokensIn  = chunk.usage.prompt_tokens     || estimatedTokIn;
            tokensOut = chunk.usage.completion_tokens || Math.ceil(text.length / CHARS_PER_TOKEN);
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          }
        } catch { }
      }
    }
    if (!tokensIn)  tokensIn  = estimatedTokIn;
    if (!tokensOut) tokensOut = Math.ceil(text.length / CHARS_PER_TOKEN);
    if (t_first && t_last > t_first) genDurationMs = t_last - t_first;
    return { text, tokensIn, tokensOut, genDurationMs };
  } else {
    const model     = process.env.MODEL_NAME  || 'claude-sonnet-4-6';
    const maxTokens = MAX_TOKENS_OUT;
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

// ── Job: Chat ─────────────────────────────────────────────────────────────────
async function runChatJob(jobId, sessionId, userMsgId, message, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
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
      if (chars > 0)  updates.tokensOut = Math.floor(chars / CHARS_PER_TOKEN);
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
    const chatTps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, vorschlaege, tokens_in, tokens_out, tps, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, antwort,
      vorschlaege.length > 0 ? JSON.stringify(vorschlaege) : null,
      tokensIn, tokensOut, chatTps, assistantNow
    );
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);
    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      tokensIn, tokensOut,
    }, chatTps);
    logger.info(`Job ${jobId}: Chat «${session.page_name || '-'}» session ${sessionId} abgeschlossen (${fmtTok(tokensIn)}↑ ${fmtTok(tokensOut)}↓ Tokens, ${vorschlaege.length} Vorschläge).`);
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
  const logger = makeJobLogger(jobId);
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
    const MODEL_TOKEN = MAX_TOKENS_OUT;
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
      if (chars > 0)  updates.tokensOut = Math.floor(chars / CHARS_PER_TOKEN);
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
    const bookChatTps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, tps, context_info, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?)
    `).run(session.id, antwort, tokensIn, tokensOut, bookChatTps, JSON.stringify(contextInfo), assistantNow);
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);
    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      tokensIn, tokensOut,
      pagesUsed: selectedPages.length,
      pagesTotal: pageContents.length,
    }, bookChatTps);
    logger.info(`Job ${jobId}: Buch-Chat «${session.book_name || '-'}» session ${sessionId} abgeschlossen (${fmtTok(tokensIn)}↑ ${fmtTok(tokensOut)}↓, ${selectedPages.length}/${pageContents.length} Seiten).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Buch-Chat Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Routen ────────────────────────────────────────────────────────────────────
chatRouter.post('/chat', jsonBody, (req, res) => {
  const { session_id, message } = req.body;
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

chatRouter.post('/book-chat', jsonBody, (req, res) => {
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

chatRouter.delete('/book-chat-cache', (req, res) => {
  const { book_id } = req.query;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const key = `${book_id}:${userEmail}`;
  _bookPageCache.delete(key);
  res.json({ ok: true });
});

module.exports = { chatRouter };
