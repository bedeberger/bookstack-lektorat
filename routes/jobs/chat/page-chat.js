'use strict';
// Seiten-Chat-Job (kind='page'): klassischer Chat neben dem Editor; Antwort-
// Envelope mit `vorschlaege` (zeichengenaue Textersetzung) + updatedAt-Staleness.

const { db } = require('../../../db/schema');
const { callAIChat, chatTemperature, getContextConfigFor, resolveProvider } = require('../../../lib/ai');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  getPrompts, getBookPrompts,
  htmlToText, jobAbortControllers,
  getFiguren, getLatestReview, buildChatMessageHistory,
} = require('../shared');
const contentStore = require('../../../lib/content-store');
const { generateSessionTitle } = require('../chat-title');
const { recordChatLedgerForMessage } = require('../../../db/cost-ledger');
const { _parseChatResponse } = require('./shared');

async function runChatJob(jobId, sessionId, userMsgId, message, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildChatSystemPrompt, SCHEMA_CHAT } = await getPrompts(userEmail);
  const aiCfg = getContextConfigFor(resolveProvider({ userEmail }));
  try {
    updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });

    const session = db.prepare(`
      SELECT cs.*, p.page_name FROM chat_sessions cs
      LEFT JOIN pages p ON p.page_id = cs.page_id
      WHERE cs.id = ? AND cs.user_email = ?
    `).get(parseInt(sessionId), userEmail);
    if (!session) throw i18nError('job.error.sessionNotFound');
    logger.info(`Start: «${session.page_name || '-'}» session=${sessionId}, page=${session.page_id || '-'}, msg-len=${message.length}`);

    // Seiteninhalt frisch laden (via content-store)
    let pageText = '';
    let pageUpdatedAt = null;
    if (session.page_id && session.page_id > 0) {
      try {
        const pd = await contentStore.loadPage(session.page_id, userToken);
        pageText = htmlToText(pd.html || '');
        pageUpdatedAt = pd.updated_at || null;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        logger.warn(`Seiteninhalt konnte nicht geladen werden: ${e.message}`);
      }
    }

    // Kontext aus DB laden – nur Figuren/Szenen/Orte des aktuellen Kapitels
    const pageRow = session.page_id
      ? db.prepare('SELECT chapter_id FROM pages WHERE page_id = ?').get(session.page_id)
      : null;
    const figuren = getFiguren(session.book_id, userEmail, pageRow?.chapter_id ?? null);
    const review  = getLatestReview(session.book_id, userEmail);
    const { SYSTEM_CHAT: chatSysPrompt } = await getBookPrompts(session.book_id, userEmail);
    // opening_page_text: Snapshot, der beim Chat-Öffnen gesichert wurde. Wird als
    // Vergleichsbasis nur an die KI gegeben, wenn er sich vom aktuellen Stand
    // unterscheidet (sonst wäre er redundant + kostet nur Tokens).
    const openingPageText = (session.opening_page_text && session.opening_page_text.trim() && session.opening_page_text.trim() !== pageText.trim())
      ? session.opening_page_text
      : null;
    const systemPrompt = buildChatSystemPrompt(session.page_name || 'Unbekannte Seite', pageText, figuren, review, chatSysPrompt, openingPageText);

    // Konversationshistorie aufbauen
    const historyWithoutLast = buildChatMessageHistory(session.id).slice(0, -1);
    const aiMessages = [...historyWithoutLast, { role: 'user', content: message }];

    updateJob(jobId, { statusText: 'job.phase.aiReply', progress: 10 });

    const onProgress = ({ chars, tokIn }) => {
      const updates = { progress: Math.min(97, 10 + Math.round(chars / 50)) };
      if (tokIn > 0)  updates.tokensIn  = tokIn;
      if (chars > 0)  updates.tokensOut = Math.floor(chars / aiCfg.charsPerToken);
      updateJob(jobId, updates);
    };

    const signal = jobAbortControllers.get(jobId)?.signal;
    // cacheLastMessage=true: Seiten-Chat hat über die Turns einer Session einen
    // stabilen System-Prompt (Block 1 buch-stabil, Block 2 seiten-stabil), daher
    // greift das Multi-Turn-Caching der Konversationshistorie.
    const { text, truncated, tokensIn, tokensOut, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0, provider, model, genDurationMs } = await callAIChat(aiMessages, systemPrompt, onProgress, null, signal, undefined, SCHEMA_CHAT, chatTemperature(), true);
    // Job-State auf echte Provider-Werte setzen, damit Status-Anzeige und
    // gespeicherte Chat-Nachricht dieselben Tokens zeigen (statt eines
    // Streaming-Zwischenstands).
    updateJob(jobId, { tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn });
    if (truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: tokensIn, tokOut: tokensOut, total: tokensIn + tokensOut });

    const { antwort, vorschlaege, fallback } = _parseChatResponse(text);
    if (fallback) {
      logger.warn('Chat-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert.');
    }

    // Assistant-Nachricht in DB speichern
    const assistantNow = new Date().toISOString();
    const chatTps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, vorschlaege, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, provider, model, tps, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, antwort,
      vorschlaege.length > 0 ? JSON.stringify(vorschlaege) : null,
      tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, provider, model, chatTps, assistantNow
    );
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);
    recordChatLedgerForMessage(asstMsgResult.lastInsertRowid);
    const sessionTitle = await generateSessionTitle({ session, userMessage: message, assistantAnswer: antwort, provider, logger });
    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      updatedAt: pageUpdatedAt,
      tokensIn, tokensOut,
      ...(sessionTitle ? { sessionTitle } : {}),
    }, chatTps, `«${session.page_name || '-'}» session=${sessionId}, ${vorschlaege.length} Vorschläge`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

module.exports = { runChatJob };
