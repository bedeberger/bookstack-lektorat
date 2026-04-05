const express = require('express');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { db } = require('../db/schema');
const logger = require('../logger');

// prompt-config.json einmalig laden (identisches Pattern wie jobs.js)
let _promptConfig = null;
try {
  _promptConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../prompt-config.json'), 'utf8'));
} catch {
  _promptConfig = null;
}

// prompts.js (ESM) lazy laden – Single Source of Truth für alle Prompts
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

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

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
function getFiguren(bookId, userEmail) {
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
    id: r.fig_id,
    name: r.name,
    kurzname: r.kurzname,
    typ: r.typ,
    beschreibung: r.beschreibung,
    beruf: r.beruf,
    geschlecht: r.geschlecht,
    eigenschaften: r.tags ? r.tags.split(',') : [],
    kapitel: r.kapitel ? r.kapitel.split(',') : [],
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
    SELECT id, role, content, vorschlaege, tokens_in, tokens_out, created_at
    FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC
  `).all(session.id);

  res.json({
    ...session,
    messages: messages.map(m => ({
      ...m,
      vorschlaege: m.vorschlaege ? JSON.parse(m.vorschlaege) : [],
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

    const now = new Date().toISOString();

    // User-Nachricht in DB speichern
    const userMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, created_at)
      VALUES (?, 'user', ?, ?)
    `).run(session.id, message.trim(), now);
    const userMsgId = userMsgResult.lastInsertRowid;

    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(now, session.id);

    // Kontext aus DB laden
    const figuren = getFiguren(session.book_id, userEmail);
    const review  = getLatestReview(session.book_id, userEmail);

    // System-Prompt aus prompts.js (Single Source of Truth)
    const { buildChatSystemPrompt } = await getPrompts();
    const systemPrompt = buildChatSystemPrompt(
      session.page_name || 'Unbekannte Seite',
      page_text || '',
      figuren,
      review
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
      logger.warn('[chat/send] KI-Antwort kein valides JSON – Rohtext wird gespeichert.');
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
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    logger.error('[chat/send] Fehler: ' + err.message, { stack: err.stack });
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
          onText(text);
          res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`);
        }
        if (chunk.done) {
          promptTokens = chunk.prompt_eval_count || 0;
          evalTokens   = chunk.eval_count        || 0;
        }
      } catch { /* ignorieren */ }
    }
  }
  onTokens(promptTokens, evalTokens);
}

module.exports = router;
