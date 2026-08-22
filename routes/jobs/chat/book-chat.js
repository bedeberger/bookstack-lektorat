'use strict';
// Buch-Chat-Job (kind='book', buchweit, read-only): klassischer Pfad (Seiten
// vorab laden + Relevanz-Scoring) UND agentischer Pfad (Tool-Use über den
// Buchindex). Dispatcher wählt anhand der App-Settings (Provider/Modus).

const { db } = require('../../../db/schema');
const { callAIChat, chatTemperature, getContextConfigFor, resolveProvider, providerClass, providerSupportsTools } = require('../../../lib/ai');
const {
  _promptConfig,
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  getPrompts, getBookPrompts,
  htmlToText, jobAbortControllers,
  getFiguren, getLatestReview,
} = require('../shared');
const contentStore = require('../../../lib/content-store');
const { executeTool, validateFinalAnswerCitations } = require('../book-chat-tools');
const { generateSessionTitle } = require('../chat-title');
const { makeAgenticChatJob, buildAgenticHistory } = require('../agentic-chat');
const { imageGenEnabled } = require('../../../lib/image-gen');
const embed = require('../../../lib/embed');
const { selectPassagesSemantic, preContextPassages } = require('./book-chat-retrieval');
const { setContext } = require('../../../lib/log-context');
const appSettings = require('../../../lib/app-settings');
const { recordChatLedgerForMessage } = require('../../../db/cost-ledger');
const {
  _parseChatResponse, figurenBlockChars,
  bookPageCache, BOOK_PAGE_CACHE_TTL_MS, BOOK_PAGE_CACHE_MAX,
} = require('./shared');

// Fallback-Stoppwörter für Book-Chat (Default-Locale); wird pro Job locale-spezifisch überschrieben
const _BOOK_CHAT_STOPWORDS = new Set(
  (() => {
    const def = _promptConfig.defaultLocale || 'de-CH';
    return (_promptConfig.locales?.[def]?.stopwords) || _promptConfig.stopwords || [];
  })()
);

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

// Per-Job-Override für den Buch-Chat (klassisch + agentisch), analog zur
// Komplettanalyse (_komplettAiOverrides in routes/jobs/komplett/job-shared.js): Keys
// `ai.<provider>.{model,context_window,max_tokens_out,timeout_ms}.bookchat`, leer/0 =
// folgt dem globalen Wert. Erlaubt bei Claude z.B. Opus für den Tool-Loop, während
// global Sonnet läuft. Kein eigener Timeout-Default (anders als komplett) – der
// Buch-Chat macht pro Call nur eine Tool-Use-Runde, der globale 10-Min-Timeout reicht.
//
// Warum auch openai-compat: der agentische Pfad läuft dort ebenfalls (Function-Calling),
// und er braucht das umgekehrte Zuschnitt-Verhältnis wie die Analyse — VIEL Input
// (Werkzeugkatalog + Erst-Kontext + wachsende Tool-Results, jede Iteration ungecacht)
// und wenig Output. Ein für die Komplettanalyse gesetzter Output-Cap frisst sonst das
// Input-Budget des Chats auf, weil beide aus demselben Kontextfenster kommen.
const _BOOKCHAT_OVERRIDE_PROVIDERS = new Set(['claude', 'openai-compat']);
function _bookChatAiOverrides(effectiveProvider) {
  if (!_BOOKCHAT_OVERRIDE_PROVIDERS.has(effectiveProvider)) return null;
  const p = effectiveProvider;
  const model = String(appSettings.get(`ai.${p}.model.bookchat`) || '').trim();
  const contextWindow = parseInt(appSettings.get(`ai.${p}.context_window.bookchat`), 10) || 0;
  const maxTokensOut = parseInt(appSettings.get(`ai.${p}.max_tokens_out.bookchat`), 10) || 0;
  const timeoutMs = parseInt(appSettings.get(`ai.${p}.timeout_ms.bookchat`), 10) || 0;
  const bag = { provider: p };
  if (model) bag.model = model;
  if (contextWindow > 0) bag.contextWindow = contextWindow;
  if (maxTokensOut > 0) bag.maxTokensOut = maxTokensOut;
  if (timeoutMs > 0) bag.timeoutMs = timeoutMs;
  // effort (output_config) für Opus 4.5+/Sonnet 4.6: low|medium|high|xhigh|max. Leer =
  // API-Default (high). lib/ai.js klemmt Tier-Mismatch (max→Opus-only, xhigh→Opus-4.7+)
  // automatisch auf high. Claude-API-Eigenheit — kein openai-compat-Pendant.
  if (p === 'claude') {
    const effort = String(appSettings.get('ai.claude.effort.bookchat') || '').trim();
    if (effort) bag.effort = effort;
  }
  return Object.keys(bag).length > 1 ? { aiJob: bag } : null;
}

