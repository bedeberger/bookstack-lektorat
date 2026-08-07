'use strict';
// Quellen als persoenliche Bibliothek: CRUD auf dem User-Pool `sources`, die
// M:N-Bruecke `book_source_links` (welches Buch nutzt welche Quelle) und die
// Schreib-/Lesepfade des abgeleiteten Fund-Index `source_citations`.
//
// Skopierung: die Quelle gehoert dem User (`owner_email`) — eine Literatur-
// bibliothek ist personen-, nicht werkgebunden. Ein Buch referenziert sie ueber
// die Bruecke; dieselbe Quelle liegt in beliebig vielen Buechern, ohne dass sie
// dort erneut erfasst wird.
//
// Daraus folgen zwei getrennte Operationen, die nicht verwechselt werden duerfen:
//   unlinkSource  entfernt die Quelle aus EINEM Buch (Bruecke), Pool bleibt
//   deleteSource  loescht sie aus der Bibliothek — und damit aus ALLEN Buechern
// Die Zugriffsregeln dazu liegen in routes/sources.js.
//
// authors/editors sind JSON-Arrays [{family, given} | {literal}] nach CSL-JSON.
// `literal` fuer Koerperschaften ("Bundesamt fuer Statistik"), die kein
// Vor-/Nachname-Paar haben. Normalisierung passiert hier, damit jeder Schreib-
// pfad (Formular, BibTeX-Import, DOI-Lookup) dieselbe Form ablegt.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { MAX_TEXT_CHARS } = require('../lib/pdf-extract');
const { normalizeUrl } = require('../lib/url-normalize');

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
  // O-Ton: vier Angaben, die eine Publikation nicht hat, eine Aussage aus einem
  // Gespraech aber braucht. Sie haengen am CSL-Typ `interview` — Rolle/Funktion
  // der sprechenden Person, Kanal des Gespraechs, Datum und der
  // Autorisierungsstand des Zitats. Letzterer ist der Grund fuer die Felder:
  // ein nicht freigegebenes Zitat darf nicht in den Druck.
  'oton_role', 'oton_channel', 'oton_date', 'oton_auth',
];

// Kanal des Gespraechs und Autorisierungsstand sind Enums, keine Freitexte —
// sonst kann die Karte nicht filtern und kein Badge zuverlaessig warnen.
// Deckungsgleich mit OTON_CHANNELS/OTON_AUTH in public/js/sources/fields.js.
const OTON_CHANNELS = ['persoenlich', 'telefon', 'video', 'mail', 'medienkonferenz', 'andere'];
const OTON_AUTH = ['keine', 'ausstehend', 'freigegeben', 'abgelehnt'];

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

// Zitier-Kennzahlen kommen mit der Liste (wie oft / auf wie vielen Seiten
// belegt). Ohne sie muesste die Karte pro Zeile nachfragen, und das Badge
// „nicht zitiert" ist der Hauptgrund, warum der Fund-Index existiert.
//
// Sie sind BUCH-skopiert: dieselbe Pool-Quelle ist in Arbeit A zwanzigmal und in
// Arbeit B gar nicht belegt. Eine globale Zahl waere in der Buchansicht falsch —
// die globale Sicht liefert getSourceTotals fuer die Loesch-Warnung.
const _BOOK_COUNT_SQL = `
  (SELECT COALESCE(SUM(sc.count), 0) FROM source_citations sc
     JOIN pages p ON p.page_id = sc.page_id
    WHERE sc.source_id = s.id AND p.book_id = @book) AS cite_count,
  (SELECT COUNT(*) FROM source_citations sc
     JOIN pages p ON p.page_id = sc.page_id
    WHERE sc.source_id = s.id AND p.book_id = @book) AS cite_pages,
  (SELECT COALESCE(SUM(sc.quote_chars), 0) FROM source_citations sc
     JOIN pages p ON p.page_id = sc.page_id
    WHERE sc.source_id = s.id AND p.book_id = @book) AS quote_chars,
  (SELECT COALESCE(SUM(sc.paraphrase_count), 0) FROM source_citations sc
     JOIN pages p ON p.page_id = sc.page_id
    WHERE sc.source_id = s.id AND p.book_id = @book) AS paraphrase_count
`;

