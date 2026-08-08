'use strict';
// Die Bibliothek selbst: Lesen, Anlegen, Aendern, Loeschen im User-Pool
// `sources` — plus die drei Dublettenfragen, die vor einem Schreibpfad stehen
// (BibTeX-Import, Erfassen aus dem Browser, Recherche-Uebernahme).
//
// `deleteSource` wirkt in ALLEN Buechern; „nur aus diesem Buch" ist
// `unlinkSource` in ./links.js. Die Zugriffsregeln liegen in routes/sources.js.

const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');
const { normalizeUrl } = require('../../lib/url-normalize');
const {
  TEXT_FIELDS,
  BOOK_COUNT_SQL: _BOOK_COUNT_SQL,
  POOL_COUNT_SQL: _POOL_COUNT_SQL,
  SOURCE_COLS: _SOURCE_COLS,
  rowToSource: _row,
  toColumnValues: _values,
} = require('./shared');

const _stmtListForBook = db.prepare(`
  SELECT ${_SOURCE_COLS}, ${_BOOK_COUNT_SQL}
    FROM sources s
    JOIN book_source_links l ON l.source_id = s.id AND l.book_id = @book
   ORDER BY s.updated_at DESC, s.id DESC
`);
const _stmtListForBookActive = db.prepare(`
  SELECT ${_SOURCE_COLS}, ${_BOOK_COUNT_SQL}
    FROM sources s
    JOIN book_source_links l ON l.source_id = s.id AND l.book_id = @book
   WHERE s.archived = 0
   ORDER BY s.updated_at DESC, s.id DESC
`);

// Pool des Users. `exclude_book` blendet aus, was im Zielbuch schon liegt —
// der „aus Bibliothek hinzufuegen"-Picker soll keine Zeilen zeigen, deren
// Auswahl nichts tut.
const _stmtPool = db.prepare(`
  SELECT ${_SOURCE_COLS}, ${_POOL_COUNT_SQL}
    FROM sources s
   WHERE s.owner_email = @owner
     AND (@include_archived = 1 OR s.archived = 0)
     AND (@exclude_book IS NULL
          OR NOT EXISTS (SELECT 1 FROM book_source_links l
                          WHERE l.source_id = s.id AND l.book_id = @exclude_book))
   ORDER BY s.updated_at DESC, s.id DESC
`);

const _stmtGetPool = db.prepare(`SELECT ${_SOURCE_COLS}, ${_POOL_COUNT_SQL} FROM sources s WHERE s.id = @id`);
const _stmtGetForBook = db.prepare(`SELECT ${_SOURCE_COLS}, ${_BOOK_COUNT_SQL} FROM sources s WHERE s.id = @id`);

const _stmtDelete = db.prepare('DELETE FROM sources WHERE id = ?');
const _stmtCount = db.prepare(
  'SELECT COUNT(*) AS n FROM book_source_links WHERE book_id = ?'
);

