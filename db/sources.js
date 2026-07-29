'use strict';
// CRUD fuer book_sources (Quellenverzeichnis) + Schreib-/Lesepfade des
// abgeleiteten Fund-Index source_citations.
//
// Skopierung: buchweit GETEILT. `user_email` ist Ersteller-Attribution, kein
// Sichtbarkeits-Scope — der Quellen-Marker lebt im Seiten-HTML und ist damit fuer
// jeden Editor des Buchs sichtbar; eine user-private Quelle waere fuer einen
// Co-Autor eine Quellenangabe ohne Ziel. Zugriffsschutz liegt beim ACL-Guard der Route.
//
// authors/editors sind JSON-Arrays [{family, given} | {literal}] nach CSL-JSON.
// `literal` fuer Koerperschaften ("Bundesamt fuer Statistik"), die kein
// Vor-/Nachname-Paar haben. Normalisierung passiert hier, damit jeder Schreib-
// pfad (Formular, BibTeX-Import, DOI-Lookup) dieselbe Form ablegt.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const CSL_TYPES = [
  'book', 'chapter', 'article', 'website', 'thesis',
  'report', 'legal', 'interview', 'film', 'dataset', 'other',
];

// Freitext-Felder der Quelle in stabiler Reihenfolge — geteilt von INSERT,
// UPDATE und der Normalisierung, damit die drei nicht auseinanderlaufen.
const TEXT_FIELDS = [
  'citekey', 'title', 'container_title', 'publisher', 'place', 'year',
  'edition', 'volume', 'issue', 'pages', 'doi', 'isbn', 'issn', 'url',
  'accessed_at', 'note',
];

const MAX_FIELD_LEN = 500;
const MAX_NOTE_LEN = 4000;
const MAX_PERSONS = 50;

function _str(v, max = MAX_FIELD_LEN) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

// Ein Personen-Array in CSL-Form bringen. Akzeptiert {family,given}, {literal}
// und blosse Strings ("Hans Müller" → literal, weil eine Heuristik auf
// Namensteile bei Doppelnamen und Adelspraefixen zu oft falsch raet).
function normalizePersons(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const raw of v.slice(0, MAX_PERSONS)) {
    if (typeof raw === 'string') {
      const literal = _str(raw, 200);
      if (literal) out.push({ literal });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const family = _str(raw.family, 200);
    const given = _str(raw.given, 200);
    if (family) {
      out.push(given ? { family, given } : { family });
      continue;
    }
    const literal = _str(raw.literal, 200);
    if (literal) out.push({ literal });
  }
  return out;
}