// Pool-Sicht: ueber alle Buecher summiert, plus in wie vielen Buechern die
// Quelle liegt (die Zahl entscheidet, ob Loeschen woanders weh tut).
const _POOL_COUNT_SQL = `
  (SELECT COALESCE(SUM(sc.count), 0)            FROM source_citations sc WHERE sc.source_id = s.id) AS cite_count,
  (SELECT COUNT(*)                              FROM source_citations sc WHERE sc.source_id = s.id) AS cite_pages,
  (SELECT COALESCE(SUM(sc.quote_chars), 0)      FROM source_citations sc WHERE sc.source_id = s.id) AS quote_chars,
  (SELECT COALESCE(SUM(sc.paraphrase_count), 0) FROM source_citations sc WHERE sc.source_id = s.id) AS paraphrase_count,
  (SELECT COUNT(*) FROM book_source_links l WHERE l.source_id = s.id)                               AS book_count
`;

// Spaltenliste statt `s.*`: `doc` (bis 25 MB) und `doc_text` (bis 200k Zeichen)
// duerfen NIE in einer Listenabfrage mitkommen — eine Bibliothek mit 40
// angehaengten PDFs zoege sonst hunderte MB durch den Prozess, nur um pro Zeile
// ein Boolean und eine Seitenzahl anzuzeigen. Das Vorhandensein des BLOBs kommt
// als Flag aus SQLite, der Volltext gar nicht.
const _SOURCE_COLS = `
  s.id, s.owner_email, s.csl_type, s.authors, s.editors, s.archived,
  s.created_at, s.updated_at,
  ${TEXT_FIELDS.map(f => `s.${f}`).join(', ')},
  s.doc_mime, s.doc_name, s.doc_pages, s.doc_chars, s.doc_indexed_at, s.doc_content_hash,
  (s.doc IS NOT NULL) AS has_doc
`;

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

function _row(r) {
  if (!r) return null;
  const out = {
    id: r.id,
    owner_email: r.owner_email,
    csl_type: r.csl_type,
    authors: _persons(r.authors),
    editors: _persons(r.editors),
    archived: r.archived ? 1 : 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
    cite_count: r.cite_count || 0,
    cite_pages: r.cite_pages || 0,
    // Kennzahl-Seite: woertlich uebernommene Zeichen und wie viele der Nachweise
    // Paraphrasen sind. Beides im selben Scope wie cite_count (Buch bzw. Pool).
    quote_chars: r.quote_chars || 0,
    paraphrase_count: r.paraphrase_count || 0,
  };
  if (r.book_count !== undefined) out.book_count = r.book_count || 0;
  for (const f of TEXT_FIELDS) out[f] = r[f] || null;
  // PDF-Anhang: nur Metadaten. Weder BLOB noch Volltext verlassen die Tabelle
  // auf diesem Weg (s. _SOURCE_COLS) — das Original holt der Download-Endpunkt.
  // `doc_truncated` sagt, dass der Extraktor gedeckelt hat und der Index damit
  // nur den Anfang des Werks kennt.
  out.has_doc = !!r.has_doc;
  out.doc_name = r.doc_name || null;
  out.doc_pages = r.doc_pages ?? null;
  out.doc_chars = r.doc_chars ?? null;
  out.doc_indexed_at = r.doc_indexed_at || null;
  out.doc_truncated = (r.doc_chars ?? 0) >= MAX_TEXT_CHARS;
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
    text: TEXT_FIELDS.map(f => {
      const v = _str(pick(f, base?.[f]), f === 'note' ? MAX_NOTE_LEN : MAX_FIELD_LEN);
      // Enum-Felder auf die Allowlist klemmen statt den Request abzulehnen: ein
      // unbekannter Wert soll den Import einer Quelle nicht scheitern lassen,
      // aber auch nicht als Freitext im Badge landen.
      if (f === 'oton_channel') return OTON_CHANNELS.includes(v) ? v : null;
      if (f === 'oton_auth')    return OTON_AUTH.includes(v) ? v : null;
      return v;
    }),
  };
}

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

// ── Fund-Index source_citations ──────────────────────────────────────────────
// Wahrheit ist der Quellen-Marker im Seiten-HTML; diese Tabelle ist reine
// Ableitung und wird pro Seiten-Write komplett ersetzt (Muster
// page_figure_mentions). Nie inkrementell fortschreiben.

const _stmtDelCitesForPage = db.prepare('DELETE FROM source_citations WHERE page_id = ?');

// INSERT mit Buch-Guard im SELECT: eine Quelle wird nur indiziert, wenn sie dem
// Buch der Seite zugeordnet ist. Faengt zwei Faelle ab — „Seite mit Quellen-
// angaben in ein anderes Buch kopiert" und „Quelle aus dem Buch entfernt, Marker
// steht noch im Text". Beide duerfen keine Fundstelle erzeugen.
const _stmtInsCite = db.prepare(`
  INSERT INTO source_citations (source_id, page_id, count, first_offset, quote_chars, paraphrase_count)
  SELECT l.source_id, p.page_id, ?, ?, ?, ?
    FROM book_source_links l
    JOIN pages p ON p.page_id = ?
   WHERE l.source_id = ? AND l.book_id = p.book_id
`);

