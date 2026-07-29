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

const path = require('path');
const { pathToFileURL } = require('url');
const { parseHTML } = require('linkedom');
const { db } = require('../db/schema');            // ueber schema: garantiert migrations-fertig
const { replacePageAnchors, replacePageXrefs } = require('../db/xrefs');
const logger = require('../logger');

// Billiger Vorab-Test, bevor ueberhaupt ein DOM gebaut wird. Zwei Marker, weil
// Verweise und Ziele unabhaengig voneinander auftreten: eine Seite kann eine
// Abbildung tragen, ohne auf etwas zu verweisen, und umgekehrt.
//
// Die Literale MUESSEN XREF_ATTR_ID bzw. dem Anker-Attribut entsprechen;
// gegated durch tests/unit/xref-index.test.js.
const XREF_HINT = 'data-xref-id';
const ANCHOR_HINT = '<figure';

let _modsPromise = null;
function _xrefModules() {
  if (!_modsPromise) {
    const dir = path.resolve(__dirname, '..', 'public', 'js', 'xrefs');
    _modsPromise = Promise.all([
      import(pathToFileURL(path.join(dir, 'xref-html.js')).href),
      import(pathToFileURL(path.join(dir, 'xref-anchor.js')).href),
    ]).then(([html, anchor]) => ({ ...html, ...anchor }));
  }
  return _modsPromise;
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

module.exports = { reindexPageXrefs, reindexPageXrefsSafe, XREF_HINT, ANCHOR_HINT };
