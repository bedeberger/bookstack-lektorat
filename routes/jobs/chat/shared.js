'use strict';
// Geteilte Bausteine der drei Chats (Seiten-/Buch-/Recherche-Chat):
// Antwort-Parsing (lenient), gemeinsamer POST-Handler (_handleChatPost), und der
// Buch-Chat-Seiten-Cache (klassischer Pfad) inkl. Invalidierung.

const { parseJSONLenient } = require('../../../lib/ai');
const { stripTrailingEmptyJson } = require('../agentic-chat');
const { toIntId } = require('../../../lib/validate');
const { setContext } = require('../../../lib/log-context');
const { db } = require('../../../db/schema');
const { sessionEmail } = require('../../../lib/acl');
const {
  jobs, runningJobs, createJob, enqueueJob, jobKey, findActiveJobId,
} = require('../shared');

function _sanitizeVorschlaege(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(v => {
    const orig = typeof v?.original === 'string' ? v.original.trim() : '';
    const ers  = typeof v?.ersatz   === 'string' ? v.ersatz.trim()   : '';
    return orig && ers && orig !== ers;
  });
}

function _parseChatResponse(text) {
  // Lenient: bei kaputtem JSON (z.B. unescaptes `"` oder typografische Quotes
  // im Modell-Output) wenigstens `antwort` per Regex retten. Vorschläge gehen
  // nur sicher zu extrahieren, wenn Gesamt-JSON valid ist.
  const r = parseJSONLenient(text, ['antwort']);
  if (r.ok && typeof r.parsed?.antwort === 'string' && r.parsed.antwort.trim()) {
    return {
      antwort: r.parsed.antwort,
      vorschlaege: _sanitizeVorschlaege(r.parsed.vorschlaege),
      fallback: false,
    };
  }
  // r.ok-aber-antwort-leer = Modell schrieb Prosa und trailing leeres `{}`,
  // das extractBalancedJson erwischt hat. Roh-Prosa speichern, fence weg.
  if (r.ok) {
    return { antwort: stripTrailingEmptyJson(text) || text, vorschlaege: [], fallback: true };
  }
  return {
    antwort: r.partial.antwort ?? stripTrailingEmptyJson(r.partial._raw ?? text) ?? text,
    vorschlaege: [],
    fallback: true,
  };
}

// ── Buch-Chat-Seiten-Cache (klassischer Pfad) ────────────────────────────────
// Key `${bookId}:${userEmail}` → { pages, loadedAt }. TTL 10 Minuten, max. 20
// Einträge (FIFO-Eviction). Geteilt zwischen dem klassischen Buch-Chat-Job und
// der Cache-Invalidierung (DELETE /book-chat-cache + invalidateBookPageCache).
const bookPageCache = new Map();
const BOOK_PAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const BOOK_PAGE_CACHE_MAX = 20;

/**
 * Verwirft alle Cache-Einträge eines Buchs (alle User). Wird nach Sync-Operationen
 * aufgerufen, damit Buch-Chat nicht 10 Min lang auf veraltetem Content antwortet.
 * Cache-Key-Format: `${bookId}:${userEmail}` – Prefix-Match räumt alle User-
 * Varianten gleichzeitig ab (Permissions ändern sich selten und verlieren beim
 * Sync ohnehin ihre Aktualität).
 */
function invalidateBookPageCache(bookId) {
  const prefix = `${bookId}:`;
  for (const key of bookPageCache.keys()) {
    if (key.startsWith(prefix)) bookPageCache.delete(key);
  }
}

