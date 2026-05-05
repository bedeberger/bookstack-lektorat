// Lokale `books`-Tabelle: FK-Target fuer alle book_id-tragenden Tabellen.
// `book_id` ist der externe BookStack-Identifier und gleichzeitig PRIMARY KEY
// (analog pages.page_id und chapters.chapter_id). Discovery-Hooks (sync.js +
// Job-Routen, die book_name aus dem Request-Body erhalten) halten die Tabelle
// aktuell, ohne dass jede Beruehrung einen API-Roundtrip braucht.
const { db } = require('./connection');
const logger = require('../logger');

const _stmtUpsertBook = db.prepare(`
  INSERT INTO books (book_id, name, slug, created_at, updated_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    name=excluded.name, slug=excluded.slug,
    updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at
`);

// Variante ohne Slug — Frontend-POSTs liefern nur book_id+book_name. Slug
// nicht mit NULL ueberschreiben, falls schon befuellt.
const _stmtUpsertBookByName = db.prepare(`
  INSERT INTO books (book_id, name, slug, created_at, updated_at, last_seen_at)
  VALUES (?, ?, NULL, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    name=excluded.name, updated_at=excluded.updated_at,
    last_seen_at=excluded.last_seen_at
`);

const _stmtGetName = db.prepare('SELECT name FROM books WHERE book_id = ?');

function upsertBook(b) {
  if (!b || !b.id) return;
  const now = new Date().toISOString();
  _stmtUpsertBook.run(b.id, b.name || `Buch ${b.id}`, b.slug || null, now, now, now);
}

function upsertBookByName(bookId, name) {
  const id = parseInt(bookId);
  if (!Number.isInteger(id) || id <= 0) return;
  if (!name) return;
  const now = new Date().toISOString();
  _stmtUpsertBookByName.run(id, name, now, now, now);
}

function getBookName(bookId) {
  const r = _stmtGetName.get(parseInt(bookId));
  return r ? r.name : null;
}

// Time-basiertes Pruning: alles mit last_seen_at < cutoff wird geloescht.
// Reihenfolge pages → chapters → books, weil pages.chapter_id FK SET NULL auf
// chapters und chapter-Cascades sonst pages-Rows treffen, die ohnehin weggehen.
// Pages-DELETE triggert FK CASCADE (page_stats, page_checks, page_figure_mentions,
// chat_sessions[kind=page], ideen) und FK SET NULL (figure_events.page_id,
// figure_scenes.page_id, locations.erste_erwaehnung_page_id).
// Chapters-DELETE triggert CASCADE (chapter_reviews, chapter_extract_cache,
// figure_appearances, location_chapters) und SET NULL (figure_events.chapter_id,
// figure_scenes.chapter_id, page_checks.chapter_id, pages.chapter_id).
function pruneStaleByAge(days) {
  const cutoffMs = Date.now() - Math.max(1, days) * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString();
  const counts = { stale_pages: 0, stale_chapters: 0, stale_books: 0 };

  db.transaction(() => {
    counts.stale_pages = db.prepare(
      'DELETE FROM pages WHERE last_seen_at IS NOT NULL AND last_seen_at < ?'
    ).run(cutoff).changes;

    counts.stale_chapters = db.prepare(
      'DELETE FROM chapters WHERE last_seen_at IS NOT NULL AND last_seen_at < ?'
    ).run(cutoff).changes;

    counts.stale_books = db.prepare(
      'DELETE FROM books WHERE last_seen_at IS NOT NULL AND last_seen_at < ?'
    ).run(cutoff).changes;
  })();

  if (counts.stale_pages || counts.stale_chapters || counts.stale_books) {
    logger.info(
      `Stale-Prune (Schwelle ${days} Tage): ${counts.stale_books} Buch/Buecher, ` +
      `${counts.stale_chapters} Kapitel, ${counts.stale_pages} Seiten entfernt.`
    );
  }
  return counts;
}

module.exports = { upsertBook, upsertBookByName, getBookName, pruneStaleByAge };
