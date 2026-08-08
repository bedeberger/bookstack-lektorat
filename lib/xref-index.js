'use strict';
// Index der Querverweise: liest Marker UND Ziele aus dem gespeicherten
// Seiten-HTML und schreibt `xref_links` + `xref_anchors` pro Seite neu
// (Full-Replace, Muster lib/cite-index.js).
//
// Wahrheit ist der Marker im HTML — beide Tabellen sind reine Ableitung und
// jederzeit neu berechenbar. Aufgerufen am Schreib-Chokepoint der
// Content-Store-Facade (lib/content-store/index.js), damit KEIN Schreibpfad
// (Editor, Import, Blog-Pull, Snapshot-Restore, Job) daran vorbeikommt.
//
// REIHENFOLGE IST WICHTIG: erst die Anker, dann die Verweise. Der Buch-Guard in
// db/xrefs.js#replacePageXrefs prueft Abbildungs-Ziele gegen `xref_anchors`; auf
// einer Seite, die sowohl eine Abbildung als auch einen Verweis darauf traegt,
// muesste der Verweis sonst bis zum naechsten Speichern warten.
//
// Parsing-Logik wird NICHT dupliziert: `collectXrefs`/`collectFigureAnchors`
// liegen als DOM-agnostische ESM-Module in public/js/xrefs/ und werden hier per
// dynamic import() geladen (Muster lib/prompts-loader.js, wie schon
// lib/cite-index.js). linkedom liefert das DOM, dasselbe wie in
// lib/html-clean.js.

const { parseHTML } = require('linkedom');
const { db } = require('../db/schema');            // ueber schema: garantiert migrations-fertig
const { replacePageAnchors, replacePageXrefs } = require('../db/xrefs');
const { xrefModules } = require('./esm-bridge');
const logger = require('../logger');

// Billiger Vorab-Test, bevor ueberhaupt ein DOM gebaut wird. Zwei Marker, weil
// Verweise und Ziele unabhaengig voneinander auftreten: eine Seite kann eine
// Abbildung tragen, ohne auf etwas zu verweisen, und umgekehrt.
//
// Die Literale MUESSEN XREF_ATTR_ID bzw. dem Anker-Attribut entsprechen;
// gegated durch tests/unit/xref-index.test.js.
const XREF_HINT = 'data-xref-id';
const ANCHOR_HINT = '<figure';

// Der Index braucht nur Markup + Anker — Nummerierung und Formatierung sind
// Sache des Ausgabewegs (lib/xref-render.js), nicht der Ableitung.
function _xrefModules() {
  return xrefModules({ withRender: false });
}

const _stmtHasLinks = db.prepare('SELECT 1 AS x FROM xref_links WHERE page_id = ? LIMIT 1');
const _stmtHasAnchors = db.prepare('SELECT 1 AS x FROM xref_anchors WHERE page_id = ? LIMIT 1');

/** Querverweise und Anker einer Seite neu indizieren.
 *  @returns {{ anchors: number, links: number }} */
