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

// Seiten-ID-Reconciliation: wird nach jedem syncBook()-Aufruf aufgerufen.
// Befüllt chapter_id/page_id in den Figuren-Tabellen anhand der pages-Cache-Tabelle
// und heilt veraltete Namen bei Kapitel-/Seiten-Umbenennungen in BookStack.
function reconcilePageIds() {
  db.prepare(`
    UPDATE figure_appearances
    SET chapter_id = (
      SELECT DISTINCT p.chapter_id FROM pages p
      JOIN figures f ON f.book_id = p.book_id
      WHERE f.id = figure_appearances.figure_id
        AND p.chapter_name = figure_appearances.chapter_name
        AND p.chapter_id IS NOT NULL
      LIMIT 1
    )
    WHERE chapter_id IS NULL AND chapter_name IS NOT NULL
  `).run();

  db.prepare(`
    UPDATE figure_appearances
    SET chapter_name = (
      SELECT DISTINCT p.chapter_name FROM pages p
      JOIN figures f ON f.book_id = p.book_id
      WHERE f.id = figure_appearances.figure_id
        AND p.chapter_id = figure_appearances.chapter_id
      LIMIT 1
    )
    WHERE chapter_id IS NOT NULL
  `).run();

  db.prepare(`
    UPDATE figure_events
    SET chapter_id = (
      SELECT DISTINCT p.chapter_id FROM pages p
      JOIN figures f ON f.book_id = p.book_id
      WHERE f.id = figure_events.figure_id
        AND p.chapter_name = figure_events.kapitel
        AND p.chapter_id IS NOT NULL
      LIMIT 1
    )
    WHERE chapter_id IS NULL AND kapitel IS NOT NULL
  `).run();

  db.prepare(`
    UPDATE figure_events
    SET page_id = (
      SELECT p.page_id FROM pages p
      JOIN figures f ON f.book_id = p.book_id
      WHERE f.id = figure_events.figure_id
        AND p.page_name = figure_events.seite
      LIMIT 1
    )
    WHERE page_id IS NULL AND seite IS NOT NULL
  `).run();

  db.prepare(`
    UPDATE figure_events
    SET kapitel = (
      SELECT DISTINCT p.chapter_name FROM pages p
      JOIN figures f ON f.book_id = p.book_id
      WHERE f.id = figure_events.figure_id
        AND p.chapter_id = figure_events.chapter_id
      LIMIT 1
    )
    WHERE chapter_id IS NOT NULL
  `).run();

  db.prepare(`
    UPDATE figure_events
    SET seite = (
      SELECT p.page_name FROM pages p
      WHERE p.page_id = figure_events.page_id
      LIMIT 1
    )
    WHERE page_id IS NOT NULL
  `).run();

  db.prepare(`
    UPDATE figure_scenes
    SET chapter_id = (
      SELECT DISTINCT chapter_id FROM pages
      WHERE book_id = figure_scenes.book_id
        AND chapter_name = figure_scenes.kapitel
        AND chapter_id IS NOT NULL
      LIMIT 1
    )
    WHERE chapter_id IS NULL AND kapitel IS NOT NULL
  `).run();

  db.prepare(`
    UPDATE figure_scenes
    SET page_id = (
      SELECT page_id FROM pages
      WHERE book_id = figure_scenes.book_id
        AND page_name = figure_scenes.seite
      LIMIT 1
    )
    WHERE page_id IS NULL AND seite IS NOT NULL
  `).run();

  // kapitel ist NOT NULL → COALESCE, damit Null-Treffer den Wert nicht überschreiben
  db.prepare(`
    UPDATE figure_scenes
    SET kapitel = COALESCE((
      SELECT DISTINCT chapter_name FROM pages
      WHERE book_id = figure_scenes.book_id
        AND chapter_id = figure_scenes.chapter_id
      LIMIT 1
    ), kapitel)
    WHERE chapter_id IS NOT NULL
  `).run();

  db.prepare(`
    UPDATE figure_scenes
    SET seite = (
      SELECT page_name FROM pages
      WHERE page_id = figure_scenes.page_id
      LIMIT 1
    )
    WHERE page_id IS NOT NULL
  `).run();

  db.prepare(`
    UPDATE location_chapters
    SET chapter_id = (
      SELECT DISTINCT p.chapter_id FROM pages p
      JOIN locations l ON l.id = location_chapters.location_id
      WHERE p.book_id = l.book_id
        AND p.chapter_name = location_chapters.chapter_name
        AND p.chapter_id IS NOT NULL
      LIMIT 1
    )
    WHERE chapter_id IS NULL AND chapter_name IS NOT NULL
  `).run();

  db.prepare(`
    UPDATE location_chapters
    SET chapter_name = (
      SELECT DISTINCT p.chapter_name FROM pages p
      JOIN locations l ON l.id = location_chapters.location_id
      WHERE p.book_id = l.book_id
        AND p.chapter_id = location_chapters.chapter_id
      LIMIT 1
    )
    WHERE chapter_id IS NOT NULL
  `).run();

  db.prepare(`
    UPDATE locations
    SET erste_erwaehnung_page_id = (
      SELECT p.page_id FROM pages p
      WHERE p.book_id = locations.book_id
        AND p.page_name = locations.erste_erwaehnung
      LIMIT 1
    )
    WHERE erste_erwaehnung IS NOT NULL
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
      // Buch-Chat (page_id=0) nicht antasten; chat_messages werden per FK CASCADE mitgenommen
      counts.chat_sessions        = db.prepare('DELETE FROM chat_sessions        WHERE book_id = ? AND page_id != 0 AND page_id IN (SELECT page_id FROM _stale_pages)').run(bookId).changes;

      // User-kuratierte Daten nur nullen (page_name/seite mit, damit reconcile sie nicht neu resettet)
      db.prepare('UPDATE figure_events SET page_id = NULL, seite = NULL WHERE page_id IN (SELECT page_id FROM _stale_pages)').run();
      db.prepare('UPDATE figure_scenes SET page_id = NULL, seite = NULL WHERE page_id IN (SELECT page_id FROM _stale_pages) AND book_id = ?').run(bookId);
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

      // kapitel bleibt in figure_scenes NOT NULL → nicht anfassen
      db.prepare('UPDATE figure_events SET chapter_id = NULL, kapitel = NULL WHERE chapter_id IN (SELECT chapter_id FROM _stale_chapters)').run();
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