// Override via ALS-Context binden (greift für alle Calls dieses Jobs gegen DIESEN
// Provider, ohne globale Calls zu beeinflussen — der `provider` im Bag ist Teil des
// Vertrags). MUSS vor getContextConfigFor() laufen, damit das aiCfg (Token-Budget,
// Tool-Result-Cap) das Buch-Chat-Kontextfenster/Output-Cap reflektiert.
function _applyBookChatAiOverrides(effectiveProvider, logger) {
  const overrides = _bookChatAiOverrides(effectiveProvider);
  if (overrides) {
    setContext(overrides);
    logger.info(`Buch-Chat-Override (${effectiveProvider}): ${JSON.stringify(overrides.aiJob)}.`);
  }
  return overrides;
}

async function runBookChatJob(jobId, sessionId, userMsgId, message, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildBookChatSystemPrompt, SCHEMA_BOOK_CHAT } = await getPrompts(userEmail);
  const effectiveProvider = resolveProvider({ userEmail });
  _applyBookChatAiOverrides(effectiveProvider, logger);
  const aiCfg = getContextConfigFor(effectiveProvider);
  try {
    updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });

    const session = db.prepare(`
      SELECT cs.*, b.name AS book_name FROM chat_sessions cs
      LEFT JOIN books b ON b.book_id = cs.book_id
      WHERE cs.id = ? AND cs.user_email = ?
    `).get(parseInt(sessionId), userEmail);
    if (!session) throw i18nError('job.error.sessionNotFound');
    logger.info(`Start: «${session.book_name || '-'}» session=${sessionId}, msg-len=${message.length}`);

    const { SYSTEM_BOOK_CHAT: bookChatSys, STOPWORDS: bookChatSW } = await getBookPrompts(session.book_id, userEmail);
    const bookChatStopwords = new Set(bookChatSW || []);

    const cacheKey = `${session.book_id}:${userEmail}`;
    const jobSignal = jobAbortControllers.get(jobId)?.signal;

    // ── Historien-Rolling-Window (Anker + letzte 10 Nachrichten) ────────────────
    const historyWithoutLast = buildAgenticHistory(session.id).slice(0, -1);
    const historyChars = historyWithoutLast.reduce((s, m) => s + (m.content?.length || 0), 0);

    // ── Dynamisches Text-Budget (seiten-unabhängig) ─────────────────────────────
    // aiCfg.inputBudgetChars = (context_window − max_tokens_out − Sicherheitspuffer) · chars_per_token
    // pro effektivem Provider. Davon noch Platz für System-Prompt und History reservieren.
    const SYSTEM_OVERHEAD_CHARS = 8000;   // ~2k Tokens für System-Prompt-Overhead
    // Der Figuren-Block wird RESERVIERT, nicht geschätzt: er steht im selben Prompt
    // und war die Grösse, die den Call vor jedem Buchtext am Kontextfenster scheitern
    // liess. Reserviert wird sein Deckel (nicht die tatsächliche Länge) — der Block
    // entsteht erst unten, und ein zu knapp gerechnetes Textbudget ist teurer als ein
    // paar ungenutzte Zeichen.
    const FIGUREN_MAX_CHARS = figurenBlockChars(aiCfg);
    const TEXT_CHAR_BUDGET = Math.max(
      20000,
      Math.floor((aiCfg.inputBudgetChars - historyChars - SYSTEM_OVERHEAD_CHARS - FIGUREN_MAX_CHARS) * 0.98)
    );

    // ── Retrieval: Mini-RAG mit Keyword-Fallback ────────────────────────────────
    // Bei aktivem Embedding-Index zieht die semantische Pipeline die bedeutungs-
    // relevantesten Chunk-Auszüge — dichterer, präziserer Kontext als reines Keyword-
    // Scoring, und ohne alle Seiten zu laden. Fällt auf das Keyword-Scoring über alle
    // Seiten zurück, wenn kein Index existiert, das Backend ausfällt oder die Anfrage
    // keine semantischen Treffer liefert.
    let selectedPages = [];
    let usedChars = 0;
    let totalPages = 0;
    let retrievalMode = 'keyword';

    if (embed.isEnabled()) {
      updateJob(jobId, { statusText: 'job.phase.selectingPages', progress: 20 });
      try {
        const sem = await selectPassagesSemantic(session.book_id, message, TEXT_CHAR_BUDGET, jobSignal, userToken);
        if (sem) {
          ({ selectedPages, usedChars, totalPages } = sem);
          retrievalMode = 'semantic';
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        logger.warn(`Semantisches Retrieval fehlgeschlagen (${e.message}) – Fallback auf Keyword-Scoring.`);
      }
    }

    if (retrievalMode === 'keyword') {
      // ── Alle Seiten aus Cache oder frisch via Content-Store laden ─────────────
      let pageContents;
      const cached = bookPageCache.get(cacheKey);
      if (cached && Date.now() - cached.loadedAt < BOOK_PAGE_CACHE_TTL_MS) {
        pageContents = cached.pages;
        updateJob(jobId, { statusText: 'job.phase.pagesFromCache', progress: 40 });
      } else {
        updateJob(jobId, { statusText: 'job.phase.pageListLoading', progress: 8 });
        let pages;
        try { pages = await contentStore.listPages(session.book_id, userToken); }
        catch (e) {
          if (e?.status) throw i18nError('job.error.contentStorePageList', { status: e.status });
          throw e;
        }

        const BATCH = 5;
        pageContents = [];
        for (let i = 0; i < pages.length; i += BATCH) {
          if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
          updateJob(jobId, {
            statusText: 'job.phase.loadingPagesBatch',
            statusParams: { loaded: Math.min(i + BATCH, pages.length), total: pages.length },
            progress: 10 + Math.round((i / Math.max(pages.length, 1)) * 30),
          });
          const batch = pages.slice(i, i + BATCH);
          const results = await Promise.allSettled(batch.map(async p => {
            try {
              const pd = await contentStore.loadPage(p.id, userToken);
              const text = htmlToText(pd.html || '').trim();
              return text ? { name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug, text } : null;
            } catch { return null; }
          }));
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value) pageContents.push(r.value);
          }
        }
        // FIFO-Eviction: ältesten Eintrag entfernen wenn Cache voll
        if (bookPageCache.size >= BOOK_PAGE_CACHE_MAX) {
          const firstKey = bookPageCache.keys().next().value;
          bookPageCache.delete(firstKey);
        }
        bookPageCache.set(cacheKey, { pages: pageContents, loadedAt: Date.now() });
      }

      // ── Relevanz-Scoring + Seitenauswahl ──────────────────────────────────────
      updateJob(jobId, { statusText: 'job.phase.selectingPages', progress: 42 });
      const scored = pageContents.map(p => ({ ...p, score: _scorePageRelevance(message, p.text, bookChatStopwords) }));
      const anyScore = scored.some(p => p.score > 0);
      if (anyScore) scored.sort((a, b) => b.score - a.score);

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
      totalPages = pageContents.length;
    }

    logger.info(
      `Kontext: ${selectedPages.length}/${totalPages} ${retrievalMode === 'semantic' ? 'Auszüge' : 'Seiten'} ` +
      `(${usedChars}/${TEXT_CHAR_BUDGET} Zeichen, Hist ${Math.round(historyChars / 1000)}k Zeichen, ` +
      `Retrieval=${retrievalMode}).`
    );

    // ── System-Prompt + KI-Aufruf ───────────────────────────────────────────────
    const figuren = getFiguren(session.book_id, userEmail);
    const review  = getLatestReview(session.book_id, userEmail);
    const systemPrompt = buildBookChatSystemPrompt(session.book_name || '', selectedPages, figuren, review, bookChatSys,
      { excerpt: retrievalMode === 'semantic', figurenMaxChars: FIGUREN_MAX_CHARS });
    const contextInfo = {
      pages:      selectedPages.map(p => ({ name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug })),
      totalPages,
      retrievalMode,
      figuren:    figuren.length > 0,
      review:     !!review,
    };

    const aiMessages = [...historyWithoutLast, { role: 'user', content: message }];

    updateJob(jobId, { statusText: 'job.phase.aiReply', progress: 50 });

    const onProgress = ({ chars, tokIn }) => {
      const updates = { progress: Math.min(97, 50 + Math.round(chars / 50)) };
      if (tokIn > 0)  updates.tokensIn  = tokIn;
      if (chars > 0)  updates.tokensOut = Math.floor(chars / aiCfg.charsPerToken);
      updateJob(jobId, updates);
    };

    // Kein cacheLastMessage: der System-Prompt (Block 2: keyword-selektierte
    // Seiten) ändert sich jede Runde, das würde den Messages-Cache ohnehin
    // invalidieren. Gecacht wird nur der stabile Block 1 (System/Figuren/Review).
    const { text, truncated, tokensIn, tokensOut, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0, provider, model, genDurationMs } = await callAIChat(aiMessages, systemPrompt, onProgress, null, jobSignal, undefined, SCHEMA_BOOK_CHAT, chatTemperature());
    // Job-State auf echte Provider-Werte setzen (Ollama/Llama melden prompt_tokens
    // erst am Streaming-Ende; ohne diesen Update bleibt die Status-Anzeige auf
    // einem Zwischenstand und weicht von der DB-Nachricht ab).
    updateJob(jobId, { tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn });
    if (truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: tokensIn, tokOut: tokensOut, total: tokensIn + tokensOut });

    const { antwort, fallback } = _parseChatResponse(text);
    if (fallback) {
      logger.warn('Buch-Chat-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert.');
    }

    // Assistant-Nachricht in DB speichern (vorschlaege=NULL)
    const assistantNow = new Date().toISOString();
    const bookChatTps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, provider, model, tps, context_info, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, antwort, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, provider, model, bookChatTps, JSON.stringify(contextInfo), assistantNow);
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);
    recordChatLedgerForMessage(asstMsgResult.lastInsertRowid);
    const sessionTitle = await generateSessionTitle({ session, userMessage: message, assistantAnswer: antwort, provider: effectiveProvider, logger });
    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      tokensIn, tokensOut,
      pagesUsed: selectedPages.length,
      pagesTotal: totalPages,
      ...(sessionTitle ? { sessionTitle } : {}),
    }, bookChatTps, `«${session.book_name || '-'}» session=${sessionId}, ${selectedPages.length}/${totalPages} Seiten`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Agentic Buch-Chat (Tool-Use) ───────────────────────────────────────────────
