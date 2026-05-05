const path = require('path');
const fs = require('fs');
const { db } = require('./connection');
const logger = require('../logger');
require('./migrations');
const { saveFigurenToDb } = require('./figures');

// Einmalige Migration von lektorat-history.json
function migrateFromJson() {
  const HISTORY_FILE = path.join(__dirname, '..', 'lektorat-history.json');
  if (!fs.existsSync(HISTORY_FILE)) return;

  const existing = db.prepare('SELECT COUNT(*) as c FROM page_checks').get();
  if (existing.c > 0) {
    logger.info('lektorat-history.json vorhanden, aber DB hat bereits Daten – Migration übersprungen.');
    return;
  }

  let h;
  try { h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch (e) { logger.error('Migration: JSON lesen fehlgeschlagen: ' + e.message); return; }

  const insCheck = db.prepare(`
    INSERT INTO page_checks (page_id, page_name, book_id, checked_at, error_count, errors_json, stilanalyse, fazit, model, saved, saved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insReview = db.prepare(`
    INSERT INTO book_reviews (book_id, book_name, reviewed_at, review_json, model)
    VALUES (?, ?, ?, ?, ?)`);

  db.transaction(() => {
    for (const r of (h.page_checks || [])) {
      insCheck.run(r.page_id, r.page_name, r.book_id, r.checked_at,
        r.error_count || 0, JSON.stringify(r.errors_json || []),
        r.stilanalyse || null, r.fazit || null, r.model || null,
        r.saved ? 1 : 0, r.saved_at || null);
    }
    for (const r of (h.book_reviews || [])) {
      insReview.run(r.book_id, r.book_name, r.reviewed_at,
        JSON.stringify(r.review_json || null), r.model || null);
    }
    for (const [bookId, entry] of Object.entries(h.book_figures || {})) {
      if (entry?.figuren?.length) {
        saveFigurenToDb(parseInt(bookId), entry.figuren);
      }
    }
  })();

  fs.renameSync(HISTORY_FILE, HISTORY_FILE + '.migrated');
  logger.info('Migration von lektorat-history.json abgeschlossen (Datei umbenannt zu .migrated).');
}
migrateFromJson();

// Heilt nur noch locations.erste_erwaehnung_page_id (Freitext-Snapshot → page_id).
// Snapshot-Spalten (chapter_name/kapitel/seite) wurden entfernt — Display-Werte
// werden zur Lese-Zeit aus chapters/pages JOIN'd.
//
// `bookId` (optional, Number): scoped das UPDATE auf das angegebene Buch.
function reconcilePageIds(bookId = null) {
  db.prepare(`
    UPDATE locations
    SET erste_erwaehnung_page_id = (
      SELECT p.page_id FROM pages p
      WHERE p.book_id = locations.book_id
        AND p.page_name = locations.erste_erwaehnung
      LIMIT 1
    )
    WHERE erste_erwaehnung IS NOT NULL
      ${bookId != null ? `AND locations.book_id = ${Number(bookId)}` : ''}
  `).run();
}

// Entfernt Pages/Chapters, die in BookStack für dieses Buch nicht mehr
// existieren, plus deren abhängige Daten (Fehler-Historie, Stats, Chat-Sessions,
// Figuren-/Orte-Zuordnungen). Umbenennungen werden NICHT gelöscht – die
// Identifikation läuft ausschließlich über page_id/chapter_id (stabile IDs).
//
// Muss nach dem Upsert der pages/chapters-Cache aufgerufen werden, weil der
// Upsert neue/umbenannte Einträge hinzufügt, aber alte nicht entfernen kann.
//
// User-kuratierte Daten (figure_events/figure_scenes/locations) werden nicht
// gelöscht; nur die Verweis-IDs/-Namen werden genullt, sodass reconcilePageIds
// sie nicht fälschlich heilt.
function pruneStaleBookData(bookId, validPageIds, validChapterIds) {
  const validPageSet = new Set(Array.from(validPageIds, Number));
  const validChapterSet = new Set(Array.from(validChapterIds, Number));

  const storedPageIds = db.prepare('SELECT page_id FROM pages WHERE book_id = ?')
    .all(bookId).map(r => r.page_id);
  const stalePageIds = storedPageIds.filter(pid => !validPageSet.has(pid));

  const storedChapterIds = db.prepare('SELECT chapter_id FROM chapters WHERE book_id = ?')
    .all(bookId).map(r => r.chapter_id);
  const staleChapterIds = storedChapterIds.filter(cid => !validChapterSet.has(cid));

  const counts = {
    stale_pages: stalePageIds.length,
    stale_chapters: staleChapterIds.length,
    page_checks: 0,
    page_stats: 0,
    page_figure_mentions: 0,
    chat_sessions: 0,
    ideen: 0,
    pages: 0,
    chapter_reviews: 0,
    chapter_extract_cache: 0,
    figure_appearances: 0,
    location_chapters: 0,
    chapters: 0,
  };

  if (stalePageIds.length === 0 && staleChapterIds.length === 0) return counts;

  db.transaction(() => {
    if (stalePageIds.length > 0) {
      db.exec('CREATE TEMP TABLE IF NOT EXISTS _stale_pages (page_id INTEGER PRIMARY KEY)');
      db.exec('DELETE FROM _stale_pages');
      const insP = db.prepare('INSERT INTO _stale_pages (page_id) VALUES (?)');
      for (const pid of stalePageIds) insP.run(pid);

      counts.page_checks          = db.prepare('DELETE FROM page_checks          WHERE book_id = ? AND page_id IN (SELECT page_id FROM _stale_pages)').run(bookId).changes;
      counts.page_stats           = db.prepare('DELETE FROM page_stats           WHERE book_id = ? AND page_id IN (SELECT page_id FROM _stale_pages)').run(bookId).changes;
      counts.page_figure_mentions = db.prepare('DELETE FROM page_figure_mentions WHERE page_id IN (SELECT page_id FROM _stale_pages) AND figure_id IN (SELECT id FROM figures WHERE book_id = ?)').run(bookId).changes;
      // Seiten-Chat-Sessions verwaister Seiten löschen (Buch-Chat = kind='book' bleibt)
      counts.chat_sessions        = db.prepare("DELETE FROM chat_sessions        WHERE book_id = ? AND kind = 'page' AND page_id IN (SELECT page_id FROM _stale_pages)").run(bookId).changes;
      // Ideen verwaister Seiten löschen (user-scoped Tabelle, aber Page weg → Inhalt obsolet)
      counts.ideen                = db.prepare('DELETE FROM ideen                WHERE book_id = ? AND page_id IN (SELECT page_id FROM _stale_pages)').run(bookId).changes;

      // User-kuratierte Daten nur nullen (page_id-Ref weg, fachliche Daten bleiben)
      db.prepare('UPDATE figure_events SET page_id = NULL WHERE page_id IN (SELECT page_id FROM _stale_pages)').run();
      db.prepare('UPDATE figure_scenes SET page_id = NULL WHERE page_id IN (SELECT page_id FROM _stale_pages) AND book_id = ?').run(bookId);
      db.prepare('UPDATE locations     SET erste_erwaehnung_page_id = NULL, erste_erwaehnung = NULL WHERE book_id = ? AND erste_erwaehnung_page_id IN (SELECT page_id FROM _stale_pages)').run(bookId);

      counts.pages = db.prepare('DELETE FROM pages WHERE book_id = ? AND page_id IN (SELECT page_id FROM _stale_pages)').run(bookId).changes;
      db.exec('DROP TABLE _stale_pages');
    }

    if (staleChapterIds.length > 0) {
      db.exec('CREATE TEMP TABLE IF NOT EXISTS _stale_chapters (chapter_id INTEGER PRIMARY KEY)');
      db.exec('DELETE FROM _stale_chapters');
      const insC = db.prepare('INSERT INTO _stale_chapters (chapter_id) VALUES (?)');
      for (const cid of staleChapterIds) insC.run(cid);

      counts.chapter_reviews    = db.prepare('DELETE FROM chapter_reviews    WHERE book_id = ? AND chapter_id IN (SELECT chapter_id FROM _stale_chapters)').run(bookId).changes;
      counts.figure_appearances = db.prepare('DELETE FROM figure_appearances WHERE chapter_id IN (SELECT chapter_id FROM _stale_chapters) AND figure_id IN (SELECT id FROM figures WHERE book_id = ?)').run(bookId).changes;
      counts.location_chapters  = db.prepare('DELETE FROM location_chapters  WHERE chapter_id IN (SELECT chapter_id FROM _stale_chapters) AND location_id IN (SELECT id FROM locations WHERE book_id = ?)').run(bookId).changes;

      // chapter_extract_cache: chapter_key ist String(chapter_id)
      const stmtCec = db.prepare('DELETE FROM chapter_extract_cache WHERE book_id = ? AND chapter_key = ?');
      for (const cid of staleChapterIds) counts.chapter_extract_cache += stmtCec.run(bookId, String(cid)).changes;

      db.prepare('UPDATE figure_events SET chapter_id = NULL WHERE chapter_id IN (SELECT chapter_id FROM _stale_chapters)').run();
      db.prepare('UPDATE figure_scenes SET chapter_id = NULL WHERE chapter_id IN (SELECT chapter_id FROM _stale_chapters) AND book_id = ?').run(bookId);
      db.prepare('UPDATE page_checks   SET chapter_id = NULL WHERE book_id = ? AND chapter_id IN (SELECT chapter_id FROM _stale_chapters)').run(bookId);

      counts.chapters = db.prepare('DELETE FROM chapters WHERE book_id = ? AND chapter_id IN (SELECT chapter_id FROM _stale_chapters)').run(bookId).changes;
      db.exec('DROP TABLE _stale_chapters');
    }
  })();

  return counts;
}

module.exports = {
  migrateFromJson,
  reconcilePageIds,
  pruneStaleBookData,
};
