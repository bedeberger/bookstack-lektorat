'use strict';
// Lesepfad der Fehler-Heatmap. Eigenes db/-Modul, weil die Aggregation
// Seiten-/Kapitelnamen zur Lesezeit braucht: der Namens-JOIN auf `pages`/
// `chapters` gehoert laut CLAUDE.md ("Content-Store-Facade als einziger
// Eintrittspunkt") nicht in den Route-Handler, sondern hierher — Muster
// db/sources/citations.js#listSourceCitations.
//
// Rein lesend, kein Schreibpfad. Die Verdichtung selbst ist pure und liegt in
// [lib/fehler-heatmap.js](../lib/fehler-heatmap.js).

const { db } = require('./connection');

// Seiten des Buchs mit Kapitel-Zuordnung + Woerter-Nenner fuer die Dichte.
const _stmtPages = db.prepare(`
  SELECT p.page_id, p.page_name, p.chapter_id, c.chapter_name,
         COALESCE(ps.words, 0) AS words
  FROM pages p
  LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
  LEFT JOIN page_stats ps ON ps.page_id = p.page_id
  WHERE p.book_id = ?
`);

// errors_json aus dem juengsten Check pro Seite = aktueller Findings-Stand.
const _stmtLatestChecks = db.prepare(`
  WITH latest AS (
    SELECT page_id, errors_json,
           ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY checked_at DESC) AS rn
    FROM page_checks
    WHERE book_id = ? AND user_email = ?
  )
  SELECT page_id, errors_json FROM latest WHERE rn = 1
`);

// Alle Checks mit applied_errors_json — die Union daraus ist kumulativ.
const _stmtApplied = db.prepare(`
  SELECT page_id, applied_errors_json
  FROM page_checks
  WHERE book_id = ? AND user_email = ? AND applied_errors_json IS NOT NULL
`);

/** Rohzeilen fuer buildFehlerHeatmap: { pages, checks, appliedRows }. */
function loadHeatmapRows(bookId, userEmail) {
  return {
    pages: _stmtPages.all(bookId),
    checks: _stmtLatestChecks.all(bookId, userEmail),
    appliedRows: _stmtApplied.all(bookId, userEmail),
  };
}

module.exports = { loadHeatmapRows };