/** Fundstellen einer Seite komplett ersetzen.
 *  entries: [{ sourceId, count, firstOffset, quoteChars, paraphraseCount }] —
 *  Duplikate pro sourceId sind Aufrufer-Fehler; der PK wuerde sie ablehnen, darum
 *  vorher zusammengefasst (public/js/sources/cite-html.js#citationsFromCites).
 *  Gibt die Anzahl tatsaechlich indizierter Quellen zurueck (< entries.length,
 *  wenn eine id dem Buch nicht zugeordnet oder verschwunden ist). */
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
      Math.max(0, parseInt(e.quoteChars) || 0),
      Math.max(0, parseInt(e.paraphraseCount) || 0),
      pid, sid
    );
    written += info.changes;
  }
  return written;
});

const _stmtCitesForBook = db.prepare(`
  SELECT sc.source_id, sc.page_id, sc.count, sc.first_offset
    FROM source_citations sc
    JOIN pages p ON p.page_id = sc.page_id
   WHERE p.book_id = ?
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

// ── Zitat-Kennzahlen des Buchs ───────────────────────────────────────────────
// Der Zitat-Anteil ist eine Verhaeltniszahl: woertlich uebernommene Zeichen
// gegen die Zeichen des Manuskripts. Der Zaehler kommt aus dem Fund-Index, der
// Nenner aus `page_stats` — derselben Quelle, aus der auch die Buchstatistik
// ihre Zeichenzahl nimmt (siehe harte Regel „HTML→Text-Normalisierung fuer
// Stats"). Nur so ist der Prozentwert mit der angezeigten Zeichenzahl
// konsistent; ein eigener Scan ueber die Seiten-HTMLs waere ein zweites,
// abweichendes Mass.
//
// Seiten ohne page_stats-Zeile (nie synchronisiert) fehlen im Nenner. Darum
// liefert die Abfrage `stat_pages` mit: das Frontend kann den Anteil
// unterdruecken, solange noch nichts synchronisiert ist, statt eine zu hohe
// Quote zu zeigen.
const _stmtBookQuoteStats = db.prepare(`
  SELECT
    (SELECT COALESCE(SUM(sc.quote_chars), 0)      FROM source_citations sc
       JOIN pages p ON p.page_id = sc.page_id WHERE p.book_id = @book) AS quote_chars,
    (SELECT COALESCE(SUM(sc.count), 0)            FROM source_citations sc
       JOIN pages p ON p.page_id = sc.page_id WHERE p.book_id = @book) AS cite_count,
    (SELECT COALESCE(SUM(sc.paraphrase_count), 0) FROM source_citations sc
       JOIN pages p ON p.page_id = sc.page_id WHERE p.book_id = @book) AS paraphrase_count,
    (SELECT COUNT(DISTINCT sc.source_id)          FROM source_citations sc
       JOIN pages p ON p.page_id = sc.page_id WHERE p.book_id = @book) AS cited_sources,
    (SELECT COALESCE(SUM(ps.chars), 0) FROM page_stats ps WHERE ps.book_id = @book) AS total_chars,
    (SELECT COUNT(*)                   FROM page_stats ps WHERE ps.book_id = @book) AS stat_pages
`);

/** Zitat-Kennzahlen eines Buchs.
 *  @returns {{quote_chars:number, cite_count:number, paraphrase_count:number,
 *             direct_count:number, cited_sources:number, total_chars:number,
 *             stat_pages:number, quote_share:number|null}}
 *  `quote_share` ist der Anteil woertlich uebernommener Zeichen (0..1) oder null,
 *  wenn kein Nenner vorliegt. */
function getBookQuoteStats(bookId) {
  const bid = parseInt(bookId);
  const r = (Number.isInteger(bid) ? _stmtBookQuoteStats.get({ book: bid }) : null) || {};
  const quoteChars = r.quote_chars || 0;
  const totalChars = r.total_chars || 0;
  const citeCount = r.cite_count || 0;
  const paraphrase = r.paraphrase_count || 0;
  return {
    quote_chars: quoteChars,
    cite_count: citeCount,
    paraphrase_count: paraphrase,
    direct_count: Math.max(0, citeCount - paraphrase),
    cited_sources: r.cited_sources || 0,
    total_chars: totalChars,
    stat_pages: r.stat_pages || 0,
    quote_share: totalChars > 0 ? quoteChars / totalChars : null,
  };
}

// ── Laeufe der Quellen-Erkennung ─────────────────────────────────────────────
// Historie des Jobs `source-detect` (routes/jobs/source-detect.js). Ein Lauf
// liest das ganze Buch mit dem Modell — zu teuer, um sein Ergebnis mit dem
// naechsten Reload zu verlieren.
//
// Die Fundliste liegt als Ganzes in `result_json` und NICHT in Einzelzeilen:
// sie ist unbestaetigter Modell-Output, kein Katalog. Stammdatum wird ein Fund
// erst beim Uebernehmen (`sources` + `book_source_links`).
//
// Der Kapitelname wird NICHT mitgespeichert, sondern zur Lesezeit gejoint —
// benannt das Kapitel sich um, stimmt die Historie weiter. Ein geloeschtes
// Kapitel nullt den FK; `scope` bleibt 'chapter', sodass der Lauf als
// „Kapitel-Lauf ohne Kapitel" erkennbar bleibt statt als Buch-Lauf zu gelten.

const _stmtInsertDetectRun = db.prepare(`
  INSERT INTO source_detect_runs
    (book_id, user_email, scope, scope_chapter_id, created_at, found_count, verified_count, result_json, model)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL}, ?, ?, ?, ?)