// Ersetzt runBookChatJob bei API_PROVIDER=claude (und BOOK_CHAT_MODE != 'classic').
// Der Agent ruft Tools aus routes/jobs/book-chat-tools.js auf, um Fragen
// über den gesamten Buchindex zu beantworten, statt alle Seiten vorab zu laden.
// Iterations-Deckel. Lokale Provider bekommen einen eigenen, niedrigeren Wert:
// ohne Prompt-Caching kostet jede Runde den vollen Prompt erneut (Werkzeugkatalog +
// Historie + alle bisherigen Tool-Results), und eine Runde dauert dort Sekunden bis
// Minuten. `..._local = 0` schaltet den eigenen Deckel ab.
function _bookChatMaxToolIter(provider, userEmail) {
  const base = parseInt(appSettings.get('jobs.book_chat.max_tool_iter'), 10) || 6;
  if (providerClass(provider, { userEmail }) !== 'local') return base;
  const local = parseInt(appSettings.get('jobs.book_chat.max_tool_iter_local'), 10) || 0;
  return local > 0 ? Math.min(base, local) : base;
}

// Werkzeugsatz: 'full' (alle 37) oder 'slim' (kuratierte Teilmenge, SSoT
// BOOK_CHAT_SLIM_TOOL_NAMES in public/js/prompts/book-chat-tools.js). 'auto' folgt der
// Provider-KLASSE — der volle Katalog kostet ~10k Input-Tokens pro Iteration, die ein
// lokaler Endpunkt ohne Caching jede Runde neu bezahlt, und ein kleineres Modell
// wählt aus 16 Werkzeugen zuverlässiger als aus 37.
function _bookChatToolSet(provider, userEmail) {
  const mode = String(appSettings.get('jobs.book_chat.tool_set') || 'auto').toLowerCase();
  if (mode === 'slim' || mode === 'full') return mode;
  return providerClass(provider, { userEmail }) === 'local' ? 'slim' : 'full';
}
// Per-Iteration-Limit für Input-Tokens (Context-Window-Schutz, nicht kumulativ).
// Default = `ai.<provider>.context_window` − `ai.<provider>.max_tokens_out` − Puffer.
// Prompt-Caching macht wiederholte Tokens ohnehin billig, deshalb kein Summen-Budget.
function _bookChatTokenBudget(aiCfg) {
  return parseInt(appSettings.get('jobs.book_chat.token_budget'), 10) || aiCfg.inputBudgetTokens;
}
// Per-Tool-Result-Cap: damit eine einzelne Tool-Antwort nicht allein das Budget sprengt.
// Annahme: bis zu 6 Iterationen × ~3 Tool-Calls × Sicherheitsfaktor 2 ⇒ /36.
// Min 4000 Zeichen, damit Tool-Results bei kleinen Kontextfenstern noch brauchbar sind.
function _toolResultCapChars(maxIter, aiCfg) {
  return Math.max(4000, Math.floor(aiCfg.inputBudgetChars / (maxIter * 6)));
}