const _stmtInsert = db.prepare(`
  INSERT INTO sources
    (owner_email, csl_type, authors, editors, archived,
     ${TEXT_FIELDS.join(', ')}, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ${TEXT_FIELDS.map(() => '?').join(', ')}, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);

const _stmtUpdate = db.prepare(`
  UPDATE sources
     SET csl_type = ?, authors = ?, editors = ?, archived = ?,
         ${TEXT_FIELDS.map(f => `${f} = ?`).join(', ')},
         updated_at = ${NOW_ISO_SQL}
   WHERE id = ?
`);

/** Quellen, die einem Buch zugeordnet sind. Kennzahlen buch-skopiert. */
function listSources(bookId, { includeArchived = false } = {}) {
  const stmt = includeArchived ? _stmtListForBook : _stmtListForBookActive;
  return stmt.all({ book: parseInt(bookId) }).map(_row);
}

/** Die persoenliche Bibliothek eines Users. Kennzahlen ueber alle Buecher. */
function listPoolSources(ownerEmail, { includeArchived = false, excludeBookId = null } = {}) {
  const excl = excludeBookId == null ? null : parseInt(excludeBookId);
  return _stmtPool.all({
    owner: ownerEmail,
    include_archived: includeArchived ? 1 : 0,
    exclude_book: Number.isInteger(excl) ? excl : null,
  }).map(_row);
}

/** Eine Quelle. Ohne `bookId` mit Pool-Kennzahlen (inkl. `book_count`), mit
 *  `bookId` mit den Kennzahlen dieses Buchs — dieselbe Sicht wie in der Liste. */
function getSource(id, bookId = null) {
  const sid = parseInt(id);
  if (bookId == null) return _row(_stmtGetPool.get({ id: sid }));
  return _row(_stmtGetForBook.get({ id: sid, book: parseInt(bookId) }));
}

/** Anzahl der einem Buch zugeordneten Quellen (inkl. archivierter). */
function countSources(bookId) {
  return _stmtCount.get(parseInt(bookId)).n;
}

// Dublettensuche des BibTeX-/RIS-Imports. Zwei Wege, weil der Zitierschluessel
// die verlaessliche Kennung ist, RIS-Exporte ihn aber oft nicht mitbringen:
// dann entscheiden Gattung + Titel + Jahr. Zwei Werke gleicher Gattung mit
// identischem Titel UND Jahr in EINER Bibliothek sind praktisch immer dasselbe.
const _stmtFindByCitekey = db.prepare(
  'SELECT id FROM sources WHERE owner_email = ? AND citekey = ? LIMIT 1'
);
const _stmtFindByTitleYear = db.prepare(`
  SELECT id FROM sources
   WHERE owner_email = ? AND csl_type = ?
     AND title IS NOT NULL AND LOWER(title) = LOWER(?)
     AND COALESCE(year, '') = COALESCE(?, '')
   LIMIT 1
`);

/** Vorhandene Quelle zu einem Import-Eintrag (oder null). Nur eine Abkuerzung —
 *  die Wahrheit ist der UNIQUE-Index, den der Aufrufer abfangen muss. */
function findImportDuplicate(ownerEmail, entry) {
  if (entry.citekey) return _stmtFindByCitekey.get(ownerEmail, entry.citekey) || null;
  if (!entry.title) return null;
  return _stmtFindByTitleYear.get(ownerEmail, entry.csl_type, entry.title, entry.year) || null;
}

const _stmtFindByUrlOrTitle = db.prepare(`
  SELECT id FROM sources
   WHERE owner_email = ?
     AND ((? IS NOT NULL AND url = ?) OR (? IS NOT NULL AND title = ?))
   LIMIT 1
`);

/** Aehnliche Quelle im Pool (gleiche URL ODER gleicher Titel) — reines
 *  Log-Signal fuer die Recherche-Uebernahme, die bewusst NICHT idempotent ist. */
function findSimilarSource(ownerEmail, { url = null, title = null } = {}) {
  return _stmtFindByUrlOrTitle.get(ownerEmail, url, url, title, title) || null;
}

const _stmtPoolUrls = db.prepare(
  `SELECT id, url FROM sources
    WHERE owner_email = ? AND url IS NOT NULL AND TRIM(url) != ''
    ORDER BY id`
);

/** Erste Quelle der Bibliothek, deren `url` dasselbe Dokument bezeichnet wie
 *  `rawUrl` — Grundlage der Dublettenpruefung beim Erfassen aus dem Browser.
 *  Ohne `bookId` mit Pool-Kennzahlen, mit `bookId` buch-skopiert (wie getSource).
 *
 *  Verglichen wird NORMALISIERT (lib/url-normalize), und zwar in JS statt per
 *  SQL-Vergleich auf der Rohspalte: `https://www.x.org/a/?utm_source=…` und
 *  `http://x.org/a` sind dasselbe Dokument, fuer SQLite aber zwei Strings.
 *  Dieselbe Begruendung wie beim Freitextfilter in routes/sources.js — eine
 *  persoenliche Literaturbibliothek hat zwei- bis dreistellig viele Eintraege;
 *  ein abgeleiteter `url_norm`-Spiegel waere ein Wert, der bei jedem Schreibpfad
 *  mitgepflegt werden muesste, und genau dort driftet er dann weg. */
function findSourceByUrl(ownerEmail, rawUrl, bookId = null) {
  const target = normalizeUrl(rawUrl);
  if (!ownerEmail || !target) return null;
  for (const row of _stmtPoolUrls.all(ownerEmail)) {
    if (normalizeUrl(row.url) === target) return getSource(row.id, bookId);
  }
  return null;
}

/** Neue Quelle im Pool des Users. Die Buch-Zuordnung ist ein eigener Schritt
 *  (linkSource) — eine Quelle kann ohne Buch in der Bibliothek liegen. */
function createSource(ownerEmail, fields = {}) {
  const v = _values(fields);
  const info = _stmtInsert.run(
    ownerEmail, v.csl_type, v.authors, v.editors, v.archived, ...v.text
  );
  return getSource(info.lastInsertRowid);
}

function updateSource(id, fields = {}) {
  const base = getSource(id);
  if (!base) return null;
  const v = _values(fields, base);
  _stmtUpdate.run(v.csl_type, v.authors, v.editors, v.archived, ...v.text, parseInt(id));
  return getSource(id);
}

/** Aus der Bibliothek loeschen — wirkt in ALLEN Buechern. Bruecken-Zeilen und
 *  Fundstellen verschwinden per CASCADE. Fuer „nur hier weg" ist unlinkSource
 *  zustaendig. */
function deleteSource(id) {
  _stmtDelete.run(parseInt(id));
}

module.exports = {
  listSources, listPoolSources, getSource, countSources,
  findSourceByUrl, findImportDuplicate, findSimilarSource,
  createSource, updateSource, deleteSource,
};
