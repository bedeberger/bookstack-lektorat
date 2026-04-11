const express = require('express');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { db, getBookLocale } = require('../db/schema');
const logger = require('../logger');

// prompt-config.json einmalig laden; fehlt die Datei, bricht der Server ab.
const _promptConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../prompt-config.json'), 'utf8'));

// prompts.js (ESM) lazy laden – Single Source of Truth für alle Prompts
let _prompts = null;
async function getPrompts() {
  if (!_prompts) {
    _prompts = await import(pathToFileURL(path.resolve(__dirname, '../public/js/prompts.js')).href);
    _prompts.configurePrompts(_promptConfig);
  }
  return _prompts;
}

async function getBookPrompts(bookId) {
  const { getLocalePrompts } = await getPrompts();
  const locale = bookId ? getBookLocale(bookId) : 'de-CH';
  return getLocalePrompts(locale);
}

const router = express.Router();
const jsonBody = express.json();

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

/**
 * Normalisiert context_info aus der DB – ältere Einträge speicherten pages als
 * String-Array, neue als Objekt-Array { name, id, slug, book_slug }.
 */
function normalizeContextInfo(ci) {
  if (!ci || !Array.isArray(ci.pages)) return ci;
  ci.pages = ci.pages.map(p => (typeof p === 'string' ? { name: p } : p));
  return ci;
}

/** Letzte Buchbewertung für ein Buch (user-spezifisch) aus der DB. */
function getLatestReview(bookId, userEmail) {
  const row = db.prepare(`
    SELECT review_json FROM book_reviews
    WHERE book_id = ? AND user_email = ?
    ORDER BY reviewed_at DESC LIMIT 1
  `).get(bookId, userEmail);
  if (!row) return null;
  try { return JSON.parse(row.review_json); } catch { return null; }
}

/** Alle Figuren eines Buchs (user-spezifisch) als kompaktes Objekt-Array. */
function getFiguren(bookId, userEmail, chapterName = null) {
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

/** Konversationshistorie einer Session als Messages-Array für die KI. */
function buildMessageHistory(sessionId) {
  const rows = db.prepare(`
    SELECT role, content, vorschlaege FROM chat_messages
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId);

  return rows.map(r => ({
    role: r.role,
    // Für assistant-Nachrichten nur den Freitext, nicht das vollständige JSON
    content: r.role === 'assistant' ? r.content : r.content,
  }));
}


// ── Routen ───────────────────────────────────────────────────────────────────

/** Neue Chat-Session erstellen */
router.post('/session', jsonBody, (req, res) => {
  const { book_id, book_name, page_id, page_name } = req.body;
  const userEmail = req.session?.user?.email || null;
  if (!book_id || !page_id || !userEmail) {
    return res.status(400).json({ error: 'book_id, page_id und Login erforderlich.' });
  }
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO chat_sessions (book_id, book_name, page_id, page_name, user_email, created_at, last_message_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(book_id, book_name || null, page_id, page_name || null, userEmail, now, now);
  res.json({ id: result.lastInsertRowid });
});

/** Neue Buch-Chat-Session erstellen (ohne Seiten-Bezug) */
router.post('/session/book', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  const userEmail = req.session?.user?.email || null;
  if (!book_id || !userEmail) {
    return res.status(400).json({ error: 'book_id und Login erforderlich.' });
  }
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO chat_sessions (book_id, book_name, page_id, page_name, user_email, created_at, last_message_at)
    VALUES (?, ?, 0, '__book__', ?, ?, ?)
  `).run(book_id, book_name || null, userEmail, now, now);
  res.json({ id: result.lastInsertRowid });
});

