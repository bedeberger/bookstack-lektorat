'use strict';
// PDF-Anhang an der Quelle: Original-BLOB, extrahierter Volltext und der
// Index-Stempel fuer die semantische Bibliothekssuche.
//
// Weder `doc` noch `doc_text` verlassen die Tabelle auf einem Listenweg — die
// Spaltenliste in ./shared.js fuehrt sie bewusst nicht; hier liegen die einzigen
// Zugaenge.

const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');

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
  setSourceDoc, clearSourceDoc, getSourceDocMeta, getSourceDocBlob, getSourceDocText,
  markSourceIndexed,
};