// Pfadwahl haengt am EFFEKTIVEN Provider (KI-Profil aus app_users.ai_profile_id vor
// globalem `ai.provider`), nicht am globalen Setting: ein auf openai-compat
// uebersteuerter User landete bei global=claude sonst im Claude-Pfad. userEmail ist im
// Dispatch-Pfad vorhanden; ohne Argument zieht resolveProvider den User aus dem
// ALS-Context des Job-Workers.
//
// Ob ueberhaupt Werkzeuge gehen, entscheidet `providerSupportsTools`
// (lib/ai/config.js) — dieselbe Frage, die auch der Dispatch in lib/ai/core.js
// stellt. Zwei verschiedene Fragen an dieser Stelle hiessen: Job waehlt den
// agentischen Pfad, und der erste Call wirft «Tool-Use nicht unterstuetzt».
// `mode='agent'` erzwingt nichts, was der Provider nicht kann — es schaltet nur den
// klassischen Pfad als Alternative aus.
function _bookChatUseAgent(userEmail) {
  const provider = resolveProvider({ userEmail });
  const mode = String(appSettings.get('jobs.book_chat.mode') || 'auto').toLowerCase();
  if (mode === 'classic') return false;
  return providerSupportsTools(provider);
}

// final_answer-Tool-Use auswerten: Zitate validieren (Beweisspur, nicht blockierend),
// toolLog-Eintrag schreiben und den antwort-Envelope zurückgeben. Geteilt zwischen
// der regulären Loop-Terminierung und dem erzwungenen Synthese-Turn.
async function _consumeFinalAnswer(finalUse, ctx, toolLog, iterNum, logger) {
  const antwort = typeof finalUse.input?.antwort === 'string' ? finalUse.input.antwort : '';
  const zitate  = Array.isArray(finalUse.input?.zitate) ? finalUse.input.zitate : null;
  let citationValidation = null;
  let invalidCount = 0;
  if (zitate && zitate.length) {
    try {
      citationValidation = await validateFinalAnswerCitations(zitate, ctx);
      invalidCount = citationValidation.filter(v => !v.valid).length;
      if (invalidCount > 0) {
        logger.warn(`final_answer: ${invalidCount}/${citationValidation.length} Zitate ungültig (siehe context_info).`);
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      logger.warn(`final_answer-Zitat-Validierung fehlgeschlagen: ${e.message}`);
      citationValidation = [{ valid: false, reason: `validator_error: ${e.message}` }];
      invalidCount = 1;
    }
  }
  toolLog.push({
    name: 'final_answer',
    input: {
      antwort_chars: antwort.length,
      ...(zitate ? { zitate_count: zitate.length } : {}),
    },
    ok: true,
    durationMs: 0,
    resultBytes: antwort.length,
    truncated: false,
    iter: iterNum,
    ...(citationValidation ? {
      citation_validation: citationValidation,
      citations_invalid: invalidCount,
    } : {}),
  });
  logger.info(`tool=final_answer antwort_chars=${antwort.length} zitate=${zitate?.length || 0} invalid=${invalidCount} iter=${iterNum} (terminal)`);
  return JSON.stringify({ antwort });
}

// Erst-Kontext holen (non-fatal). Ohne Embedding-Index gibt es ihn nicht — dann
// arbeitet der Agent wie vorher ausschliesslich über seine Werkzeuge.
async function _agentPreContext(bookId, message, jobSignal, logger) {
  if (!embed.isEnabled() || !message) return null;
  try {
    const pre = await preContextPassages(bookId, message, { signal: jobSignal });
    if (pre) logger.info(`Erst-Kontext: ${pre.hits.length} Passagen, ${pre.chars} Zeichen.`);
    return pre;
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    logger.warn(`Erst-Kontext-Retrieval fehlgeschlagen (${e.message}) – Agent arbeitet nur über Werkzeuge.`);
    return null;
  }
}

// Agentischer Buch-Chat: ruft Tools aus routes/jobs/book-chat-tools.js auf, um
// Fragen über den gesamten Buchindex zu beantworten, statt alle Seiten vorab zu
// laden. Loop/Persistenz kommen aus makeAgenticChatJob (siehe agentic-chat.js);
// hier nur die Buch-Chat-spezifischen Achsen (Provider-Override, Tool-Set inkl.
// generate_image, final_answer-Zitat-Validierung, context_info mit Bildern).
const runBookChatJobAgent = makeAgenticChatJob({
  startLabel: 'Agent',
  errLabel: 'Agent',
  callProvider: undefined,   // lässt lib/ai den (ggf. via setContext überschriebenen) Provider auflösen
  resolveProvider: (userEmail, logger) => {
    const effectiveProvider = resolveProvider({ userEmail });
    _applyBookChatAiOverrides(effectiveProvider, logger);
    return effectiveProvider;
  },

  loadSession: (sessionId, userEmail) => db.prepare(`
    SELECT cs.*, b.name AS book_name FROM chat_sessions cs
    LEFT JOIN books b ON b.book_id = cs.book_id
    WHERE cs.id = ? AND cs.user_email = ?
  `).get(parseInt(sessionId), userEmail),

  async prepare({ session, userEmail, userToken, aiCfg, logger, jobSignal, message }) {
    const { buildBookChatAgentSystemPrompt, BOOK_CHAT_TOOLS, BOOK_CHAT_SLIM_TOOL_NAMES, BOOK_CHAT_FORCE_FINAL_INSTRUCTION } = await getPrompts(userEmail);
    const figuren = getFiguren(session.book_id, userEmail);
    const review  = getLatestReview(session.book_id, userEmail);
    const { SYSTEM_BOOK_CHAT: bookChatSys } = await getBookPrompts(session.book_id, userEmail);
    const provider = resolveProvider({ userEmail });
    const maxToolIter = _bookChatMaxToolIter(provider, userEmail);
    // Erst-Kontext: die semantisch nächsten Passagen zur Frage, bevor der Loop startet.
    // Die häufigste Frageform ist eine schmale Faktenfrage; ohne diesen Block beginnt der
    // Agent bei null und lädt im Zweifel ganze Kapitel — der Block kostet ein paar Tausend
    // Tokens, eine get_chapter_text-Runde ein Vielfaches. Nicht-fatal: fällt der Embedding-
    // Endpunkt aus, läuft der Agent wie vorher rein über seine Werkzeuge.
    const preContext = await _agentPreContext(session.book_id, message, jobSignal, logger);
    const embOn = embed.isEnabled();
    // generate_image / search_similar nur anbieten, wenn der jeweilige Endpunkt
    // (Bild bzw. Embeddings) konfiguriert ist — sonst spart das Input-Tokens und
    // das Modell ruft kein totes Werkzeug. Im Slim-Satz (lokale Provider) faellt
    // zusaetzlich alles weg, was nicht auf der kuratierten Liste steht.
    const imgOn = imageGenEnabled();
    const toolSet = _bookChatToolSet(provider, userEmail);
    const slim = toolSet === 'slim' ? new Set(BOOK_CHAT_SLIM_TOOL_NAMES) : null;
    const tools = BOOK_CHAT_TOOLS.filter(t =>
      (!slim || slim.has(t.name))
      && (t.name !== 'generate_image' || imgOn) && (t.name !== 'search_similar' || embOn));
    // Der Prompt darf nur empfehlen, was tatsaechlich angeboten wird — sonst
    // verbrennt das Modell Runden an Werkzeugen, die es nicht hat.
    const figurenMaxChars = figurenBlockChars(aiCfg);
    const systemPrompt = buildBookChatAgentSystemPrompt(
      session.book_name || '', figuren, review, bookChatSys, maxToolIter,
      { passages: preContext?.hits || [], semantic: embOn, toolNames: tools.map(t => t.name), figurenMaxChars },
    );
    logger.info(`Werkzeugsatz: ${toolSet} (${tools.length} Werkzeuge), max ${maxToolIter} Iterationen, Provider=${provider}/${providerClass(provider, { userEmail })}.`);
    logger.info(`System-Prompt: ${systemPrompt.reduce((n, b) => n + (b.text?.length || 0), 0)} Zeichen `
      + `(Figuren: ${figuren.length}, Block-Deckel ${figurenMaxChars} Zeichen), Input-Budget ${aiCfg.inputBudgetChars} Zeichen.`);
    return {
      systemPrompt,
      tools,
      maxToolIter,
      tokenBudget: _bookChatTokenBudget(aiCfg),
      toolResultCap: _toolResultCapChars(maxToolIter, aiCfg),
      forceFinalInstruction: BOOK_CHAT_FORCE_FINAL_INSTRUCTION,
      ctx: {
        bookId: session.book_id, sessionId: session.id, userEmail, userToken,
        jobSignal, logger,
        // Welcher Werkzeugsatz lief — landet in context_info (Kosten-Diagnose:
        // ein Slim-Lauf beantwortet manche Frage nicht, das muss sichtbar sein).
        toolSet, toolsOffered: tools.length,
        // generate_image-Tool sammelt hier {image_id, prompt, mime}; nach dem Loop
        // in context_info.images persistiert (Frontend-Anzeige im Verlauf).
        images: [],
        // Input-Budget des effektiven Providers — list_chapters leitet daraus ab,
        // ob das ganze Buch in den Kontext passt (Voll-Lektüre statt search-Raten).
        inputBudgetChars: aiCfg.inputBudgetChars,
        // Erst-Kontext-Kennzahlen für context_info (Frontend-Plakette + Kosten-Diagnose).
        preContext: preContext
          ? { count: preContext.hits.length, chars: preContext.chars }
          : null,
      },
    };
  },

  executeTool: (name, input, ctx) => executeTool(name, input, ctx),

  // final_answer mit Zitat-Validierung (Beweisspur, nicht blockierend).
  consumeFinalAnswer: ({ finalUse, ctx, toolLog, iterNum, logger }) =>
    _consumeFinalAnswer(finalUse, ctx, toolLog, iterNum, logger),

  parseFinal: (finalText, logger) => {
    const { antwort, fallback } = _parseChatResponse(finalText);
    if (fallback) logger.warn('Agent-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert.');
    return antwort;
  },

  buildContextInfo: ({ toolLog, iter, ctx }) => ({
    mode: 'agent',
    tool_calls: toolLog,
    iterations: iter + 1,
    ...(ctx.toolSet ? { tool_set: ctx.toolSet, tools_offered: ctx.toolsOffered } : {}),
    ...(ctx.preContext ? { pre_context: ctx.preContext } : {}),
    // Im Chat generierte Bilder — Frontend rendert sie unter der Antwort.
    ...(ctx.images.length ? { images: ctx.images } : {}),
  }),

  buildSummary: ({ sessionId, toolLog, iter }) =>
    `Agent session=${sessionId}, ${toolLog.length} Tool-Calls, ${iter + 1} Iter`,

  // Endpunkt/Modell sprechen kein Tool-Protokoll (400/404/422 mit Tool-Bezug, oder
  // `ai.openai-compat.tools=false` waehrend der Job schon lief): statt den Job zu
  // verlieren, dieselbe Frage klassisch beantworten. Greift nur, solange nichts
  // persistiert wurde — der Fehler kann ausschliesslich am callAIWithTools auftreten,
  // und der liegt vor jedem Schreibpfad.
  fallbackJob: runBookChatJob,
});

// Dispatcher: wählt zwischen Agent-Pfad und klassischem Pfad.
function runBookChatJobDispatch(jobId, sessionId, userMsgId, message, userEmail, userToken) {
  if (_bookChatUseAgent(userEmail)) {
    return runBookChatJobAgent(jobId, sessionId, userMsgId, message, userEmail, userToken);
  }
  return runBookChatJob(jobId, sessionId, userMsgId, message, userEmail, userToken);
}

module.exports = { runBookChatJob, runBookChatJobAgent, runBookChatJobDispatch };