/** Alle Buch-Chat-Sessions eines Buchs (neueste zuerst, max. 20) */
router.get('/sessions/book/:book_id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const rows = db.prepare(`
    SELECT cs.id, cs.book_id, cs.book_name, cs.created_at, cs.last_message_at,
           (SELECT content FROM chat_messages WHERE session_id = cs.id ORDER BY created_at ASC LIMIT 1) AS preview
    FROM chat_sessions cs
    WHERE cs.book_id = ? AND cs.page_name = '__book__' AND cs.user_email = ?
    ORDER BY cs.last_message_at DESC
    LIMIT 20
  `).all(parseInt(req.params.book_id), userEmail);
  res.json(rows);
});

/** Alle Sessions einer Seite (neueste zuerst, max. 20) */
router.get('/sessions/:page_id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const rows = db.prepare(`
    SELECT cs.id, cs.book_id, cs.page_id, cs.page_name, cs.created_at, cs.last_message_at,
           (SELECT content FROM chat_messages WHERE session_id = cs.id ORDER BY created_at ASC LIMIT 1) AS preview
    FROM chat_sessions cs
    WHERE cs.page_id = ? AND cs.user_email = ?
    ORDER BY cs.last_message_at DESC
    LIMIT 20
  `).all(parseInt(req.params.page_id), userEmail);
  res.json(rows);
});

/** Session mit allen Nachrichten laden */
router.get('/session/:id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const session = db.prepare(`
    SELECT * FROM chat_sessions WHERE id = ? AND user_email = ?
  `).get(parseInt(req.params.id), userEmail);
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden.' });

  const messages = db.prepare(`
    SELECT id, role, content, vorschlaege, tokens_in, tokens_out, tps, context_info, created_at
    FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC
  `).all(session.id);

  res.json({
    ...session,
    messages: messages.map(m => ({
      ...m,
      vorschlaege:  m.vorschlaege  ? JSON.parse(m.vorschlaege)  : [],
      context_info: m.context_info ? normalizeContextInfo(JSON.parse(m.context_info)) : null,
    })),
  });
});

/** Session löschen */
router.delete('/session/:id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  db.prepare('DELETE FROM chat_sessions WHERE id = ? AND user_email = ?')
    .run(parseInt(req.params.id), userEmail);
  res.json({ ok: true });
});

/**
 * Nachricht senden + KI-Antwort als SSE streamen.
 * Body: { session_id, message, page_text }
 *
 * SSE-Events:
 *   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
 *   data: {"type":"meta","message_id":42,"tokens_in":100,"tokens_out":200}
 *   data: [DONE]
 */
router.post('/send', jsonBody, async (req, res) => {
  const { session_id, message, page_text } = req.body;
  const userEmail = req.session?.user?.email || null;

  if (!session_id || !message?.trim() || !userEmail) {
    return res.status(400).json({ error: 'session_id, message und Login erforderlich.' });
  }

  // Alles in einem try/catch – Express 4 fängt async-Fehler nicht automatisch ab.
  // Ohne diesen Wrapper würde ein Fehler die Verbindung ohne HTTP-Antwort schliessen
  // → Browser sieht "fetch failed".
  let sseStarted = false;
  try {
    // Session validieren
    const session = db.prepare(
      'SELECT * FROM chat_sessions WHERE id = ? AND user_email = ?'
    ).get(parseInt(session_id), userEmail);
    if (!session) return res.status(404).json({ error: 'Session nicht gefunden.' });
    logger.info(`[chat/send] «${session.page_name}» session=${session_id} user=${userEmail} book=${session.book_id}`);

    const now = new Date().toISOString();

    // User-Nachricht in DB speichern
    const userMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, created_at)
      VALUES (?, 'user', ?, ?)
    `).run(session.id, message.trim(), now);
    const userMsgId = userMsgResult.lastInsertRowid;

    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(now, session.id);

    // Kontext aus DB laden – nur Figuren/Szenen/Orte des aktuellen Kapitels
    const pageRow = session.page_id
      ? db.prepare('SELECT chapter_name FROM pages WHERE page_id = ?').get(session.page_id)
      : null;
    const figuren = getFiguren(session.book_id, userEmail, pageRow?.chapter_name ?? null);
    const review  = getLatestReview(session.book_id, userEmail);

    // System-Prompt aus prompts.js (Single Source of Truth)
    const { buildChatSystemPrompt } = await getPrompts();
    const { SYSTEM_CHAT: chatSys } = await getBookPrompts(session.book_id);
    const systemPrompt = buildChatSystemPrompt(
      session.page_name || 'Unbekannte Seite',
      page_text || '',
      figuren,
      review,
      chatSys
    );

    // Konversationshistorie aufbauen (aktuelle User-Nachricht nicht doppelt senden)
    const historyWithoutLast = buildMessageHistory(session.id).slice(0, -1);
    const messages = [
      ...historyWithoutLast,
      { role: 'user', content: message.trim() },
    ];

    // SSE-Header erst setzen wenn alle vorbereitenden Schritte erfolgreich
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    sseStarted = true;

    const provider = process.env.API_PROVIDER || 'claude';
    let fullText = '';
    let tokensIn = 0;
    let tokensOut = 0;

    if (provider === 'ollama') {
      await _streamOllama(messages, systemPrompt, res,
        (text) => { fullText += text; },
        (tIn, tOut) => { tokensIn = tIn; tokensOut = tOut; });
    } else if (provider === 'llama') {
      await _streamLlama(messages, systemPrompt, res,
        (text) => { fullText += text; },
        (tIn, tOut) => { tokensIn = tIn; tokensOut = tOut; });
    } else {
      await _streamClaude(messages, systemPrompt, res,
        (text) => { fullText += text; },
        (tIn, tOut) => { tokensIn = tIn; tokensOut = tOut; });
    }

    // Vollständige Antwort parsen
    let antwort = fullText;
    let vorschlaege = [];
    try {
      const clean = fullText.replace(/```json\s*|```/g, '').trim();
      const parsed = JSON.parse(clean);
      antwort     = parsed.antwort     ?? fullText;
      vorschlaege = parsed.vorschlaege ?? [];
    } catch {
      logger.warn(`[chat/send] «${session.page_name}» session=${session_id} KI-Antwort kein valides JSON – Rohtext wird gespeichert.`);
    }

    // Assistant-Nachricht in DB speichern
    const assistantNow = new Date().toISOString();
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, vorschlaege, tokens_in, tokens_out, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?)
    `).run(
      session.id,
      antwort,
      vorschlaege.length > 0 ? JSON.stringify(vorschlaege) : null,
      tokensIn,
      tokensOut,
      assistantNow
    );
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);

    // Meta-Event mit IDs + Token-Counts + Vorschlägen ans Frontend
    res.write(`data: ${JSON.stringify({
      type: 'meta',
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      vorschlaege,
    })}\n\n`);
    logger.info(`[chat/send] «${session.page_name}» session=${session_id} abgeschlossen (${tokensIn}↑ ${tokensOut}↓, ${vorschlaege.length} Vorschläge).`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    logger.error(`[chat/send] session=${session_id} user=${userEmail} Fehler: ${err.message}`, { stack: err.stack });
    if (!sseStarted) {
      // Noch keine SSE-Headers gesendet → normale JSON-Fehlerantwort
      return res.status(502).json({ error: err.message });
    }
    // SSE bereits offen → Fehler-Event senden damit das Frontend reagieren kann
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch { /* res möglicherweise bereits geschlossen */ }
  }
});

// ── Provider-Streaming ───────────────────────────────────────────────────────

async function _streamClaude(messages, systemPrompt, res, onText, onTokens) {
  const model     = process.env.MODEL_NAME  || 'claude-sonnet-4-6';
  const maxTokens = parseInt(process.env.MODEL_TOKEN, 10) || 64000;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages, stream: true }),
  });

  if (!upstream.ok) {
    const err = await upstream.json();
    throw new Error(`Claude ${upstream.status}: ${JSON.stringify(err)}`);
  }

  logger.info(`[chat] Claude call model=${model}`);

  const reader  = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let tokIn = 0;
  let tokOut = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6);
      if (raw === '[DONE]') continue;
      try {
        const ev = JSON.parse(raw);
        if (ev.type === 'message_start' && ev.message?.usage) {
          tokIn = ev.message.usage.input_tokens || 0;
        }
        if (ev.type === 'message_delta' && ev.usage) {
          tokOut = ev.usage.output_tokens || 0;
        }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          onText(ev.delta.text);
          // Nur Text-Deltas ans Frontend weiterleiten
          res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ev.delta.text } })}\n\n`);
        }
      } catch { /* ignorieren */ }
    }
  }
  onTokens(tokIn, tokOut);
}