`);
// Ohne result_json: die Liste zeigt nur Kopfzeilen, das Ergebnis kommt beim
// Oeffnen. Ein Lauf ueber ein grosses Buch traegt hunderte Kilobyte JSON.
const _stmtListDetectRuns = db.prepare(`
  SELECT r.id, r.book_id, r.user_email, r.scope, r.scope_chapter_id,
         r.created_at, r.found_count, r.verified_count, r.model,
         c.chapter_name AS scope_chapter_name
    FROM source_detect_runs r
    LEFT JOIN chapters c ON c.chapter_id = r.scope_chapter_id
   WHERE r.book_id = ? AND r.user_email = ?
   ORDER BY r.created_at DESC, r.id DESC
`);
const _stmtGetDetectRun = db.prepare(`
  SELECT r.*, c.chapter_name AS scope_chapter_name
    FROM source_detect_runs r
    LEFT JOIN chapters c ON c.chapter_id = r.scope_chapter_id
   WHERE r.id = ?
`);
const _stmtDeleteDetectRun = db.prepare(
  'DELETE FROM source_detect_runs WHERE id = ? AND user_email = ?'
);
// Aufbewahrung pro Buch + User. Aeltere Laeufe fallen weg — sie beschreiben
// einen Textstand, den es nicht mehr gibt, und die Liste soll nicht wachsen,
// bis niemand sie mehr liest.
const DETECT_RUN_KEEP = 10;
const _stmtTrimDetectRuns = db.prepare(`
  DELETE FROM source_detect_runs
   WHERE book_id = ? AND user_email = ?
     AND id NOT IN (
       SELECT id FROM source_detect_runs
        WHERE book_id = ? AND user_email = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
     )
`);

const insertDetectRun = db.transaction(({
  bookId, userEmail, scope = 'book', scopeChapterId = null,
  foundCount = 0, verifiedCount = 0, result, model = null,
}) => {
  const chapterId = scope === 'chapter' && scopeChapterId != null ? parseInt(scopeChapterId) : null;
  const info = _stmtInsertDetectRun.run(
    parseInt(bookId), userEmail, scope === 'chapter' ? 'chapter' : 'book', chapterId,
    parseInt(foundCount) || 0, parseInt(verifiedCount) || 0, JSON.stringify(result), model,
  );
  _stmtTrimDetectRuns.run(parseInt(bookId), userEmail, parseInt(bookId), userEmail, DETECT_RUN_KEEP);
  return info.lastInsertRowid;
});

function listDetectRuns(bookId, userEmail) {
  return _stmtListDetectRuns.all(parseInt(bookId), userEmail);
}

function getDetectRun(id) {
  const r = _stmtGetDetectRun.get(parseInt(id));
  if (!r) return null;
  let result = null;
  try { result = JSON.parse(r.result_json); } catch { result = null; }
  return {
    id: r.id, book_id: r.book_id, user_email: r.user_email,
    scope: r.scope, scope_chapter_id: r.scope_chapter_id,
    scope_chapter_name: r.scope_chapter_name || null,
    created_at: r.created_at, found_count: r.found_count,
    verified_count: r.verified_count, model: r.model,
    result,
  };
}

function deleteDetectRun(id, userEmail) {
  return _stmtDeleteDetectRun.run(parseInt(id), userEmail).changes;
}

// ── Quellen-PDF (User-Pool) ─────────────────────────────────────────────────
// Original-PDF als BLOB an der Quelle + extrahierter Plain-Text (`doc_text`)
// für FTS + semantische Suche. Anlegen/Aendern/Loeschen darf nur der Besitzer
// (Pool-Hoheit) — s. _isOwner in routes/sources.js. Lesen (Download) ab
// Buch-Viewer, sobald die Quelle einem Buch des Users zugeordnet ist, dessen
// Chip im Text dann aufloesbar bleibt (vgl. _canRead).
//
// Drei Lesepfade, bewusst getrennt nach Kosten:
//   getSourceDocMeta  Metadaten OHNE BLOB — fuer ACL-Entscheidung und Anzeige
//   getSourceDocBlob  das Original, erst NACH bestandener ACL
//   getSourceDocText  der Volltext, nur fuer den Index-Job

const _stmtSetDoc = db.prepare(`
  UPDATE sources
     SET doc = ?, doc_mime = ?, doc_name = ?, doc_text = ?, doc_pages = ?, doc_chars = ?,
         doc_content_hash = ?, doc_indexed_at = NULL, updated_at = ${NOW_ISO_SQL}
   WHERE id = ?
