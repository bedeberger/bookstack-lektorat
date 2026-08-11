'use strict';
// Quellen-Dokument (PDF-Anhang am User-Pool). Eigener Router, in
// routes/sources.js unter demselben Mount eingehaengt — der CRUD-Teil ist ohne
// ihn schon am LOC-Limit, und der Anhang ist ein abgeschlossenes Thema.
//
// Original-PDF als BLOB an der Quelle + extrahierter Plain-Text (`doc_text`)
// fuer die semantische Suche ueber die Bibliothek. Anlegen/Aendern/Loeschen ist
// Pool-Hoheit (nur Besitzer), Lesen ab Buch-Viewer, sobald die Quelle dem Buch
// zugeordnet ist (routes/sources-acl.js).
//
// Upload triggert asynchron den Embedding-Index-Job (user-skopiert) und gibt
// dessen Id zurueck, damit die Karte den Fortschritt zeigen kann statt „Index
// wird gebaut" einzufrieren. Nie generativ im Buchtext.
//
// Alles Mechanische (Limit, Namens-Bereinigung, Extraktion, Fehler-Codes,
// Auslieferungs-Header inkl. nosniff) kommt aus lib/pdf-attachment.js — dasselbe
// Modul bedient den PDF-Anhang des Recherche-Boards. Nomenklatur darum auch hier
// `doc` und nicht `pdf`: Route, Spalten und Frontend-State heissen gleich.

const express = require('express');
const {
  getSource, setSourceDoc, clearSourceDoc, getSourceDocMeta, getSourceDocBlob,
} = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { rawPdfBody, readDocUpload, sendDoc } = require('../lib/pdf-attachment');
const { canReadById, isOwner } = require('./sources-acl');
const { sessionEmail } = require('../lib/acl');
const { enqueueSourceEmbedIndexJob } = require('./jobs/source-embed-index');
const sourceSemanticChunks = require('../db/source-semantic-chunks');
const logger = require('../logger');

const router = express.Router();

/** Gemeinsamer Vorspann der Schreibpfade: eingeloggt + Quelle da + Besitzer.
 *  Liefert die Quelle oder null (Antwort ist dann schon raus). */
function _ownedSource(req, res) {
  if (!sessionEmail(req)) { res.status(401).json({ error_code: 'NOT_LOGGED_IN' }); return null; }
  const id = toIntId(req.params.id);
  if (!id) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  const src = getSource(id);
  if (!src) { res.status(404).json({ error_code: 'NOT_FOUND' }); return null; }
  if (!isOwner(req, src)) { res.status(403).json({ error_code: 'NOT_SOURCE_OWNER' }); return null; }
  return src;
}

// POST /sources/:id/doc?name=Dokument.pdf   body: raw PDF bytes
router.post('/:id/doc', rawPdfBody(), async (req, res) => {
  const src = _ownedSource(req, res);
  if (!src) return;

  const up = await readDocUpload(req.body, req.query.name);
  if (!up.ok) {
    logger.warn(`[quellen] Dokument-Upload abgelehnt id=${src.id}: ${up.error_code} (${up.detail || '-'})`);
    return res.status(up.status).json({ error_code: up.error_code });
  }
  const { doc } = up;

  // Dieselbe Datei nochmals hochgeladen? Dann nichts tun — der Volltext ist
  // Byte fuer Byte derselbe, und ein Re-Index waere reine Rechenzeit.
  const prev = getSourceDocMeta(src.id);
  if (prev?.has_doc && prev.doc_content_hash === doc.hash) {
    logger.info(`[quellen] Dokument unveraendert id=${src.id} (hash ${doc.hash}) — kein Re-Index`);
    return res.json({ ...getSource(src.id), doc_truncated: doc.truncated, doc_unchanged: true });
  }

  setSourceDoc(src.id, doc);
  logger.info(`[quellen] Dokument-Upload id=${src.id} pages=${doc.pages} chars=${doc.chars}${doc.truncated ? ' (gedeckelt)' : ''}`);
  let jobId = null;
  try { jobId = enqueueSourceEmbedIndexJob(sessionEmail(req)); }
  catch (e) { logger.warn(`[quellen] embed-index enqueue fehlgeschlagen: ${e.message}`); }
  res.json({ ...getSource(src.id), index_job_id: jobId });
});

// GET /sources/:id/doc  → BLOB-Stream, inline mit Original-Dateinamen (Viewer).
router.get('/:id/doc', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  // Meta-Zeile OHNE BLOB: die ACL-Entscheidung darf keine 25 MB durch den
  // Prozess ziehen, nur um danach 403 zu antworten.
  const meta = getSourceDocMeta(id);
  if (!meta) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!meta.has_doc) return res.status(404).json({ error_code: 'NO_DOC' });
  const allowed = meta.owner_email === email || canReadById(req, id);
  if (!allowed) return res.status(403).json({ error_code: 'FORBIDDEN' });
  sendDoc(res, { buffer: getSourceDocBlob(id), mime: meta.doc_mime, name: meta.doc_name });
});

// DELETE /sources/:id/doc  → PDF + extrahierten Text entfernen (Quelle bleibt).
// Index-Chunks wuerde der naechste Job-Lauf via pruneMissing raeumen; wir
// loeschen sie hier sofort, damit die Suche keine Treffer auf ein entferntes
// PDF liefert (und der User ein sauberes „Index steht"-Signal bekommt).
router.delete('/:id/doc', (req, res) => {
  const src = _ownedSource(req, res);
  if (!src) return;
  clearSourceDoc(src.id);
  sourceSemanticChunks.removeSource(src.id);
  logger.info(`[quellen] Dokument entfernt id=${src.id}`);
  res.json(getSource(src.id));
});

module.exports = router;
