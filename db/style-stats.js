'use strict';
// Lesepfad der Stil-Karte. Eigenes db/-Modul, weil die Aggregation Kapitelnamen
// zur Lesezeit braucht: der Namens-JOIN auf `pages`/`chapters` gehoert laut
// CLAUDE.md („Content-Store-Facade als einziger Eintrittspunkt") nicht in den
// Route-Handler, sondern hierher — Muster db/lektorat-heatmap.js#loadHeatmapRows.
//
// Rein lesend, kein Schreibpfad (`page_stats` fuellt lib/page-index.js ueber den
// Sync). Die Verdichtung selbst ist pure und liegt in
// [lib/stil-heatmap.js](../lib/stil-heatmap.js).
//
// Zwei Abfragen mit unterschiedlichem Zuschnitt, und das ist der Punkt:
// `loadStyleRows` laesst `style_samples` bewusst WEG. Die Spalte traegt pro Seite
// bis zu 15 Beispielsaetze; bei einem Buch mit tausenden Seiten ist sie der
// groesste Posten der Antwort, gebraucht wird davon aber immer nur eine
// aufgeklappte Zelle. Die holt `loadStyleSamples` fuer genau ein Kapitel nach.

const { db } = require('./connection');

// Reihenfolge = Leserichtung. Sie traegt zusammen mit der Reihenfolge innerhalb
// von `sentence_lens` den Satzrhythmus und darf nicht umsortiert werden.
const _stmtRows = db.prepare(`
  SELECT ps.page_id, p.chapter_id, c.chapter_name,
         ps.words, ps.chars, ps.dialog_chars,
         ps.filler_count, ps.passive_count, ps.adverb_count,
         ps.avg_sentence_len, ps.sentence_len_p90, ps.repetition_data,
         ps.lix, ps.flesch_de, ps.metrics_version, ps.cached_at,
         ps.sentence_lens, ps.opener_counts
  FROM page_stats ps
  JOIN pages p ON p.page_id = ps.page_id
  LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
  WHERE ps.book_id = ?
  ORDER BY p.chapter_id, p.page_id
`);

// Drilldown eines Kapitels: nur die Spalten, die das Detail-Panel braucht.
const _stmtSamplesChapter = db.prepare(`
  SELECT ps.page_id, p.page_name,
         ps.filler_count, ps.passive_count, ps.adverb_count,
         ps.repetition_data, ps.style_samples
  FROM page_stats ps
  JOIN pages p ON p.page_id = ps.page_id
  WHERE ps.book_id = ? AND p.chapter_id = ?
  ORDER BY p.page_id
`);

// Gegenstueck fuer Seiten ohne Kapitel. Eigenes Statement statt eines
// `IS ?`-Tricks, damit der Index auf p.chapter_id in beiden Faellen greift.
const _stmtSamplesUncat = db.prepare(`
  SELECT ps.page_id, p.page_name,
         ps.filler_count, ps.passive_count, ps.adverb_count,
         ps.repetition_data, ps.style_samples
  FROM page_stats ps
  JOIN pages p ON p.page_id = ps.page_id
  WHERE ps.book_id = ? AND p.chapter_id IS NULL
  ORDER BY p.page_id
`);

/** Alle Stil-Zeilen eines Buchs — ohne Beispielsaetze. */
function loadStyleRows(bookId) {
  return _stmtRows.all(bookId);
}

/** Beispielsaetze der Seiten EINES Kapitels. `chapterId === null` = ohne Kapitel. */
function loadStyleSamples(bookId, chapterId) {
  return chapterId == null
    ? _stmtSamplesUncat.all(bookId)
    : _stmtSamplesChapter.all(bookId, chapterId);
}

/** Kapitelname fuer die Ueberschrift des Detail-Panels (null = ohne Kapitel). */
function chapterNameOf(bookId, chapterId) {
  if (chapterId == null) return null;
  const row = db.prepare('SELECT chapter_name FROM chapters WHERE chapter_id = ? AND book_id = ?')
    .get(chapterId, bookId);
  return row?.chapter_name || null;
}

module.exports = { loadStyleRows, loadStyleSamples, chapterNameOf };