`);
const _stmtClearDoc = db.prepare(`
  UPDATE sources
     SET doc = NULL, doc_mime = NULL, doc_name = NULL, doc_text = NULL, doc_pages = NULL,
         doc_chars = NULL, doc_content_hash = NULL, doc_indexed_at = NULL,
         updated_at = ${NOW_ISO_SQL}
   WHERE id = ?
`);
// Ohne `doc`: diese Zeile entscheidet nur, OB ausgeliefert werden darf.
const _stmtDocMeta = db.prepare(
  `SELECT id, owner_email, doc_mime, doc_name, doc_pages, doc_chars,
          doc_content_hash, doc_indexed_at, (doc IS NOT NULL) AS has_doc
     FROM sources WHERE id = ?`
);
const _stmtDocBlob = db.prepare('SELECT doc FROM sources WHERE id = ?');
const _stmtDocText = db.prepare('SELECT doc_text FROM sources WHERE id = ?');
// `updated_at` bleibt bewusst stehen: der Index-Lauf ist keine inhaltliche
// Aenderung der Quelle, und `doc_indexed_at < updated_at` ist genau das
// Stale-Signal (s. db/source-semantic-chunks.js#indexStatus). Wuerde der
// Index-Lauf updated_at anfassen, koennte die Quelle nie stale werden.
const _stmtMarkIndexed = db.prepare(
  'UPDATE sources SET doc_indexed_at = ? WHERE id = ?'
);
function markSourceIndexed(sourceId, isoAt) {
  _stmtMarkIndexed.run(isoAt, sourceId);
}

/** PDF anhaengen/ersetzen. Setzt `doc_indexed_at` zurueck — der neue Volltext
 *  ist bis zum naechsten Index-Lauf nicht semantisch auffindbar, und die Karte
 *  soll das ehrlich anzeigen statt den Stand des Vorgaengers zu behaupten. */
function setSourceDoc(id, { mime, name, text, pages, chars, hash, buffer }) {
  _stmtSetDoc.run(
    buffer || null, mime || 'application/pdf', name || null, text || null,
    pages || null, chars ?? (text ? text.length : null), hash || null, id,
  );
}
function clearSourceDoc(id) { _stmtClearDoc.run(id); }
function getSourceDocMeta(id) { return _stmtDocMeta.get(id) || null; }
function getSourceDocBlob(id) { return _stmtDocBlob.get(id)?.doc || null; }
function getSourceDocText(id) { return _stmtDocText.get(id)?.doc_text || ''; }

module.exports = {
  OTON_CHANNELS, OTON_AUTH,
  CSL_TYPES, TEXT_FIELDS,
  normalizePersons,
  listSources, listPoolSources, getSource, countSources, findSourceByUrl,
  createSource, updateSource, deleteSource,
  linkSource, unlinkSource, isSourceLinked, listSourceBooks,
  replacePageCitations, listBookCitations, listPageCitations,
  getBookQuoteStats,
  DETECT_RUN_KEEP,
  insertDetectRun, listDetectRuns, getDetectRun, deleteDetectRun,
  setSourceDoc, clearSourceDoc, markSourceIndexed,
  getSourceDocMeta, getSourceDocBlob, getSourceDocText,
};
