'use strict';
// Gemeinsame Grundlage der Quellen-Module: Feld-Inventar, Normalisierung, die
// SQL-Fragmente der Kennzahlen und die Umrechnung DB-Zeile ↔ API-Form.
//
// Warum hier und nicht je Modul: TEXT_FIELDS speist INSERT, UPDATE, Spaltenliste
// UND Normalisierung — laufen die auseinander, verliert ein Schreibpfad still
// ein Feld. Dasselbe gilt fuer die beiden Kennzahl-Fragmente: Buch-Sicht und
// Pool-Sicht muessen dieselben vier Zahlen liefern, nur anders skopiert.

const { MAX_TEXT_CHARS } = require('../../lib/pdf-extract');

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

module.exports = {
  CSL_TYPES, TEXT_FIELDS, OTON_CHANNELS, OTON_AUTH,
  MAX_FIELD_LEN, MAX_NOTE_LEN, MAX_PERSONS,
  str: _str, normalizePersons,
  BOOK_COUNT_SQL: _BOOK_COUNT_SQL,
  POOL_COUNT_SQL: _POOL_COUNT_SQL,
  SOURCE_COLS: _SOURCE_COLS,
  rowToSource: _row,
  toColumnValues: _values,
};
