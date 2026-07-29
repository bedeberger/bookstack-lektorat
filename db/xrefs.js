'use strict';
// Schreib-/Lesepfade der abgeleiteten Querverweis-Indexe `xref_anchors`
// (nummerierbare Ziele im HTML) und `xref_links` (die Verweise selbst).
//
// WAHRHEIT IST DER MARKER IM SEITEN-HTML. Beide Tabellen sind reine Ableitung,
// jederzeit neu berechenbar, und werden pro Seiten-Write komplett ersetzt
// (Muster source_citations / page_figure_mentions). Nie inkrementell
// fortschreiben.
//
// WOFUER DIE TABELLEN DA SIND — und wofuer nicht:
//   JA:   Ziel-Picker im Editor („welche Abbildungen gibt es im Buch?"),
//         Rueckwaertsfrage („wer verweist auf dieses Kapitel?"), Aufspueren
//         verwaister Verweise.
//   NEIN: die Nummern beim Rendern. Die baut lib/xref-render.js aus dem HTML,
//         das es gerade rendert — passend zum Scope (Buch/Kapitel/Seite) und
//         unabhaengig davon, ob der Index gerade frisch ist.

const { db } = require('./schema');

// ── xref_anchors ─────────────────────────────────────────────────────────────

const _stmtDelAnchors = db.prepare('DELETE FROM xref_anchors WHERE page_id = ?');
const _stmtInsAnchor = db.prepare(`
  INSERT INTO xref_anchors (page_id, kind, bid, ord, caption)
  VALUES (?, ?, ?, ?, ?)
`);

/** Anker einer Seite komplett ersetzen.
 *  anchors: [{ kind, bid, ord, caption }] — Duplikate pro (kind,bid) sind
 *  Aufrufer-Fehler; der PK wuerde sie ablehnen, darum vorher entdoppelt.
 *  @returns {number} Anzahl geschriebener Anker. */
const replacePageAnchors = db.transaction((pageId, anchors = []) => {
  const pid = parseInt(pageId);
  _stmtDelAnchors.run(pid);
  let written = 0;
  const seen = new Set();
  for (const a of anchors) {
    const bid = String(a?.bid || '').trim().toLowerCase();
    const kind = String(a?.kind || '');
    if (!bid || kind !== 'figure') continue;
    const key = `${kind}:${bid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    _stmtInsAnchor.run(pid, kind, bid, parseInt(a.ord) || 0, a.caption == null ? null : String(a.caption));
    written++;
  }
  return written;
});

const _stmtAnchorsForBook = db.prepare(`
  SELECT a.bid, a.kind, a.caption, a.ord, a.page_id, p.chapter_id, p.page_name
    FROM xref_anchors a
    JOIN pages p ON p.page_id = a.page_id
   WHERE p.book_id = ?
   ORDER BY p.position, a.ord
`);

/** Alle Anker eines Buchs in Buch-Leserichtung (Seitenposition, dann Position
 *  innerhalb der Seite) — dieselbe Ordnung, die listBookCitations fuer die
 *  Erstzitat-Nummern benutzt.
 *
 *  Kollidieren zwei `data-bid` buchweit (astronomisch unwahrscheinlich, siehe
 *  public/js/xrefs/xref-anchor.js), gewinnt der erste in dieser Reihenfolge —
 *  deterministisch statt zufaellig. */
function listBookAnchors(bookId) {
  const rows = _stmtAnchorsForBook.all(parseInt(bookId));
  const seen = new Set();
  return rows.filter(r => (seen.has(r.bid) ? false : (seen.add(r.bid), true)));
}

// ── xref_links ───────────────────────────────────────────────────────────────

const _stmtDelLinks = db.prepare('DELETE FROM xref_links WHERE page_id = ?');

// Kapitel-Verweis mit Buch-Guard im SELECT — dieselbe Mechanik wie der
// Quellen-Guard in db/sources.js#replacePageCitations. Ein Verweis wird nur
// indiziert, wenn das Zielkapitel im selben Buch liegt wie die verweisende
// Seite. Faengt zwei Faelle: „Seite mit Verweisen in ein anderes Buch kopiert"
// und „Zielkapitel geloescht, Marker steht noch im Text". Beide duerfen keine
// Index-Zeile erzeugen — der Marker bleibt trotzdem stehen (er gehoert dem
// Autor), er ist dann eben ein verwaister Verweis.
const _stmtInsChapterLink = db.prepare(`
  INSERT INTO xref_links (page_id, kind, chapter_id, anchor_bid, count, first_offset)
  SELECT p.page_id, 'chapter', c.chapter_id, NULL, ?, ?
    FROM pages p
    JOIN chapters c ON c.chapter_id = ?
   WHERE p.page_id = ? AND c.book_id = p.book_id
`);

// Abbildungs-Verweis mit Buch-Guard ueber den Anker: das Ziel muss als Anker
// einer Seite DESSELBEN Buchs indiziert sein.
//
// Daraus folgt eine Reihenfolge-Abhaengigkeit — zeigt Seite A auf eine
// Abbildung der noch nie gespeicherten Seite B, entsteht zunaechst keine Zeile.
// Das ist hingenommen: der Index ist eine Bequemlichkeit fuer die Oberflaeche,
// nicht die Aufloesung. Sobald B einmal gespeichert wurde, zieht der naechste
// Write von A nach. Die Alternative (FK-loser Blind-Insert) wuerde Zeilen auf
// Ziele erzeugen, die es nie gab.
const _stmtInsFigureLink = db.prepare(`
  INSERT INTO xref_links (page_id, kind, chapter_id, anchor_bid, count, first_offset)
  SELECT p.page_id, 'figure', NULL, ?, ?, ?
    FROM pages p
   WHERE p.page_id = ?
     AND EXISTS (
       SELECT 1 FROM xref_anchors a
         JOIN pages tp ON tp.page_id = a.page_id
        WHERE a.bid = ? AND tp.book_id = p.book_id
     )
`);

/** Verweise einer Seite komplett ersetzen.
 *  links: [{ kind, target, count, firstOffset }] — `target` ist die chapter_id
 *  (kind='chapter') bzw. das data-bid (kind='figure').
 *  @returns {number} Anzahl tatsaechlich indizierter Verweise (< links.length,
 *  wenn ein Ziel dem Buch nicht gehoert oder verschwunden ist). */
const replacePageXrefs = db.transaction((pageId, links = []) => {
  const pid = parseInt(pageId);
  _stmtDelLinks.run(pid);
  let written = 0;
  const seen = new Set();
  for (const l of links) {
    const kind = String(l?.kind || '');
    const target = String(l?.target ?? '').trim();
    if (!target) continue;
    const key = `${kind}:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const count = Math.max(0, parseInt(l.count) || 0);
    const off = l.firstOffset == null ? null : parseInt(l.firstOffset);

    if (kind === 'chapter') {
      const cid = parseInt(target);
      if (!Number.isInteger(cid)) continue;
      written += _stmtInsChapterLink.run(count, off, cid, pid).changes;
    } else if (kind === 'figure') {
      const bid = target.toLowerCase();
      written += _stmtInsFigureLink.run(bid, count, off, pid, bid).changes;
    }
  }
  return written;
});

