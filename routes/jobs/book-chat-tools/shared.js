'use strict';
// Geteilte Helfer für Buch-Chat-Tools. Bündelt Token-Budget-Klemmgrenzen,
// das _truncateResult-Pattern und die _findFigure-Lookup-Heuristik.

const { db } = require('../../../db/schema');
const { INPUT_BUDGET_CHARS } = require('../../../lib/ai');

// Obergrenzen schützen das Token-Budget gegen ausufernde Tool-Calls. Skaliert mit
// MODEL_CONTEXT, damit User mit grösserem Kontextfenster reichere Tool-Antworten
// bekommen (mehr Seiten, längere Snippets). chat.js schneidet zusätzlich hart auf
// TOOL_RESULT_CAP_CHARS, bevor die Antwort an das Modell geht.
// Divisor 36 ≈ BOOK_CHAT_MAX_TOOL_ITER (6) × typische Tool-Calls/Iter (3) × Sicherheit (2).
const MAX_RESULT_CHARS       = Math.max(4000, Math.floor(INPUT_BUDGET_CHARS / 36));
const MAX_CHARS_PER_PAGE     = MAX_RESULT_CHARS;
const DEFAULT_CHARS_PER_PAGE = Math.max(2000, Math.floor(MAX_CHARS_PER_PAGE * 0.4));
// Listen-Limits bleiben fix (UI-Ergonomie, nicht Kontextfenster-Schutz):
const MAX_SEARCH_RESULTS     = 30;
const MAX_PAGES_PER_FETCH    = 20;
const SEARCH_SNIPPET_CONTEXT = 120; // Zeichen vor + nach dem Treffer

/** Kürzt ein Tool-Result-Objekt, damit es nicht das Token-Budget sprengt. */
function _truncateResult(obj) {
  const s = JSON.stringify(obj);
  if (s.length <= MAX_RESULT_CHARS) return obj;
  // Fallback: wenn shown/results-Array existiert, kürzen und truncated-Flag setzen
  if (Array.isArray(obj.results) && obj.results.length > 5) {
    return {
      ..._truncateResult({ ...obj, results: obj.results.slice(0, 10) }),
      truncated: true,
      total_results: obj.results.length,
    };
  }
  // Letzter Ausweg: stringifizieren und hart schneiden
  return { _truncated: s.slice(0, MAX_RESULT_CHARS - 100) + '… [result truncated]' };
}

/**
 * Titel einer semantisch getroffenen Entität (page/scene/figure). Geteilt von
 * `search_similar` (tools-text.js) und dem Erst-Kontext des agentischen Buch-Chats
 * (routes/jobs/chat/book-chat-retrieval.js) — beide lösen dieselben drei Kinds des
 * Embedding-Index auf. Rückgabe null = Entität gelöscht, Chunk noch im Index.
 */
function resolveEntityTitle(kind, entityId) {
  if (kind === 'page')   return db.prepare('SELECT page_name AS t FROM pages WHERE page_id = ?').get(entityId)?.t ?? null;
  if (kind === 'scene')  return db.prepare('SELECT titel AS t FROM figure_scenes WHERE id = ?').get(entityId)?.t ?? null;
  if (kind === 'figure') return db.prepare('SELECT name AS t FROM figures WHERE id = ?').get(entityId)?.t ?? null;
  return null;
}

/** Lookup einer Figur per fig_id (exakt) oder figur_name (LIKE + Exact-Match-Bonus). */
function _findFigure(input, ctx) {
  const userEmail = ctx.userEmail || null;
  let row = null;
  if (input.figur_id) {
    row = db.prepare(
      'SELECT id, fig_id, name, kurzname FROM figures WHERE book_id = ? AND fig_id = ? AND user_email IS ?'
    ).get(ctx.bookId, input.figur_id, userEmail);
  }
  if (!row && input.figur_name) {
    const q = `%${input.figur_name}%`;
    row = db.prepare(
      `SELECT id, fig_id, name, kurzname FROM figures
         WHERE book_id = ? AND user_email IS ?
           AND (name LIKE ? OR kurzname LIKE ?)
         ORDER BY CASE WHEN name = ? OR kurzname = ? THEN 0 ELSE 1 END, id
         LIMIT 1`
    ).get(ctx.bookId, userEmail, q, q, input.figur_name, input.figur_name);
  }
  return row;
}

module.exports = {
  MAX_RESULT_CHARS,
  MAX_CHARS_PER_PAGE,
  DEFAULT_CHARS_PER_PAGE,
  MAX_SEARCH_RESULTS,
  MAX_PAGES_PER_FETCH,
  SEARCH_SNIPPET_CONTEXT,
  _truncateResult,
  _findFigure,
  resolveEntityTitle,
};
