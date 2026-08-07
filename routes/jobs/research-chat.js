'use strict';
// Agentischer Recherche-Chat (Claude-only, mit Anthropic-Web-Suche). Lebt als
// Panel in der Recherche-Karte. Rückwärtsgewandt: recherchiert + sammelt Material,
// schreibt NIE in den Buchtext. Vorschläge (propose_research_item) werden NICHT
// automatisch gespeichert — sie kommen in context_info.proposals zurück, der User
// bestätigt sie im Frontend (POST /research).
//
// Loop/Persistenz teilt sich diese Datei mit dem Buch-Chat über
// makeAgenticChatJob (routes/jobs/agentic-chat.js); hier nur die
// Recherche-spezifischen Achsen (eigenes Tool-Set + Web-Suche, ohne
// Seiten-Vorladen/Zitat-Validierung).

const { db } = require('../../db/schema');
const { resolveProvider } = require('../../lib/ai');
const { getPrompts, getBookPrompts, i18nError } = require('./shared');
const { executeResearchTool, entityList } = require('./research-chat-tools');
const embed = require('../../lib/embed');
const { makeAgenticChatJob, stripTrailingEmptyJson } = require('./agentic-chat');
const appSettings = require('../../lib/app-settings');

function _maxToolIter() {
  return parseInt(appSettings.get('jobs.research_chat.max_tool_iter'), 10) || 6;
}

const runResearchChatJob = makeAgenticChatJob({
  startLabel: 'Recherche-Chat',
  errLabel: 'Recherche-Chat',
  // Recherche-Chat ist Claude-only (Web-Suche gibt es nur dort). Das Frontend
  // blendet das Panel aus, wenn der effektive Provider != claude — der validate-
  // Guard erzwingt es hier zur Sicherheit serverseitig.
  callProvider: 'claude',
  resolveProvider: () => 'claude',
  validate: ({ userEmail }) => {
    if (resolveProvider({ userEmail }) !== 'claude') throw i18nError('job.error.researchChatClaudeOnly');
  },

  loadSession: (sessionId, userEmail) => db.prepare(`
    SELECT cs.*, b.name AS book_name FROM chat_sessions cs
    LEFT JOIN books b ON b.book_id = cs.book_id
    WHERE cs.id = ? AND cs.user_email = ? AND cs.kind = 'research'
  `).get(parseInt(sessionId), userEmail),

  async prepare({ session, userEmail, userToken, aiCfg, logger, jobSignal }) {
    const { buildResearchChatAgentSystemPrompt, RESEARCH_CHAT_TOOLS, RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION } = await getPrompts(userEmail);
    const itemCount = db.prepare('SELECT COUNT(*) AS n FROM research_items WHERE book_id = ? AND archived = 0').get(session.book_id)?.n || 0;
    const { SYSTEM_BOOK_CHAT } = await getBookPrompts(session.book_id, userEmail);
    const maxToolIter = _maxToolIter();
    // Figuren + Schauplätze vorladen, damit das Modell den Welt-Kontext schon in
    // der ersten Web-Suche nutzen kann (ohne list_book_entities-Runde). Gleiche
    // Quelle wie das Tool → kein Drift.
    const entityCtx = { bookId: session.book_id, userEmail };
    const figures = entityList('figur', entityCtx);
    const locations = entityList('ort', entityCtx);
    const baseSystemPrompt = buildResearchChatAgentSystemPrompt(session.book_name || '', itemCount, maxToolIter, figures, locations);
    // Per-Buch-Override (Buchtyp/Autoren-Freitext) als zusätzlichen Kontext anhängen.
    const systemPrompt = SYSTEM_BOOK_CHAT ? `${baseSystemPrompt}\n\n${SYSTEM_BOOK_CHAT}` : baseSystemPrompt;

    // Ohne Embedding-Endpunkt hat die Passagen-Suche keine Datenbasis — das
    // Werkzeug gar nicht erst anbieten, statt das Modell eine Runde an einen
    // garantierten Fehlschlag zu verlieren.
    const tools = embed.isEnabled()
      ? RESEARCH_CHAT_TOOLS
      : RESEARCH_CHAT_TOOLS.filter(t => t.name !== 'search_research_passages');

    return {
      systemPrompt,
      tools,
      maxToolIter,
      tokenBudget: aiCfg.inputBudgetTokens,
      toolResultCap: null,   // kein Cap — Recherche-Tool-Results sind klein und truncieren würde Fundstücke verstümmeln
      forceFinalInstruction: RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION,
      ctx: {
        bookId: session.book_id, sessionId: session.id, userEmail, userToken,
        jobSignal, logger,
        proposals: [], // propose_research_item sammelt hier; nach dem Loop in context_info
      },
    };
  },

  executeTool: (name, input, ctx) => executeResearchTool(name, input, ctx),

  // Recherche kennt keine Zitat-Validierung — antwort schlicht extrahieren.
  consumeFinalAnswer: ({ finalUse, toolLog, iterNum, logger }) => {
    const antwort = typeof finalUse.input?.antwort === 'string' ? finalUse.input.antwort : '';
    toolLog.push({ name: 'final_answer', input: { antwort_chars: antwort.length }, ok: true, durationMs: 0, resultBytes: antwort.length, truncated: false, iter: iterNum });
    logger.info(`tool=final_answer antwort_chars=${antwort.length} iter=${iterNum} (terminal)`);
    return JSON.stringify({ antwort });
  },

  parseFinal: (finalText) => {
    let antwort = '';
    try { antwort = JSON.parse(finalText)?.antwort || ''; }
    catch { antwort = stripTrailingEmptyJson(finalText) || finalText; }
    if (!antwort) antwort = '__i18n:chat.errors.maxIterReached__';
    return antwort;
  },

  buildContextInfo: ({ toolLog, iter, webSearches, webResults, ctx }) => ({
    mode: 'research',
    tool_calls: toolLog,
    iterations: iter + 1,
    web_searches: webSearches,
    // Web-Such-Trefferdokumente in Auftrittsreihenfolge (1-basiert). Das Frontend
    // löst die `<cite index="N-…">`-Marker des Modells über die Position N auf und
    // rendert klickbare Quell-Links + eine Quellenliste.
    ...(webResults.length ? { sources: webResults } : {}),
    // Speicher-Vorschläge — Frontend rendert sie als „Als … speichern"-Buttons.
    ...(ctx.proposals.length ? { proposals: ctx.proposals } : {}),
  }),

  buildCompletePayload: ({ base, ctx }) => ({ ...base, proposals: ctx.proposals.length }),

  buildSummary: ({ sessionId, toolLog, webSearches, ctx }) =>
    `Recherche-Chat session=${sessionId}, ${toolLog.length} Tool-Calls, ${webSearches} Web-Suchen, ${ctx.proposals.length} Vorschläge`,
});

module.exports = { runResearchChatJob };
