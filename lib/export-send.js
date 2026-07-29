'use strict';

// Geteilte Helper fuer Sync-Export-Routen (routes/export.js + die Fassungs-
// Export-Route in routes/snapshots.js): Build-Optionen (Sprache/Autor + EPUB-
// Publikations-Metadaten) und das Schreiben der Buffer-Antwort (inkl. BOM).
//
// Domain-Shape von loadContents/snapshotToBundle fuehrt Sprache/Autor (noch)
// nicht — EPUB/DOCX brauchen dc:language/dc:creator, darum hier aufgeloest.

const logger = require('../logger');
const { getBookSettings } = require('../db/schema');
const { getOwnerEmail } = require('../db/book-access');
const { getUser } = require('../db/app-users');

// Sprache (book_settings) + Autor (Owner-Anzeigename) fuer die Builder.
// fmt='epub' augmentiert zusaetzlich um die buch-weiten Publikations-Metadaten
// (Cover/Titelei/Bio aus book_publication). Lazy geladen — nur die BLOBs bei
// Bedarf.
//
// `publication` (aus lib/snapshot-export#snapshotPublication) uebersteuert die
// Live-book_publication mit dem eingefrorenen Stand einer Fassung — Form ist
// identisch ({ meta:getMeta-shaped, cover:{image,mime}|null, authorImage:… }),
// sodass der Rest unveraendert bleibt.
async function buildExportMeta(bookId, fmt, { publication = null, pageIds = null, citations = null, userEmail = null } = {}) {
  const opts = { lang: 'de', author: '' };
  if (!bookId) return opts;

  // Quellen: Kurzbeleg-Kontext + Verzeichnis der gerenderten Einheit
  // (lib/bibliography.js). Auch bei abgeschaltetem Verzeichnis noetig — die Chips
  // im Text brauchen ihren Kurzbeleg im gewaehlten Zitierstil, sonst zeigt der
  // Export einen Beleg im falschen Stil (im numerischen Stil sogar ohne Nummer).
  // `pageIds` null = Buch-Scope; bei Kapitel-/Seiten-Export nur deren
  // Fundstellen, damit Chip-Nummer und Verzeichnisnummer zusammenpassen.
  //
  // `citations` uebersteuert beides mit einer fertigen Fundstellen-Liste. Der
  // Fassungs-Export braucht das: sein HTML ist ein alter Stand, der Fund-Index
  // beschreibt aber den heutigen — die Nummern muessen dem folgen, was im Export
  // wirklich steht (lib/bibliography.js#citationsFromGroups).
  try {
    const { buildBibliography } = require('./bibliography');
    opts.bibliography = await buildBibliography({ bookId, pageIds, citations, userEmail });
  } catch (e) {
    logger.warn(`Quellenverzeichnis fuer Export nicht ladbar (book=${bookId}): ${e.message}`);
  }

  opts.lang = getBookSettings(bookId)?.language || 'de';
  try {
    const ownerEmail = getOwnerEmail(bookId);
    if (ownerEmail) opts.author = getUser(ownerEmail)?.display_name || '';
  } catch { /* Owner/User nicht aufloesbar -> Autor leer */ }

  if (fmt === 'epub') {
    try {
      let meta; let cover = null; let authorImage = null;
      if (publication) {
        ({ meta, cover, authorImage } = publication);
      } else {
        const bp = require('../db/book-publication');
        meta = bp.getMeta(bookId);
        if (meta.has_cover) cover = bp.getCover(bookId);
        if (meta.has_author_image) authorImage = bp.getAuthorImage(bookId);
      }
      opts.meta = meta;
      // Publikationsname (book_publication.author_name) uebersteuert den Account-Namen.
      if ((meta.author_name || '').trim()) opts.author = meta.author_name.trim();
      opts.tocTitle = meta.epub_toc_title || undefined;
      if (cover) opts.cover = cover;
      if (authorImage) opts.authorImage = authorImage;
    } catch (e) {
      logger.warn(`Publikations-Metadaten fuer EPUB nicht ladbar (book=${bookId}): ${e.message}`);
    }
  }
  return opts;
}

// Schreibt den fertigen Export-Buffer als Download. `spec` ist der FORMATS-
// Eintrag (mime + optionales bom-Flag).
function sendExportBuffer(res, { spec, buf, filename }) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  res.setHeader('Content-Type', spec.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (spec.bom) {
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    res.setHeader('Content-Length', bom.length + buf.length);
    res.write(bom);
    res.end(buf);
    return;
  }
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}

module.exports = { buildExportMeta, sendExportBuffer };
