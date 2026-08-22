'use strict';
// Geteilter agentischer Chat-Loop (Tool-Use), genutzt von Buch-Chat und
// Recherche-Chat. `makeAgenticChatJob(config)` liefert die `runXxxJob`-Funktion;
// beide Chats teilen Loop, Token-Accounting, erzwungenen Synthese-Turn und
// Persistenz-Tail. Die chat-spezifischen Achsen (Provider, Tools, System-Prompt,
// Tool-Executor, final_answer-Auswertung, context_info, Abschluss-Payload)
// kommen als Callbacks aus der Config — analog zu makeChatMethods
// (public/js/chat/chat-base.js) im Frontend.
//
// config = {
//   startLabel, errLabel,                  // Log-Beschriftung ('Agent' / 'Recherche-Chat')
//   callProvider,                          // 7. Arg von callAIWithTools (undefined = ALS/global, 'claude' = erzwungen)
//   resolveProvider(userEmail, logger),    // effektiver Provider-String; darf setContext-Overrides setzen
//   validate({ userEmail }),               // optional, läuft im try → wirft via i18nError (z.B. Claude-only-Guard)
//   loadSession(sessionId, userEmail),     // Session-Row (inkl. book_name) oder null
//   prepare(args) → { systemPrompt, tools, maxToolIter, tokenBudget, toolResultCap?, forceFinalInstruction, ctx }
//     args enthält u.a. `message` (die aktuelle Userfrage) — der Buch-Chat zieht
//     daraus seinen semantischen Erst-Kontext, bevor der Loop startet.
//   executeTool(name, input, ctx),
//   consumeFinalAnswer({ finalUse, ctx, toolLog, iterNum, logger }) → finalText (JSON-String),
//   parseFinal(finalText, logger) → antwort-String,
//   buildContextInfo({ toolLog, iter, webSearches, webResults, ctx }) → object,
//   buildCompletePayload?({ base, ctx }) → object (default: base),
//   buildSummary({ session, sessionId, toolLog, iter, webSearches, ctx }) → string,
//   fallbackJob?(jobId, sessionId, userMsgId, message, userEmail, userToken),
//     optional: uebernimmt den Job, wenn der Provider kein Tool-Protokoll spricht
//     (Fehler-Code AI_TOOLS_UNSUPPORTED). Der Buch-Chat haengt hier seinen
//     klassischen Pfad ein — ein Endpunkt, der Function-Calling ablehnt, kostet
//     dann keine Antwort, sondern nur den agentischen Mehrwert.
// }

const { db } = require('../../db/schema');
const { callAIWithTools, getContextConfigFor } = require('../../lib/ai');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  jobAbortControllers, buildChatMessageHistory,
} = require('./shared');
const appSettings = require('../../lib/app-settings');
const { recordChatLedgerForMessage } = require('../../db/cost-ledger');
const { generateSessionTitle } = require('./chat-title');

// Modell-Drift: schreibt Prosa-Antwort und hängt am Ende ```json\n{}\n``` als
// Compliance-Theater an. extractBalancedJson greift dann das leere {} → antwort
// fehlt. Trailing-Fence vor Speicherung entfernen.
function stripTrailingEmptyJson(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\s*```(?:json)?\s*\{\s*\}\s*```\s*$/i, '')
    .replace(/\s*\{\s*\}\s*$/, '')
    .trim();
}

// Provider-gerechter Model-Fallback, falls kein callAIWithTools-Result ein Model
// lieferte (z.B. wenn alle Iterationen scheiterten). Sonst würde die Zeile mit dem
// Claude-Model + Claude-Pricing persistiert, obwohl der Job unter ollama/openai-
// compat lief — Cost-Ledger (recordChatLedgerForMessage) liest provider+model direkt
// aus der chat_messages-Zeile.
function _defaultModelFor(provider) {
  if (provider === 'ollama')        return appSettings.get('ai.ollama.model') || 'llama3.2';
  if (provider === 'openai-compat') return appSettings.get('ai.openai-compat.model') || 'llama3.2';
  return appSettings.get('ai.claude.model') || 'claude-sonnet-4-6';
}

