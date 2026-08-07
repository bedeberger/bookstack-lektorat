'use strict';
// Textsorte pro Seite (Soll) + Struktur-Befund pro Seite (Ist).
//
// Die Textsorte eines journalistischen Beitrags steht auf zwei Ebenen: der
// Default des Buchs in `book_settings.textsorte` und die Ausnahme pro Artikel in
// `page_textsorte`. `effectiveTextsorte` ist die einzige Stelle, die diese
// Vorrangregel kennt — jeder Konsument (Lektorat, Struktur-Check, Karte) fragt
// hier, damit nicht drei Schichten je eine eigene Fallback-Kette bauen.
//
// `page_structure_checks` ist ein abgeleiteter Befund: Full-Replace pro Lauf,
// eine Zeile pro Seite. `content_sig` haelt fest, gegen welchen Textstand
// geprueft wurde — ohne das zeigt die Karte einen Befund zu einer Fassung, die
// es nicht mehr gibt.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

// Gueltige Keys spiegeln public/js/prompts/textsorten.js#TEXTSORTE_KEYS.
// CJS-Spiegel, weil die Schreibpfade (Route, Job) synchron validieren muessen;
// Drift ist durch tests/unit/textsorten-drift.test.mjs gegated.
const TEXTSORTE_KEYS = [
  'nachricht', 'bericht', 'reportage', 'interview',
  'portraet', 'feature', 'kommentar', 'glosse', 'rezension',
];

function isValidTextsorte(v) {
  return typeof v === 'string' && TEXTSORTE_KEYS.includes(v);
}

// ── Textsorte pro Seite ──────────────────────────────────────────────────────

const _stmtGetPage = db.prepare('SELECT textsorte FROM page_textsorte WHERE page_id = ?');
const _stmtListForBook = db.prepare(
  'SELECT page_id, textsorte FROM page_textsorte WHERE book_id = ?',
);
const _stmtSetPage = db.prepare(`
  INSERT INTO page_textsorte (page_id, book_id, textsorte, updated_at)
  VALUES (?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(page_id) DO UPDATE SET
    textsorte = excluded.textsorte,
    book_id   = excluded.book_id,
    updated_at = excluded.updated_at
`);
const _stmtClearPage = db.prepare('DELETE FROM page_textsorte WHERE page_id = ?');

/** Ausdrueckliche Textsorte dieser Seite oder null (= Buch-Default gilt). */
function getPageTextsorte(pageId) {
  return _stmtGetPage.get(parseInt(pageId))?.textsorte || null;
}

/** Alle Seiten-Overrides eines Buchs als { [page_id]: textsorte }. */
function listPageTextsorten(bookId) {
  const out = {};
  for (const r of _stmtListForBook.all(parseInt(bookId))) out[String(r.page_id)] = r.textsorte;
  return out;
}

/** Setzt (oder mit `null` loescht) den Seiten-Override. Ungueltige Keys werfen. */
function setPageTextsorte(pageId, bookId, textsorte) {
  const pid = parseInt(pageId);
  if (textsorte == null || textsorte === '') { _stmtClearPage.run(pid); return null; }
  if (!isValidTextsorte(textsorte)) {
    const err = new Error(`Ungueltige Textsorte: ${textsorte}`);
    err.code = 'INVALID_TEXTSORTE';
    throw err;
  }
  _stmtSetPage.run(pid, parseInt(bookId), textsorte);
  return textsorte;
}

/**
 * Die geltende Textsorte einer Seite: Seiten-Override vor Buch-Default.
 * Liefert `null`, wenn weder das eine noch das andere gesetzt ist — dann ist
 * das Buch kein journalistisches Projekt und niemand soll eine Form annehmen.
 */
function effectiveTextsorte(pageId, bookSettings = null) {
  return getPageTextsorte(pageId) || bookSettings?.textsorte || null;
}

// ── Struktur-Befund ──────────────────────────────────────────────────────────

const _stmtGetCheck = db.prepare(
  'SELECT page_id, textsorte, gesamturteil, result_json, content_sig, created_at FROM page_structure_checks WHERE page_id = ?',
);
const _stmtListChecks = db.prepare(
  'SELECT page_id, textsorte, gesamturteil, result_json, content_sig, created_at FROM page_structure_checks WHERE book_id = ?',
);
const _stmtSaveCheck = db.prepare(`
  INSERT INTO page_structure_checks (page_id, book_id, textsorte, gesamturteil, result_json, content_sig, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(page_id) DO UPDATE SET
    book_id      = excluded.book_id,
    textsorte    = excluded.textsorte,
    gesamturteil = excluded.gesamturteil,
    result_json  = excluded.result_json,
    content_sig  = excluded.content_sig,
    created_at   = excluded.created_at
`);

function _mapCheck(r) {
  if (!r) return null;
  let result = null;
  try { result = JSON.parse(r.result_json); } catch { result = null; }
  return {
    page_id: r.page_id,
    textsorte: r.textsorte,
    gesamturteil: r.gesamturteil || null,
    result,
    content_sig: r.content_sig || null,
    created_at: r.created_at,
  };
}

function getStructureCheck(pageId) {
  return _mapCheck(_stmtGetCheck.get(parseInt(pageId)));
}

function listStructureChecks(bookId) {
  return _stmtListChecks.all(parseInt(bookId)).map(_mapCheck);
}

function saveStructureCheck(pageId, bookId, { textsorte, gesamturteil = null, result, contentSig = null }) {
  _stmtSaveCheck.run(
    parseInt(pageId), parseInt(bookId), textsorte,
    gesamturteil, JSON.stringify(result ?? {}), contentSig,
  );
}

module.exports = {
  TEXTSORTE_KEYS, isValidTextsorte,
  getPageTextsorte, listPageTextsorten, setPageTextsorte, effectiveTextsorte,
  getStructureCheck, listStructureChecks, saveStructureCheck,
};
