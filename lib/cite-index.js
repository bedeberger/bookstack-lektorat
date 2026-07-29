'use strict';
// Fund-Index der Quellenangaben: liest die Chips aus dem gespeicherten Seiten-HTML und
// schreibt `source_citations` pro Seite neu (Full-Replace, Muster
// page_figure_mentions / motif_occurrences).
//
// Wahrheit ist der Marker im HTML — diese Tabelle ist reine Ableitung und
// jederzeit neu berechenbar. Aufgerufen am Schreib-Chokepoint der
// Content-Store-Facade (lib/content-store/index.js), damit KEIN Schreibpfad
// (Editor, Import, Blog-Pull, Snapshot-Restore, Job) daran vorbeikommt.
//
// Parsing-Logik wird NICHT dupliziert: `collectCites` liegt als DOM-agnostisches
// ESM-Modul in public/js/sources/cite-html.js und wird hier per dynamic import()
// geladen (Muster lib/prompts-loader.js). linkedom liefert das DOM, dasselbe wie
// in lib/html-clean.js.

const path = require('path');
const { pathToFileURL } = require('url');
const { parseHTML } = require('linkedom');
const { db } = require('../db/schema');            // ueber schema: garantiert migrations-fertig
const { replacePageCitations } = require('../db/sources');
const logger = require('../logger');

// Billiger Vorab-Test, bevor ueberhaupt ein DOM gebaut wird: enthaelt das HTML
// den Marker-Attributnamen? Buecher ohne Quellenangaben kosten damit nichts — bei
// Manuskripten im Millionen-Zeichen-Bereich ist das der Unterschied zwischen
// „kein Effekt" und „zweiter HTML-Parse pro Save".
//
// Das Literal MUSS CITE_ATTR_SRC entsprechen; gegated durch
// tests/unit/cite-index.test.js.
const MARKER_HINT = 'data-src';

let _modPromise = null;
function _citeHtmlModule() {
  if (!_modPromise) {
    const file = path.resolve(__dirname, '..', 'public', 'js', 'sources', 'cite-html.js');
    _modPromise = import(pathToFileURL(file).href);
  }
  return _modPromise;
}

const _stmtHasRows = db.prepare('SELECT 1 AS x FROM source_citations WHERE page_id = ? LIMIT 1');

/** Quellenangaben einer Seite neu indizieren.
 *  Gibt die Anzahl indizierter Quellen zurueck (0 wenn die Seite keine Quellenangaben
 *  (mehr) traegt). Buchfremde oder verschwundene Quell-IDs filtert
 *  db/sources.js#replacePageCitations per Buch-Guard heraus. */
async function reindexPageCitations(pageId, html) {
  const pid = parseInt(pageId, 10);
  if (!Number.isInteger(pid)) return 0;

  if (typeof html !== 'string' || html.indexOf(MARKER_HINT) === -1) {
    // Keine Quellenangaben im HTML. Aufraeumen nur, wenn ueberhaupt Zeilen existieren —
    // ein indizierter Lese-Check ist billiger als eine Schreib-Transaktion auf
    // jeder Seite jedes Buchs.
    if (!_stmtHasRows.get(pid)) return 0;
    replacePageCitations(pid, []);
    return 0;
  }

  const { collectCiteIndex, citationsFromCites } = await _citeHtmlModule();
  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  const root = document.getElementById('r');
  if (!root) return 0;
  // Ein Durchlauf liefert Chips UND belegte Blockzitate im selben Offset-Raum.
  const { cites, quotes } = collectCiteIndex(root);
  return replacePageCitations(pid, citationsFromCites(cites, quotes));
}

/** Wie reindexPageCitations, aber nie werfend — fuer Aufrufer am Schreibpfad,
 *  die den Save nicht an einem Index-Fehler scheitern lassen duerfen. */
async function reindexPageCitationsSafe(pageId, html) {
  try {
    return await reindexPageCitations(pageId, html);
  } catch (e) {
    logger.warn(`[cite-index] Reindex fehlgeschlagen (page=${pageId}): ${e.message}`);
    return 0;
  }
}

module.exports = { reindexPageCitations, reindexPageCitationsSafe, MARKER_HINT };
