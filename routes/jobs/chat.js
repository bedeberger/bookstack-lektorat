'use strict';
const express = require('express');
const { db } = require('../../db/schema');
const { callAIChat, parseJSON, CHARS_PER_TOKEN, MAX_TOKENS_OUT } = require('../../lib/ai');
const {
  _promptConfig,
  makeJobLogger, updateJob, completeJob, failJob,
  getPrompts, getBookPrompts,
  htmlToText, jobAbortControllers,
  fmtTok, BS_URL,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jsonBody,
  getFiguren, getLatestReview, buildChatMessageHistory,
} = require('./shared');

const chatRouter = express.Router();

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

function _parseChatResponse(text) {
  try {
    const parsed = parseJSON(text);
    return {
      antwort: parsed.antwort ?? text,
      vorschlaege: parsed.vorschlaege ?? [],
    };
  } catch {
    return { antwort: text, vorschlaege: [] };
  }
}

/**
 * Rolling-Window für den Buch-Chat: erste user+assistant-Runde als Kontext-Anker
 * + die letzten tailMessages Nachrichten. Verhindert unbegrenztes Historien-Wachstum.
 */
function _bookChatBuildHistory(sessionId, tailMessages = 10) {
  const all = buildChatMessageHistory(sessionId);
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

// ── Job: Chat ─────────────────────────────────────────────────────────────────
async function runChatJob(jobId, sessionId, userMsgId, message, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildChatSystemPrompt, SCHEMA_CHAT } = await getPrompts();
  try {
    updateJob(jobId, { statusText: 'Vorbereitung…', progress: 5 });

    const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_email = ?')
      .get(parseInt(sessionId), userEmail);
    if (!session) throw new Error('Session nicht gefunden');

    // Seiteninhalt frisch aus BookStack laden
    let pageText = '';
    if (session.page_id && session.page_id > 0) {
      try {
        const authHeader = userToken
          ? `Token ${userToken.id}:${userToken.pw}`
          : `Token ${process.env.TOKEN_ID || ''}:${process.env.TOKEN_KENNWORT || ''}`;
        const jobSignal = jobAbortControllers.get(jobId)?.signal;
        const pdResp = await fetch(`${BS_URL}/api/pages/${session.page_id}`, {
          headers: { Authorization: authHeader },
          signal: jobSignal ? AbortSignal.any([jobSignal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        });
        if (!pdResp.ok) throw new Error(`BookStack ${pdResp.status}: ${await pdResp.text()}`);
        const pd = await pdResp.json();
        pageText = htmlToText(pd.html || '');
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        logger.warn(`Job ${jobId}: Seiteninhalt konnte nicht geladen werden: ${e.message}`);
      }
    }

    // Kontext aus DB laden – nur Figuren/Szenen/Orte des aktuellen Kapitels
    const pageRow = session.page_id
      ? db.prepare('SELECT chapter_name FROM pages WHERE page_id = ?').get(session.page_id)
      : null;
    const figuren = getFiguren(session.book_id, userEmail, pageRow?.chapter_name ?? null);
    const review  = getLatestReview(session.book_id, userEmail);
    const { SYSTEM_CHAT: chatSysPrompt } = await getBookPrompts(session.book_id);
    const systemPrompt = buildChatSystemPrompt(session.page_name || 'Unbekannte Seite', pageText, figuren, review, chatSysPrompt);

    // Konversationshistorie aufbauen
    const historyWithoutLast = buildChatMessageHistory(session.id).slice(0, -1);
    const aiMessages = [...historyWithoutLast, { role: 'user', content: message }];

    updateJob(jobId, { statusText: 'KI antwortet…', progress: 10 });

    const onProgress = ({ chars, tokIn }) => {
      const updates = { progress: Math.min(97, 10 + Math.round(chars / 50)) };
      if (tokIn > 0)  updates.tokensIn  = tokIn;
      if (chars > 0)  updates.tokensOut = Math.floor(chars / CHARS_PER_TOKEN);
      updateJob(jobId, updates);
    };

    const signal = jobAbortControllers.get(jobId)?.signal;
    const { text, tokensIn, tokensOut, genDurationMs } = await callAIChat(aiMessages, systemPrompt, onProgress, null, signal, undefined, SCHEMA_CHAT);

    const { antwort, vorschlaege } = _parseChatResponse(text);
    if (antwort === text && vorschlaege.length === 0) {
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
    if (e.name !== 'AbortError') logger.error(`Job ${jobId}: Chat Fehler: ${e.message}`);
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

// Seiten-Cache: Key `${bookId}:${userEmail}` → { pages, loadedAt }
// TTL 10 Minuten, max. 20 Einträge (FIFO-Eviction).
const _bookPageCache = new Map();
const _BOOK_PAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const _BOOK_PAGE_CACHE_MAX = 20;

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
  const { buildBookChatSystemPrompt, SCHEMA_BOOK_CHAT } = await getPrompts();
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
    const jobSignal = jobAbortControllers.get(jobId)?.signal;

    // ── Schritt 1: Seiten aus Cache oder frisch von BookStack laden ─────────────
    let pageContents;
    const cached = _bookPageCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < _BOOK_PAGE_CACHE_TTL_MS) {
      pageContents = cached.pages;
      updateJob(jobId, { statusText: 'Seiten aus Cache…', progress: 40 });
    } else {
      updateJob(jobId, { statusText: 'Seitenliste laden…', progress: 8 });
      const fetchSignal = jobSignal ? AbortSignal.any([jobSignal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
      const pagesListResp = await fetch(
        `${BS_URL}/api/pages?filter[book_id]=${session.book_id}&count=500`,
        { headers: { Authorization: authHeader }, signal: fetchSignal }
      );
      if (!pagesListResp.ok) throw new Error(`BookStack Seitenliste ${pagesListResp.status}`);
      const pages = (await pagesListResp.json()).data || [];

      const BATCH = 5;
      pageContents = [];
      for (let i = 0; i < pages.length; i += BATCH) {
        if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
        updateJob(jobId, {
          statusText: `Seiten laden… ${Math.min(i + BATCH, pages.length)}/${pages.length}`,
          progress: 10 + Math.round((i / Math.max(pages.length, 1)) * 30),
        });
        const batch = pages.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(async p => {
          const batchSignal = jobSignal ? AbortSignal.any([jobSignal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
          const r = await fetch(`${BS_URL}/api/pages/${p.id}`, {
            headers: { Authorization: authHeader },
            signal: batchSignal,
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
      // FIFO-Eviction: ältesten Eintrag entfernen wenn Cache voll
      if (_bookPageCache.size >= _BOOK_PAGE_CACHE_MAX) {
        const firstKey = _bookPageCache.keys().next().value;
        _bookPageCache.delete(firstKey);
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
    const figuren = getFiguren(session.book_id, userEmail);
    const review  = getLatestReview(session.book_id, userEmail);
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

    const { text, tokensIn, tokensOut, genDurationMs } = await callAIChat(aiMessages, systemPrompt, onProgress, null, jobSignal, undefined, SCHEMA_BOOK_CHAT);

    const { antwort } = _parseChatResponse(text);
    if (antwort === text) {
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
    if (e.name !== 'AbortError') logger.error(`Job ${jobId}: Buch-Chat Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Gemeinsamer Route-Handler ────────────────────────────────────────────────

function _handleChatPost(req, res, { jobType, sessionSelect, labelFn, runFn }) {
  const { session_id, message } = req.body;
  if (!session_id || !message?.trim()) return res.status(400).json({ error_code: 'SESSION_ID_MSG_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const existing = runningJobs.get(jobKey(jobType, session_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });

  const session = db.prepare(sessionSelect).get(parseInt(session_id), userEmail);
  if (!session) return res.status(404).json({ error_code: 'SESSION_NOT_FOUND' });

  const now = new Date().toISOString();
  const userMsgResult = db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)`
  ).run(session.id, message.trim(), now);
  db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(now, session.id);

  const userToken = req.session?.bookstackToken
    ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw }
    : null;

  const label = labelFn(session);
  const jobId = createJob(jobType, session_id, userEmail, label);
  enqueueJob(jobId, () => runFn(jobId, session_id, userMsgResult.lastInsertRowid, message.trim(), userEmail, userToken));
  res.json({ jobId });
}

// ── Routen ────────────────────────────────────────────────────────────────────

chatRouter.post('/chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'chat',
  sessionSelect: 'SELECT id, page_name, book_name FROM chat_sessions WHERE id = ? AND user_email = ?',
  labelFn: s => s.page_name ? `Chat · ${s.page_name}` : 'Chat',
  runFn: runChatJob,
}));

chatRouter.post('/book-chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'book-chat',
  sessionSelect: 'SELECT id, book_name FROM chat_sessions WHERE id = ? AND user_email = ?',
  labelFn: s => s.book_name ? `Buch-Chat · ${s.book_name}` : 'Buch-Chat',
  runFn: runBookChatJob,
}));

chatRouter.delete('/book-chat-cache', (req, res) => {
  const { book_id } = req.query;
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  const key = `${book_id}:${userEmail}`;
  _bookPageCache.delete(key);
  res.json({ ok: true });
});

module.exports = { chatRouter };