// Rolling-Window: erste user+assistant-Runde als Kontext-Anker + die letzten
// tailMessages Nachrichten. Verhindert unbegrenztes Historien-Wachstum.
function buildAgenticHistory(sessionId, tailMessages = 10) {
  const all = buildChatMessageHistory(sessionId);
  if (all.length <= tailMessages + 2) return all;
  const anchor = [];
  if (all[0]?.role === 'user')      anchor.push(all[0]);
  if (all[1]?.role === 'assistant') anchor.push(all[1]);
  const tail = all.slice(-tailMessages);
  const anchorInTail = anchor.length > 0 && all.length - tailMessages <= 0;
  return anchorInTail ? tail : [...anchor, ...tail];
}

function makeAgenticChatJob(config) {
  return async function runAgenticChatJob(jobId, sessionId, userMsgId, message, userEmail, userToken) {
    const logger = makeJobLogger(jobId);
    const provider = config.resolveProvider(userEmail, logger);
    const aiCfg = getContextConfigFor(provider);
    try {
      if (config.validate) config.validate({ userEmail });
      updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });

      const session = config.loadSession(sessionId, userEmail);
      if (!session) throw i18nError('job.error.sessionNotFound');
      logger.info(`Start (${config.startLabel}): «${session.book_name || '-'}» session=${sessionId}, msg-len=${message.length}`);

      const jobSignal = jobAbortControllers.get(jobId)?.signal;
      const prep = await config.prepare({ session, userEmail, userToken, aiCfg, logger, jobSignal, message });
      const { systemPrompt, tools, maxToolIter, tokenBudget, forceFinalInstruction, ctx } = prep;
      const toolResultCap = prep.toolResultCap ?? Infinity;

      const historyWithoutLast = buildAgenticHistory(session.id).slice(0, -1);
      let messages = [...historyWithoutLast, { role: 'user', content: message }];

      const state = {
        totalTokIn: 0, totalTokOut: 0,
        totalCacheRead: 0, totalCacheCreation: 0, totalCacheCreation1h: 0,
        genMs: 0, lastModel: null, webSearches: 0, webResults: [],
      };
      // Token-Summen fortschreiben + UI mit echten Provider-Zahlen nachziehen
      // (onProgress liefert nur chars-basierte Schätzung, die bei reinen
      // Tool-Use-Iterationen ohne Text-Stream 0 bleibt). Zählt zudem
      // web_search-Nutzung (server_tool_use-Blöcke, nur Claude-Web-Suche) und
      // sammelt die web_search_result-Trefferdokumente in Auftrittsreihenfolge
      // (für klickbare Zitat-Quellen im Recherche-Chat). NICHT dedupen: das
      // Modell referenziert Treffer über ihre Position (`<cite index="N-…">` →
      // N-tes Dokument); Dedup würde die Indizes verschieben. Buch-Chat nutzt
      // keine Web-Suche → bleibt leer und unberührt.
      const accumulate = (result) => {
        state.totalTokIn  += result.tokensIn;
        state.totalTokOut += result.tokensOut;
        state.totalCacheRead       += (result.cacheReadIn || 0);
        state.totalCacheCreation   += (result.cacheCreationIn || 0);
        state.totalCacheCreation1h += (result.cacheCreation1hIn || 0);
        if (result.genDurationMs) state.genMs += result.genDurationMs;
        if (result.model) state.lastModel = result.model;
        for (const b of result.rawContentBlocks || []) {
          if (b.type === 'server_tool_use' && b.name === 'web_search') state.webSearches++;
          // Fehler-Results haben content als Objekt (nicht Array) → Array-Guard.
          if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
            for (const r of b.content) {
              if (r && r.type === 'web_search_result' && r.url) {
                state.webResults.push({ url: r.url, title: r.title || r.url });
              }
            }
          }
        }
        updateJob(jobId, {
          tokensIn: state.totalTokIn, tokensOut: state.totalTokOut,
          cacheReadIn: state.totalCacheRead, cacheCreationIn: state.totalCacheCreation,
          cacheCreation1hIn: state.totalCacheCreation1h,
        });
      };

      const onProgress = ({ chars, tokIn }) => {
        const updates = {};
        if (tokIn > 0)  updates.tokensIn  = state.totalTokIn + tokIn;
        if (chars > 0)  updates.tokensOut = state.totalTokOut + Math.floor(chars / aiCfg.charsPerToken);
        if (Object.keys(updates).length) updateJob(jobId, updates);
      };

      const toolLog = [];
      let finalText = null;
      let iter = 0;

      for (iter = 0; iter < maxToolIter; iter++) {
        if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
        updateJob(jobId, {
          statusText: 'job.phase.agentTools',
          statusParams: { current: iter + 1, total: maxToolIter },
          progress: Math.min(90, 10 + iter * 12),
        });

        const result = await callAIWithTools(messages, systemPrompt, tools, onProgress, undefined, jobSignal, config.callProvider);
        accumulate(result);

        if (result.truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: state.totalTokIn, tokOut: state.totalTokOut, total: state.totalTokIn + state.totalTokOut });

        if (result.tokensIn > tokenBudget) {
          logger.warn(`Context-Budget überschritten (${result.tokensIn}/${tokenBudget} Input-Tokens) – Loop abgebrochen.`);
          finalText = result.text || JSON.stringify({ antwort: '__i18n:chat.errors.contextExceeded__' });
          break;
        }

        if (result.stopReason !== 'tool_use') {
          // Modell beendet mit Prosa statt final_answer-Tool (Sonnet-Drift).
          // Prosa IST die finale Antwort — direkt als antwort-Envelope verpacken
          // (Ausnahme: Modell lieferte bereits {antwort:…}-JSON → unverändert).
          const raw = (result.text || '').trim();
          finalText = raw.startsWith('{') ? raw : JSON.stringify({ antwort: stripTrailingEmptyJson(raw) || raw });
          break;
        }

        // final_answer ist Pflicht-Endpunkt: beendet Loop ohne Reply-Round.
        const finalUse = result.toolUses.find(tu => tu.name === 'final_answer');
        if (finalUse) {
          finalText = await config.consumeFinalAnswer({ finalUse, ctx, toolLog, iterNum: iter + 1, logger });
          break;
        }

        // Tool-Use: alle tool_uses ausführen, als user-tool_result anhängen.
        messages.push({ role: 'assistant', content: result.rawContentBlocks });
        const toolResults = [];
        for (const tu of result.toolUses) {
          if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const t0 = Date.now();
          let out, ok = true, errMsg = null;
          try {
            out = await config.executeTool(tu.name, tu.input, ctx);
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            ok = false; errMsg = e.message; out = { error: e.message };
          }
          const durationMs = Date.now() - t0;
          const content = JSON.stringify(out);
          const resultBytes = content.length;
          const truncated = resultBytes > toolResultCap;
          toolLog.push({ name: tu.name, input: tu.input, ok, durationMs, resultBytes, truncated, iter: iter + 1, ...(errMsg ? { error: errMsg } : {}) });
          if (ok) logger.info(`tool=${tu.name} dur=${durationMs}ms bytes=${resultBytes}${truncated ? ' truncated' : ''} iter=${iter + 1}`);
          else    logger.warn(`tool=${tu.name} dur=${durationMs}ms bytes=${resultBytes} iter=${iter + 1} FAILED: ${errMsg}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: truncated ? content.slice(0, toolResultCap) + '…' : content,
            ...(out && out.error ? { is_error: true } : {}),
          });
        }
        messages.push({ role: 'user', content: toolResults });
      }

      if (finalText == null) {
        // Iterationen erschöpft, ohne dass final_answer gerufen wurde. Statt mit
        // Fehler aufzugeben: ein erzwungener Synthese-Turn. Die bereits
        // gesammelten tool_results hängen in `messages`; wir bieten dem Modell
        // nur noch final_answer als Werkzeug an (kein tool_choice-Forcing — das
        // kollidiert mit adaptive thinking; die Werkzeug-Beschränkung reicht:
        // das Modell ruft final_answer oder antwortet in Prosa, beides terminal).
        logger.warn(`Max-Iterationen (${maxToolIter}) erreicht – erzwinge Synthese aus dem bereits gesammelten Kontext.`);
        updateJob(jobId, { statusText: 'job.phase.agentSynthesize', progress: 92 });
        messages.push({ role: 'user', content: forceFinalInstruction });
        const finalOnlyTools = tools.filter(t => t.name === 'final_answer');
        try {
          const result = await callAIWithTools(messages, systemPrompt, finalOnlyTools, onProgress, undefined, jobSignal, config.callProvider);
          accumulate(result);
          const finalUse = result.toolUses?.find(tu => tu.name === 'final_answer');
          if (finalUse) {
            finalText = await config.consumeFinalAnswer({ finalUse, ctx, toolLog, iterNum: maxToolIter + 1, logger });
          } else {
            // Modell antwortete in Prosa statt via final_answer — Prosa IST die Antwort.
            const raw = (result.text || '').trim();
            if (raw) finalText = raw.startsWith('{') ? raw : JSON.stringify({ antwort: stripTrailingEmptyJson(raw) || raw });
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          logger.warn(`Synthese-Turn fehlgeschlagen: ${e.message}`);
        }
        if (finalText == null) finalText = JSON.stringify({ antwort: '__i18n:chat.errors.maxIterReached__' });
      }

      const antwort = config.parseFinal(finalText, logger);

      const assistantNow = new Date().toISOString();
      const tpsVal = (state.genMs > 0 && state.totalTokOut > 0) ? state.totalTokOut / (state.genMs / 1000) : null;
      const contextInfo = config.buildContextInfo({ toolLog, iter, webSearches: state.webSearches, webResults: state.webResults, ctx });
      const model = state.lastModel || _defaultModelFor(provider);
      const asstMsgResult = db.prepare(`
        INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, web_searches, provider, model, tps, context_info, created_at)
        VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(session.id, antwort, state.totalTokIn, state.totalTokOut, state.totalCacheRead, state.totalCacheCreation, state.totalCacheCreation1h, state.webSearches, provider, model, tpsVal, JSON.stringify(contextInfo), assistantNow);
      db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);
      recordChatLedgerForMessage(asstMsgResult.lastInsertRowid);

      const sessionTitle = await generateSessionTitle({ session, userMessage: message, assistantAnswer: antwort, provider, logger });

      const base = {
        session_id: session.id,
        user_message_id: userMsgId,
        assistant_message_id: asstMsgResult.lastInsertRowid,
        tokensIn: state.totalTokIn, tokensOut: state.totalTokOut,
        toolCalls: toolLog.length, iterations: iter + 1,
        ...(sessionTitle ? { sessionTitle } : {}),
      };
      const payload = config.buildCompletePayload ? config.buildCompletePayload({ base, ctx }) : base;
      completeJob(jobId, payload, tpsVal, config.buildSummary({ session, sessionId, toolLog, iter, webSearches: state.webSearches, ctx }));
    } catch (e) {
      // Provider kann keine Werkzeuge: derselbe Job noch einmal auf dem Fallback-Pfad.
      // Sicher, weil AI_TOOLS_UNSUPPORTED nur aus callAIWithTools kommt — also vor
      // jedem Schreibpfad (Assistant-Nachricht, Ledger, Session-Titel).
      if (e?.code === 'AI_TOOLS_UNSUPPORTED' && config.fallbackJob && e.name !== 'AbortError') {
        logger.warn(`${config.errLabel}: Tool-Use nicht verfuegbar (${e.message}) – Rueckfall auf den klassischen Pfad.`);
        return config.fallbackJob(jobId, sessionId, userMsgId, message, userEmail, userToken);
      }
      if (e.name !== 'AbortError') logger.error(`${config.errLabel}-Fehler: ${e.message}`, { stack: e.stack });
      failJob(jobId, e);
    }
  };
}

module.exports = { makeAgenticChatJob, buildAgenticHistory, stripTrailingEmptyJson };