const _stmtLinksForPage = db.prepare(`
  SELECT kind, chapter_id, anchor_bid, count, first_offset
    FROM xref_links
   WHERE page_id = ?
   ORDER BY first_offset
`);

/** Verweise einer Seite (was zeigt von hier weg). */
function listPageXrefs(pageId) {
  return _stmtLinksForPage.all(parseInt(pageId));
}

const _stmtBacklinksChapter = db.prepare(`
  SELECT l.page_id, l.count, l.first_offset, p.page_name, p.chapter_id
    FROM xref_links l
    JOIN pages p ON p.page_id = l.page_id
   WHERE l.kind = 'chapter' AND l.chapter_id = ?
   ORDER BY p.position, l.first_offset
`);

const _stmtBacklinksAnchor = db.prepare(`
  SELECT l.page_id, l.count, l.first_offset, p.page_name, p.chapter_id
    FROM xref_links l
    JOIN pages p ON p.page_id = l.page_id
   WHERE l.kind = 'figure' AND l.anchor_bid = ?
   ORDER BY p.position, l.first_offset
`);

/** Wer verweist auf dieses Ziel (Rueckwaertsrichtung). Grundlage der Warnung
 *  „auf dieses Kapitel wird an 3 Stellen verwiesen", bevor es geloescht wird. */
function listXrefBacklinks(kind, target) {
  if (kind === 'chapter') return _stmtBacklinksChapter.all(parseInt(target));
  if (kind === 'figure') return _stmtBacklinksAnchor.all(String(target).toLowerCase());
  return [];
}

const _stmtCountBookLinks = db.prepare(`
  SELECT COUNT(*) AS n
    FROM xref_links l
    JOIN pages p ON p.page_id = l.page_id
   WHERE p.book_id = ?
`);

/** Wie viele Verweise traegt das Buch — fuer Kennzahlen/Karten-Badge. */
function countBookXrefs(bookId) {
  return _stmtCountBookLinks.get(parseInt(bookId))?.n || 0;
}

module.exports = {
  replacePageAnchors, listBookAnchors,
  replacePageXrefs, listPageXrefs, listXrefBacklinks, countBookXrefs,
};