function _persons(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Die Liste liefert die Zitier-Kennzahlen mit (wie oft / auf wie vielen Seiten
// belegt). Ohne sie muesste die Karte pro Zeile nachfragen, und das Badge
// „nicht zitiert" ist der Hauptgrund, warum der Fund-Index existiert.
const _SELECT_SQL = `
  SELECT s.*,
         (SELECT COALESCE(SUM(sc.count), 0) FROM source_citations sc WHERE sc.source_id = s.id) AS cite_count,
         (SELECT COUNT(*)                   FROM source_citations sc WHERE sc.source_id = s.id) AS cite_pages
    FROM book_sources s
`;

const _stmtList = db.prepare(
  `${_SELECT_SQL} WHERE s.book_id = ? ORDER BY s.updated_at DESC, s.id DESC`
);
const _stmtListActive = db.prepare(
  `${_SELECT_SQL} WHERE s.book_id = ? AND s.archived = 0 ORDER BY s.updated_at DESC, s.id DESC`
);
const _stmtGet = db.prepare(`${_SELECT_SQL} WHERE s.id = ?`);
const _stmtDelete = db.prepare('DELETE FROM book_sources WHERE id = ?');
const _stmtCount = db.prepare('SELECT COUNT(*) AS n FROM book_sources WHERE book_id = ?');

const _stmtInsert = db.prepare(`
  INSERT INTO book_sources
    (book_id, user_email, csl_type, authors, editors, archived,
     ${TEXT_FIELDS.join(', ')}, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ${TEXT_FIELDS.map(() => '?').join(', ')}, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);

const _stmtUpdate = db.prepare(`
  UPDATE book_sources
     SET csl_type = ?, authors = ?, editors = ?, archived = ?,
         ${TEXT_FIELDS.map(f => `${f} = ?`).join(', ')},
         updated_at = ${NOW_ISO_SQL}
   WHERE id = ?
`);

function _row(r) {
  if (!r) return null;
  const out = {
    id: r.id,
    book_id: r.book_id,
    user_email: r.user_email,
    csl_type: r.csl_type,
    authors: _persons(r.authors),
    editors: _persons(r.editors),
    archived: r.archived ? 1 : 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
    cite_count: r.cite_count || 0,
    cite_pages: r.cite_pages || 0,
  };
  for (const f of TEXT_FIELDS) out[f] = r[f] || null;
  return out;
}

// Ein Eingabe-Objekt auf die Spaltenwerte abbilden. `base` liefert die Vorwerte
// bei PATCH-artigem Update (nur uebergebene Felder aendern sich).
function _values(src, base = null) {
  const pick = (key, fallback) => (src[key] !== undefined ? src[key] : fallback);
  const cslType = _str(pick('csl_type', base?.csl_type)) || 'book';
  return {
    csl_type: CSL_TYPES.includes(cslType) ? cslType : 'book',
    authors: JSON.stringify(normalizePersons(pick('authors', base?.authors) || [])),
    editors: JSON.stringify(normalizePersons(pick('editors', base?.editors) || [])),
    archived: pick('archived', base?.archived) ? 1 : 0,
    text: TEXT_FIELDS.map(f => _str(pick(f, base?.[f]), f === 'note' ? MAX_NOTE_LEN : MAX_FIELD_LEN)),
  };
}

function listSources(bookId, { includeArchived = false } = {}) {
  const stmt = includeArchived ? _stmtList : _stmtListActive;
  return stmt.all(parseInt(bookId)).map(_row);
}

function getSource(id) {
  return _row(_stmtGet.get(parseInt(id)));
}

function countSources(bookId) {
  return _stmtCount.get(parseInt(bookId)).n;
}

function createSource(bookId, userEmail, fields = {}) {
  const v = _values(fields);
  const info = _stmtInsert.run(
    parseInt(bookId), userEmail, v.csl_type, v.authors, v.editors, v.archived, ...v.text
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

function deleteSource(id) {
  _stmtDelete.run(parseInt(id));
}

// ── Fund-Index source_citations ──────────────────────────────────────────────
// Wahrheit ist der Quellen-Marker im Seiten-HTML; diese Tabelle ist reine
// Ableitung und wird pro Seiten-Write komplett ersetzt (Muster
// page_figure_mentions). Nie inkrementell fortschreiben.

const _stmtDelCitesForPage = db.prepare('DELETE FROM source_citations WHERE page_id = ?');

// INSERT mit Buch-Guard im SELECT: eine Quelle wird nur indiziert, wenn sie zum
// Buch der Seite gehoert. Faengt den Fall „Seite mit Quellenangaben in ein anderes Buch
// kopiert" ab — der Marker zeigt dann auf eine buchfremde id und darf keine
// Fundstelle erzeugen.
const _stmtInsCite = db.prepare(`
  INSERT INTO source_citations (source_id, page_id, count, first_offset)
  SELECT s.id, p.page_id, ?, ?
    FROM book_sources s
    JOIN pages p ON p.page_id = ?
   WHERE s.id = ? AND s.book_id = p.book_id
`);

/** Fundstellen einer Seite komplett ersetzen.
 *  entries: [{ sourceId, count, firstOffset }] — Duplikate pro sourceId sind
 *  Aufrufer-Fehler; der PK wuerde sie ablehnen, darum vorher zusammengefasst.
 *  Gibt die Anzahl tatsaechlich indizierter Quellen zurueck (< entries.length,
 *  wenn eine id buchfremd oder verschwunden ist). */
const replacePageCitations = db.transaction((pageId, entries = []) => {
  const pid = parseInt(pageId);
  _stmtDelCitesForPage.run(pid);
  let written = 0;
  const seen = new Set();
  for (const e of entries) {
    const sid = parseInt(e?.sourceId);
    if (!Number.isInteger(sid) || seen.has(sid)) continue;
    seen.add(sid);
    const info = _stmtInsCite.run(
      Math.max(0, parseInt(e.count) || 0),
      e.firstOffset == null ? null : parseInt(e.firstOffset),
      pid, sid
    );
    written += info.changes;
  }
  return written;
});

const _stmtCitesForBook = db.prepare(`
  SELECT sc.source_id, sc.page_id, sc.count, sc.first_offset
    FROM source_citations sc
    JOIN book_sources s ON s.id = sc.source_id
    JOIN pages p        ON p.page_id = sc.page_id
   WHERE s.book_id = ?
   ORDER BY p.position, sc.first_offset
`);

/** Alle Fundstellen eines Buchs in Buch-Leserichtung (Seitenposition, dann
 *  Offset). Der numerische Zitierstil vergibt seine Nummern nach Erstzitat —
 *  dafuer ist genau diese Reihenfolge die Grundlage. */
function listBookCitations(bookId) {
  return _stmtCitesForBook.all(parseInt(bookId));
}

const _stmtCitesForPage = db.prepare(`
  SELECT source_id, page_id, count, first_offset
    FROM source_citations
   WHERE page_id = ?
   ORDER BY first_offset
`);

/** Fundstellen einer einzelnen Seite — Grundlage des Verzeichnisses bei
 *  Blog-/HubSpot-Push, wo die gerenderte Einheit die Seite ist (ein Post). */
function listPageCitations(pageId) {
  return _stmtCitesForPage.all(parseInt(pageId));
}

module.exports = {
  CSL_TYPES, TEXT_FIELDS,
  normalizePersons,
  listSources, getSource, countSources,
  createSource, updateSource, deleteSource,
  replacePageCitations, listBookCitations, listPageCitations,
};
