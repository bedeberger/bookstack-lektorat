'use strict';
// Bruecke Buch ↔ Quelle (`book_source_links`). Zuordnen ist eine Buch-Operation,
// Anlegen eine Bibliotheks-Operation — die beiden duerfen nicht verschmelzen.

const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');

// ── Bruecke Buch ↔ Quelle ────────────────────────────────────────────────────

const _stmtLink = db.prepare(`
  INSERT OR IGNORE INTO book_source_links (book_id, source_id, added_by, created_at)
  VALUES (?, ?, ?, ${NOW_ISO_SQL})
`);
const _stmtUnlink = db.prepare('DELETE FROM book_source_links WHERE book_id = ? AND source_id = ?');
const _stmtIsLinked = db.prepare(
  'SELECT 1 AS x FROM book_source_links WHERE book_id = ? AND source_id = ? LIMIT 1'
);
const _stmtSourceBooks = db.prepare(`
  SELECT b.book_id, b.name
    FROM book_source_links l
    JOIN books b ON b.book_id = l.book_id
   WHERE l.source_id = ?
   ORDER BY b.name
`);

/** Quelle einem Buch zuordnen. Idempotent (INSERT OR IGNORE) — der Picker darf
 *  eine bereits zugeordnete Quelle nicht mit 500 quittieren.
 *  @returns {boolean} true, wenn die Zuordnung neu war. */
function linkSource(bookId, sourceId, addedBy = null) {
  return _stmtLink.run(parseInt(bookId), parseInt(sourceId), addedBy).changes > 0;
}

/** Quelle aus EINEM Buch entfernen. Der Pool-Eintrag bleibt, ebenso die
 *  Zuordnungen in anderen Buechern.
 *
 *  Die Fundstellen dieses Buchs werden mit entfernt: sie sind Ableitung der
 *  Zuordnung, und der Buch-Guard in replacePageCitations wuerde sie beim
 *  naechsten Seiten-Write ohnehin nicht mehr schreiben. Blieben sie stehen,
 *  zaehlte das Verzeichnis eine Quelle mit, die dem Buch nicht mehr gehoert. */
const unlinkSource = db.transaction((bookId, sourceId) => {
  const bid = parseInt(bookId);
  const sid = parseInt(sourceId);
  db.prepare(`
    DELETE FROM source_citations
     WHERE source_id = ?
       AND page_id IN (SELECT page_id FROM pages WHERE book_id = ?)
  `).run(sid, bid);
  return _stmtUnlink.run(bid, sid).changes > 0;
});

function isSourceLinked(bookId, sourceId) {
  return !!_stmtIsLinked.get(parseInt(bookId), parseInt(sourceId));
}

/** Buecher, die diese Quelle nutzen. Grundlage der Loesch-Warnung („wird in
 *  3 Buechern verwendet") und des ACL-Fallbacks fuer Co-Autoren. */
function listSourceBooks(sourceId) {
  return _stmtSourceBooks.all(parseInt(sourceId));
}

module.exports = { linkSource, unlinkSource, isSourceLinked, listSourceBooks };
