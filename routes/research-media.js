'use strict';
// Medien-Wege der Recherche-Karte: Bild- und PDF-Upload/-Auslieferung/-Löschung
// eines Fundstücks. Aus routes/research.js ausgelagert, weil das Medien-Subsystem
// sein eigenes Lifecycle-Cluster hat (sharp-Normalisierung, PDF-Extraktion,
// Embedding-Index-Nachzug) und für Bugfix-Kontext eine eigenständige Einheit ist.
//
// Routen (am research-Haupt-Router gemountet, siehe routes/research.js):
//   POST   /:id/image   sharp-normalisiertes Bild als BLOB, kind wird 'image'
//   GET    /:id/image   Bild als BLOB-Stream (viewer-Recht, private Cache)
//   DELETE /:id/image   Bild entfernen, kind fällt auf 'note' zurück
//   POST   /:id/doc     Original-PDF + extrahierter Text, kind wird 'document'
//   GET    /:id/doc     Dokument als BLOB-Stream (viewer, Original-Name inline)
//   DELETE /:id/doc     Dokument entfernen, kind fällt auf 'note' zurück

const express = require('express');
const { db } = require('../db/schema');
const { emitItem, itemBookId } = require('../db/research-items');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError } = require('../lib/acl');
const { prepareCover } = require('../lib/cover-prepare');
// PDF-Anhang: geteilter Stack mit routes/sources.js (Limit, Namen, Extraktion,
// Fehler-Codes, Auslieferungs-Header).
const { rawPdfBody, readDocUpload, sendDoc } = require('../lib/pdf-attachment');
// Trigger des buchskopierten Embedding-Index-Jobs nach einem PDF-Upload.
const { enqueueEmbedIndexJob } = require('./jobs/embed-index');
const { NOW_ISO_SQL } = require('../db/now');
const searchIndex = require('../lib/search');
const logger = require('../logger');

const researchMediaRouter = express.Router();
const jsonBody = express.json();
const rawImage = express.raw({ type: ['image/*'], limit: '12mb' });

function userEmailOrNull(req) {
  return req.session?.user?.email || null;
}

function _guard(req, res, bookId, minRole) {
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return true; }
  catch (e) { return !sendACLError(res, e); }
}

// ── Bild hochladen (sharp-normalisiert) ──────────────────────────────────────
researchMediaRouter.post('/:id/image', rawImage, async (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error_code: 'NO_IMAGE' });
  }
  try {
    const { buffer, mime } = await prepareCover(req.body);
    db.prepare(
      `UPDATE research_items SET image = ?, image_mime = ?, kind = 'image', updated_at = ${NOW_ISO_SQL} WHERE id = ?`
    ).run(buffer, mime, id);
    res.json(emitItem(id));
  } catch (e) {
    logger.warn('[research] Bild-Upload fehlgeschlagen: ' + e.message);
    res.status(400).json({ error_code: 'IMAGE_INVALID' });
  }
});

// Bild ausliefern (BLOB-Stream).
researchMediaRouter.get('/:id/image', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const row = db.prepare('SELECT book_id, image, image_mime FROM research_items WHERE id = ?').get(id);
  if (!row || !row.image) return res.status(404).json({ error_code: 'NO_IMAGE' });
  if (!_guard(req, res, row.book_id, 'viewer')) return;
  res.set('Content-Type', row.image_mime || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(row.image);
});

// Bild entfernen (Item bleibt; kind fällt auf 'note' zurück, falls es nur wegen
// des Bildes 'image' war — Pendant zum Dokument-Löschen weiter unten). Kein
// FTS-/Embedding-Nachzug: das Bild trägt keinen indizierten Text.
researchMediaRouter.delete('/:id/image', (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;
  db.prepare(
    `UPDATE research_items
        SET image = NULL, image_mime = NULL,
            kind = CASE WHEN kind = 'image' THEN 'note' ELSE kind END,
            updated_at = ${NOW_ISO_SQL}
      WHERE id = ?`
  ).run(id);
  res.json(emitItem(id));
});

// ── Dokument (PDF) hochladen ─────────────────────────────────────────────────
// Original-PDF als BLOB + extrahierter Plain-Text (FTS + Embedding-Index + KI-
// Verknuepfung). Dateiname kommt als ?name= (URL-encoded). Rein lesend, nie
// generativ.
researchMediaRouter.post('/:id/doc', rawPdfBody(), async (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;

  const up = await readDocUpload(req.body, req.query.name);
  if (!up.ok) {
    logger.warn(`[research] Dokument-Upload abgelehnt id=${id}: ${up.error_code} (${up.detail || '-'})`);
    return res.status(up.status).json({ error_code: up.error_code });
  }
  const { doc } = up;
  db.prepare(
    `UPDATE research_items
        SET doc = ?, doc_mime = ?, doc_name = ?, doc_text = ?, doc_pages = ?, doc_chars = ?,
            kind = 'document', updated_at = ${NOW_ISO_SQL}
      WHERE id = ?`
  ).run(doc.buffer, doc.mime, doc.name, doc.text, doc.pages, doc.chars, id);
  searchIndex.upsertResearch(id);
  // Semantik-Index nachziehen (non-fatal): ohne das wäre der frische Volltext
  // bis zum Nacht-Cron nur über exakten Wortmatch auffindbar.
  try { enqueueEmbedIndexJob(bookId, userEmail); }
  catch (e) { logger.warn(`[research] embed-index enqueue fehlgeschlagen: ${e.message}`); }
  logger.info(`[research] doc upload id=${id} pages=${doc.pages} chars=${doc.chars}${doc.truncated ? ' (gedeckelt)' : ''}`);
  res.json(emitItem(id));
});

// Dokument ausliefern (BLOB-Stream, inline mit Original-Dateinamen). Zweistufig:
// erst die Meta-Zeile für die ACL, den BLOB erst danach — ein 403 soll keine
// 25 MB durch den Prozess ziehen.
researchMediaRouter.get('/:id/doc', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const row = db.prepare(
    'SELECT book_id, doc_mime, doc_name, (doc IS NOT NULL) AS has_doc FROM research_items WHERE id = ?'
  ).get(id);
  if (!row || !row.has_doc) return res.status(404).json({ error_code: 'NO_DOC' });
  if (!_guard(req, res, row.book_id, 'viewer')) return;
  const blob = db.prepare('SELECT doc FROM research_items WHERE id = ?').get(id)?.doc;
  sendDoc(res, { buffer: blob, mime: row.doc_mime, name: row.doc_name });
});

// Dokument entfernen (Item bleibt; kind fällt auf 'note' zurück, falls es nur
// wegen des Dokuments 'document' war).
researchMediaRouter.delete('/:id/doc', (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;
  db.prepare(
    `UPDATE research_items
        SET doc = NULL, doc_mime = NULL, doc_name = NULL, doc_text = NULL, doc_pages = NULL,
            doc_chars = NULL,
            kind = CASE WHEN kind = 'document' THEN 'note' ELSE kind END,
            updated_at = ${NOW_ISO_SQL}
      WHERE id = ?`
  ).run(id);
  searchIndex.upsertResearch(id);
  res.json(emitItem(id));
});

module.exports = { researchMediaRouter };