// ── Gemeinsamer Route-Handler ────────────────────────────────────────────────
function _handleChatPost(req, res, { jobType, sessionSelect, labelFn, runFn }) {
  const { message } = req.body;
  const session_id = toIntId(req.body?.session_id);
  const clientMsgId = typeof req.body?.client_msg_id === 'string' && req.body.client_msg_id.length <= 64
    ? req.body.client_msg_id
    : null;
  if (!session_id || !message?.trim()) return res.status(400).json({ error_code: 'SESSION_ID_MSG_REQUIRED' });
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  // Idempotency: gleicher client_msg_id in selber Session → bestehende jobId zurück,
  // KEIN zweiter Insert. Schützt vor Doppel-Send bei Connection-Loss-Retry.
  if (clientMsgId) {
    const dup = db.prepare(
      `SELECT job_id FROM chat_messages WHERE session_id = ? AND client_msg_id = ?`
    ).get(session_id, clientMsgId);
    if (dup) return res.json({ jobId: dup.job_id || null, existing: true });
  }

  const existing = findActiveJobId(jobType, session_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const session = db.prepare(sessionSelect).get(session_id, userEmail);
  if (!session) return res.status(404).json({ error_code: 'SESSION_NOT_FOUND' });
  if (session.book_id) setContext({ book: session.book_id });

  // ACL-Guard. Page-Chat: lektor+. Buch-Chat: editor+, ausser
  // book_settings.allow_lektor_book_chat=1 setzt es auf lektor+.
  if (session.book_id) {
    const { requireBookAccess, sendACLError, ACLError } = require('../../../lib/acl');
    const { getBookSettings } = require('../../../db/schema');
    let minRole = 'lektor';
    if (jobType === 'book-chat') {
      const bs = getBookSettings(session.book_id);
      minRole = bs?.allow_lektor_book_chat ? 'lektor' : 'editor';
    } else if (jobType === 'research-chat') {
      // Recherche-Board ist editor-scoped → Recherche-Chat ebenso.
      minRole = 'editor';
    }
    try { requireBookAccess(req, session.book_id, minRole); }
    catch (e) {
      if (e instanceof ACLError) { sendACLError(res, e); return; }
      throw e;
    }
  }

  const now = new Date().toISOString();
  const userMsgResult = db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, created_at, client_msg_id) VALUES (?, 'user', ?, ?, ?)`
  ).run(session.id, message.trim(), now, clientMsgId);
  db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(now, session.id);

  const userToken = null;

  const { key: label, params: labelParams } = labelFn(session);
  const jobId = createJob(jobType, session.book_id || 0, userEmail, label, labelParams, session_id);
  db.prepare('UPDATE chat_messages SET job_id = ? WHERE id = ?').run(jobId, userMsgResult.lastInsertRowid);
  enqueueJob(jobId, () => runFn(jobId, session_id, userMsgResult.lastInsertRowid, message.trim(), userEmail, userToken));
  res.json({ jobId });
}

// Zeichenbudget des Figuren-Blocks im Chat-System-Prompt. `getFiguren`
// (routes/jobs/shared/queries.js) liefert Volldossiers — Szenen, Schauplätze,
// Beziehungen und Lebensereignisse je Figur. Bei einem ausanalysierten Buch sind das
// mehrere Hunderttausend Zeichen, ein Mehrfaches jedes Kontextfensters: ungekappt
// scheitert der Call am Preflight (lib/ai/shared.js#assertPromptFitsContext), bevor
// eine Zeile Buchtext oder ein Werkzeug-Ergebnis im Prompt steht.
// Ein Viertel des Input-Budgets: der Block ist Stufe 1 der Kosten-Leiter und darf
// spürbar kosten, aber nie den Platz für Buchtext (klassisch) bzw. Werkzeug-Ergebnisse
// (agentisch) auffressen. Kappung + Offenlegung macht
// public/js/prompts/chat.js#buildFigurenBlock — geteilt von allen drei Chat-Prompts.
function figurenBlockChars(aiCfg) {
  return Math.max(6000, Math.floor((aiCfg?.inputBudgetChars || 0) * 0.25));
}

// Welt-Fakten-Block: dieselbe Logik, aber ein Zehntel des Budgets — die Fakten sind
// kurze Einzeiler, und der Block soll den Figuren-Block nicht verdraengen. Kein
// eigenes App-Setting: der Wert leitet sich wie der Figuren-Deckel aus dem
// Kontextfenster des effektiven Providers ab. Kappung + Offenlegung macht
// public/js/prompts/chat.js#buildWeltfaktenBlock.
function weltfaktenBlockChars(aiCfg) {
  return Math.max(2000, Math.floor((aiCfg?.inputBudgetChars || 0) * 0.10));
}

module.exports = {
  _sanitizeVorschlaege, _parseChatResponse, _handleChatPost, figurenBlockChars, weltfaktenBlockChars,
  bookPageCache, BOOK_PAGE_CACHE_TTL_MS, BOOK_PAGE_CACHE_MAX, invalidateBookPageCache,
};
