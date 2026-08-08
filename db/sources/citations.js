'use strict';
// Abgeleiteter Fund-Index `source_citations` („welche Quelle wird auf welcher
// Seite belegt") und die Zitat-Kennzahlen des Buchs.
//
// Wahrheit ist der Quellen-Marker im Seiten-HTML; diese Tabelle wird pro
// Seiten-Write komplett ersetzt und NIE inkrementell fortgeschrieben.

const { db } = require('../connection');

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

// Fundstellen EINER Quelle, mit Seiten-/Kapitelnamen zur Lesezeit (der Index
// selbst fuehrt keine Snapshot-Spalten). `bookId = null` heisst buchuebergreifend
// — die Route laesst das nur den Besitzer sehen, weil sich sonst aus einer
// geteilten Quelle die Seitennamen fremder Arbeiten ableiten liessen.
const _stmtCitesForSource = db.prepare(`
  SELECT sc.page_id, sc.count, sc.first_offset,
         p.page_name, p.position AS page_position, p.book_id,
         c.chapter_id, c.chapter_name
    FROM source_citations sc
    JOIN pages p         ON p.page_id = sc.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id
   WHERE sc.source_id = ? AND (? IS NULL OR p.book_id = ?)
   ORDER BY c.position, p.position, sc.first_offset
`);

function listSourceCitations(sourceId, bookId = null) {
  const bid = bookId ? parseInt(bookId) : null;
  return _stmtCitesForSource.all(parseInt(sourceId), bid, bid);
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

module.exports = {
  replacePageCitations, listBookCitations, listPageCitations, listSourceCitations,
  getBookQuoteStats,
};