async function reindexPageXrefs(pageId, html) {
  const pid = parseInt(pageId, 10);
  if (!Number.isInteger(pid)) return { anchors: 0, links: 0 };

  const src = typeof html === 'string' ? html : '';
  const mayHaveLinks = src.indexOf(XREF_HINT) !== -1;
  const mayHaveAnchors = src.indexOf(ANCHOR_HINT) !== -1;

  if (!mayHaveLinks && !mayHaveAnchors) {
    // Nichts im HTML. Aufraeumen nur, wenn ueberhaupt Zeilen existieren — ein
    // indizierter Lese-Check ist billiger als zwei Schreib-Transaktionen auf
    // jeder Seite jedes Buchs.
    if (_stmtHasAnchors.get(pid)) replacePageAnchors(pid, []);
    if (_stmtHasLinks.get(pid)) replacePageXrefs(pid, []);
    return { anchors: 0, links: 0 };
  }

  const { collectXrefs, xrefsByTarget, collectFigureAnchors } = await _xrefModules();
  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${src}</div></body></html>`);
  const root = document.getElementById('r');
  if (!root) return { anchors: 0, links: 0 };

  // Anker zuerst — siehe Modulkopf.
  const anchors = mayHaveAnchors
    ? replacePageAnchors(pid, collectFigureAnchors(root))
    : (_stmtHasAnchors.get(pid) ? replacePageAnchors(pid, []) : 0);

  const links = mayHaveLinks
    ? replacePageXrefs(pid, xrefsByTarget(collectXrefs(root)))
    : (_stmtHasLinks.get(pid) ? replacePageXrefs(pid, []) : 0);

  return { anchors, links };
}

/** Wie reindexPageXrefs, aber nie werfend — fuer Aufrufer am Schreibpfad, die
 *  den Save nicht an einem Index-Fehler scheitern lassen duerfen. */
async function reindexPageXrefsSafe(pageId, html) {
  try {
    return await reindexPageXrefs(pageId, html);
  } catch (e) {
    logger.warn(`[xref-index] Reindex fehlgeschlagen (page=${pageId}): ${e.message}`);
    return { anchors: 0, links: 0 };
  }
}

// ── Nachindizierung von Bestandsinhalten ─────────────────────────────────────
// Der Schreibpfad-Hook fuellt den Index nur fuer Seiten, die NACH Einfuehrung des
// Features gespeichert wurden. Ohne Nachindizierung zeigt der Ziel-Picker in
// einem gewachsenen Buch keine einzige Abbildung — das Feature saehe kaputt aus,
// obwohl die Mechanik stimmt.
//
// Direkter SQL-Lesezugriff auf `pages` ist hier bewusst und deckungsgleich mit
// lib/search.js#reindexAll: ein reiner Ableitungs-Index derselben Klasse, der am
// selben Chokepoint haengt. Die Content-Store-Facade ist der Eintrittspunkt fuer
// das SCHREIBEN und fuer Fach-Logik; ein Index, der ohnehin nur aus dem
// gespeicherten HTML ableitet, wuerde ueber die Facade lediglich N Einzelabrufe
// erzeugen.
//
// KEIN Job-Typ (anders als embed-index/motif-scan/beat-anchor): hier laeuft kein
// callAI und nichts, dessen Fortschritt jemand sehen will. Das ist Klempnerei
// wie der FTS-Index — und der ist ebenfalls ein direkter Hook, kein Job.

const _stmtBookPages = db.prepare('SELECT page_id, body_html FROM pages WHERE book_id = ?');
const _stmtAllBooks = db.prepare('SELECT book_id FROM books');

/** Alle Seiten EINES Buchs neu indizieren.
 *  Billig trotz Full-Scan: Seiten ohne Marker fallen schon am `indexOf`-Vortest
 *  heraus, bevor ein DOM gebaut wird — in einem Manuskript ist das die
 *  ueberwaeltigende Mehrheit. */
async function reindexBookXrefs(bookId) {
  const bid = parseInt(bookId, 10);
  if (!Number.isInteger(bid)) return { pages: 0, anchors: 0, links: 0 };
  let anchors = 0, links = 0, pages = 0;
  for (const row of _stmtBookPages.all(bid)) {
    const res = await reindexPageXrefsSafe(row.page_id, row.body_html || '');
    anchors += res.anchors;
    links += res.links;
    pages++;
  }
  return { pages, anchors, links };
}

/** Alle Buecher nachindizieren. Laeuft im Nacht-Cron und heilt damit auch Drift,
 *  die kein Seiten-Write mehr anfassen wuerde (z.B. ein Verweis, dessen Ziel
 *  erst spaeter angelegt wurde — siehe Buch-Guard in db/xrefs.js). */
async function reindexAllXrefs() {
  const t0 = Date.now();
  let books = 0, pages = 0, anchors = 0, links = 0;
  for (const { book_id } of _stmtAllBooks.all()) {
    const r = await reindexBookXrefs(book_id);
    books++; pages += r.pages; anchors += r.anchors; links += r.links;
  }
  logger.info(`[xref-index] Nachindizierung: ${books} Buch/Buecher, ${pages} Seiten, ${anchors} Anker, ${links} Verweise (${Date.now() - t0}ms).`);
  return { books, pages, anchors, links };
}

// Buecher, die in diesem Prozess-Leben schon nachindiziert wurden. Verhindert,
// dass jedes Oeffnen des Ziel-Pickers erneut ueber alle Seiten laeuft — auch
// (und gerade) bei Buechern ohne jede Abbildung, wo der Index leer BLEIBT und
// „leer" darum nicht von „noch nie indiziert" zu unterscheiden waere.
const _stmtBookHasAnchors = db.prepare(`
  SELECT 1 AS x FROM xref_anchors a
    JOIN pages p ON p.page_id = a.page_id
   WHERE p.book_id = ? LIMIT 1
`);

const _backfilled = new Set();

/** Sicherstellen, dass ein Buch indiziert ist — Lazy-Pfad fuer den Ziel-Picker.
 *  Der Nacht-Cron holt den Rest; dieser Aufruf sorgt dafuer, dass der Picker
 *  sofort nach dem Deploy stimmt statt erst am naechsten Morgen. */
async function ensureBookXrefsIndexed(bookId) {
  const bid = parseInt(bookId, 10);
  if (!Number.isInteger(bid) || _backfilled.has(bid)) return false;
  _backfilled.add(bid);
  if (_stmtBookHasAnchors.get(bid)) return false;   // schon indiziert
  await reindexBookXrefs(bid);
  return true;
}

module.exports = {
  reindexPageXrefs, reindexPageXrefsSafe,
  reindexBookXrefs, reindexAllXrefs, ensureBookXrefsIndexed,
  XREF_HINT, ANCHOR_HINT,
};
