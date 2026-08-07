'use strict';
// Redaktions-Status pro Beitrag: Rohfassung → gegengelesen → schlussredigiert →
// freigegeben.
//
// Der Status ist eine Aussage ueber den PROZESS („darf das raus?"), nicht ueber
// den Text. Deshalb liegt er neben `pages` (eigene Tabelle, siehe Migration 268)
// und nicht in den Fassungen (`book_snapshots`) — die bleiben das Textarchiv.
//
// ZWEI DINGE, DIE DIESE DATEI ZUR SSoT MACHEN:
//
// 1. `REDAKTION_STATUS` ist die Reihenfolge der Stufen. Sie ist geordnet, nicht
//    bloss eine Menge: die Karte zeigt daraus den Fortschritt, und `statusRank`
//    beantwortet „weiter als". Neue Stufe ⇒ hier einsortieren, dazu den
//    CHECK-Constraint der Tabelle und die i18n-Keys `redaktion.status.<key>`.
//    Gegated durch tests/unit/redaktion-status.test.js.
//
// 2. `stale` — ob der Text seit dem Setzen des Status angefasst wurde. Die Frage
//    entscheidet sich am Vergleich `pages.updated_at > content_updated_at`, und
//    zwar an genau EINER Stelle (`_mapRow`). Eine Freigabe auf einem Text, der
//    sich seither geaendert hat, ist keine Freigabe mehr — wer das an zwei
//    Stellen berechnet, bekommt zwei Antworten.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

/** Stufen in Prozessreihenfolge. Deckungsgleich mit dem CHECK-Constraint von
 *  `page_editorial_status.status` und mit REDAKTION_STATUS in
 *  public/js/redaktion/status.js (CJS-Spiegel, weil die Schreibpfade synchron
 *  validieren muessen). */
const REDAKTION_STATUS = ['roh', 'gegengelesen', 'schlussredigiert', 'freigegeben'];

/** Die Stufe, ab der ein Beitrag als fertig gilt. Einziger Konsument des
 *  Literals — Kennzahlen und Badges fragen hier. */
const REDAKTION_STATUS_DONE = 'freigegeben';

function isValidRedaktionStatus(v) {
  return typeof v === 'string' && REDAKTION_STATUS.includes(v);
}

/** Position in der Kette (0-basiert), -1 fuer unbekannt/ungesetzt. */
function statusRank(v) {
  return REDAKTION_STATUS.indexOf(v);
}

const _stmtGet = db.prepare(`
  SELECT s.page_id, s.status, s.note, s.content_updated_at, s.updated_by, s.updated_at,
         p.updated_at AS page_updated_at
    FROM page_editorial_status s
    JOIN pages p ON p.page_id = s.page_id
   WHERE s.page_id = ?
`);

const _stmtListForBook = db.prepare(`
  SELECT s.page_id, s.status, s.note, s.content_updated_at, s.updated_by, s.updated_at,
         p.updated_at AS page_updated_at
    FROM page_editorial_status s
    JOIN pages p ON p.page_id = s.page_id
   WHERE s.book_id = ?
`);

const _stmtSet = db.prepare(`
  INSERT INTO page_editorial_status
         (page_id, book_id, status, note, content_updated_at, updated_by, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(page_id) DO UPDATE SET
    book_id            = excluded.book_id,
    status             = excluded.status,
    note               = excluded.note,
    content_updated_at = excluded.content_updated_at,
    updated_by         = excluded.updated_by,
    updated_at         = excluded.updated_at
`);

const _stmtClear = db.prepare('DELETE FROM page_editorial_status WHERE page_id = ?');

const _stmtPageUpdatedAt = db.prepare('SELECT updated_at FROM pages WHERE page_id = ?');

/**
 * Ist der Status ueberholt? Wahr, wenn die Seite nach dem Setzen des Status
 * gespeichert wurde. Zeitstempel sind ISO+Z (Harte Regel „DB-Timestamps"), damit
 * ist der lexikografische Vergleich chronologisch korrekt.
 *
 * Ohne Anker (`content_updated_at IS NULL`, z. B. Status aus einem Import) gilt
 * der Status als aktuell — lieber keine Warnung als eine falsche.
 */
function _isStale(row) {
  if (!row?.content_updated_at || !row?.page_updated_at) return false;
  return String(row.page_updated_at) > String(row.content_updated_at);
}

function _mapRow(r) {
  if (!r) return null;
  return {
    page_id: r.page_id,
    status: r.status,
    note: r.note || null,
    updated_by: r.updated_by || null,
    updated_at: r.updated_at,
    content_updated_at: r.content_updated_at || null,
    stale: _isStale(r),
  };
}

/** Status einer Seite oder null (= keine Stufe gesetzt). */
function getPageStatus(pageId) {
  return _mapRow(_stmtGet.get(parseInt(pageId)));
}

/** Alle Status eines Buchs als { [page_id]: {...} }. Map statt Liste, weil jeder
 *  Konsument (Organizer-Zeile, Kennzahl) per page_id nachschlaegt. */
function listBookStatus(bookId) {
  const out = {};
  for (const r of _stmtListForBook.all(parseInt(bookId))) {
    out[String(r.page_id)] = _mapRow(r);
  }
  return out;
}

/**
 * Setzt (oder mit `status = null` entfernt) die Stufe einer Seite.
 *
 * Der Frische-Anker wird hier aus `pages.updated_at` gezogen und nicht vom
 * Aufrufer entgegengenommen: sonst koennte ein Client einen Status auf einen
 * Textstand stempeln, den es nie gab, und die Stale-Anzeige waere wertlos.
 */
function setPageStatus(pageId, bookId, { status, note = null, userEmail = null }) {
  const pid = parseInt(pageId);
  if (status == null || status === '') { _stmtClear.run(pid); return null; }
  if (!isValidRedaktionStatus(status)) {
    const err = new Error(`Ungueltiger Redaktions-Status: ${status}`);
    err.code = 'INVALID_STATUS';
    throw err;
  }
  const anchor = _stmtPageUpdatedAt.get(pid)?.updated_at || null;
  const cleanNote = note == null ? null : String(note).trim().slice(0, 500) || null;
  _stmtSet.run(pid, parseInt(bookId), status, cleanNote, anchor, userEmail);
  return getPageStatus(pid);
}

/**
 * Verteilung ueber die Stufen fuer ein Buch: { roh: n, …, ohne: n }.
 * `ohne` sind die Seiten des Buchs ohne jede Stufe — ohne die Zahl liest sich
 * eine Verteilung als „alles erfasst", obwohl die Haelfte nie angefasst wurde.
 */
function statusCounts(bookId) {
  const bid = parseInt(bookId);
  const counts = Object.fromEntries(REDAKTION_STATUS.map(s => [s, 0]));
  for (const r of db.prepare(
    'SELECT status, COUNT(*) AS n FROM page_editorial_status WHERE book_id = ? GROUP BY status',
  ).all(bid)) {
    if (r.status in counts) counts[r.status] = r.n;
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM pages WHERE book_id = ?').get(bid)?.n || 0;
  const set = REDAKTION_STATUS.reduce((a, s) => a + counts[s], 0);
  counts.ohne = Math.max(0, total - set);
  return counts;
}

module.exports = {
  REDAKTION_STATUS, REDAKTION_STATUS_DONE, isValidRedaktionStatus, statusRank,
  getPageStatus, listBookStatus, setPageStatus, statusCounts,
};