async function _streamLlama(messages, systemPrompt, res, onText, onTokens) {
  const llamaHost = (process.env.LLAMA_HOST || 'http://localhost:8080').replace(/\/$/, '');
  const model     = process.env.LLAMA_MODEL || 'llama3.2';

  const llamaMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const upstream = await fetch(`${llamaHost}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: llamaMessages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: parseFloat(process.env.LLAMA_TEMPERATURE || '0.1'),
    }),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    throw new Error(`Llama ${upstream.status}: ${text}`);
  }

  logger.info(`[chat] Llama call model=${model}`);

  const reader  = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let promptTokens = 0;
  let evalTokens   = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6);
      if (raw === '[DONE]') continue;
      try {
        const chunk = JSON.parse(raw);
        const text  = chunk.choices?.[0]?.delta?.content || '';
        if (text) {
          onText(text);
          res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`);
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens     || 0;
          evalTokens   = chunk.usage.completion_tokens || 0;
        }
      } catch { /* ignorieren */ }
    }
  }
  onTokens(promptTokens, evalTokens);
}

async function _streamOllama(messages, systemPrompt, res, onText, onTokens) {
  const ollamaHost = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
  const model      = process.env.OLLAMA_MODEL || 'llama3.2';

  const ollamaMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const upstream = await fetch(`${ollamaHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: ollamaMessages, stream: true, options: { think: false } }),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    throw new Error(`Ollama ${upstream.status}: ${text}`);
  }

  logger.info(`[chat] Ollama call model=${model}`);

  const reader  = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let accumulated = '';
  let promptTokens = 0;
  let evalTokens   = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line);
        const text  = chunk.message?.content || '';
        if (text) {
          accumulated += text;
          onText(text);
          res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`);
        }
        if (chunk.done) {
          promptTokens = chunk.prompt_eval_count || 0;
          evalTokens   = chunk.eval_count        || Math.ceil(accumulated.length / 4);
        }
      } catch { /* ignorieren */ }
    }
  }
  onTokens(promptTokens, evalTokens);
}

module.exports = router;
