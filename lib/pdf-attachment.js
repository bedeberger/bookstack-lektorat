'use strict';
// Geteilter PDF-Anhang-Stack. Zwei Oberflaechen fuehren ein Original-PDF an
// einem Datensatz: das Recherche-Fundstueck (routes/research.js, buchskopiert)
// und die Quelle (routes/sources.js, User-Pool). Beide legen dasselbe ab —
// Original-BLOB + extrahierter Plain-Text + Seitenzahl + Inhalts-Hash — und
// unterscheiden sich nur in ACL und Zieltabelle.
//
// Alles Mechanische liegt darum hier, damit es nicht zweimal (und zweimal
// unterschiedlich) implementiert wird:
//   - Upload-Limit als express.raw-Body (Zahl kommt aus lib/pdf-extract.js)
//   - Dateinamens-Bereinigung
//   - Extraktion inkl. Fehler-Mapping auf unterscheidbare API-error_codes
//     (ein pauschales 400 kann „passwortgeschuetzt" nicht von „kein PDF" trennen)
//   - Inhalts-Hash fuer den Re-Upload-Kurzschluss (identische Datei ⇒ kein
//     erneutes Extrahieren, kein erneuter Index-Job)
//   - Auslieferungs-Header inkl. `nosniff`: fremdes Upload-Material geht
//     same-origin und inline an den Browser, der Content-Type muss binden.
//
// ACL und Persistenz bleiben bewusst beim jeweiligen Router: Buch-ACL vs.
// Pool-Besitz ist der eigentliche Unterschied zwischen den beiden Konsumenten
// und laesst sich nicht sinnvoll hinter einen gemeinsamen Callback zwaengen.

const crypto = require('crypto');
const express = require('express');
const { extractPdfText, MAX_INPUT_BYTES, MAX_TEXT_CHARS } = require('./pdf-extract');

const DOCNAME_MAX = 200;
const DOCNAME_FALLBACK = 'Dokument.pdf';

// express.raw will die Groesse als String ('25mb'). Aus der SSoT ableiten statt
// die Zahl daneben nochmals hinzuschreiben.
const RAW_BODY_LIMIT = `${Math.floor(MAX_INPUT_BYTES / (1024 * 1024))}mb`;

/** express.raw-Middleware fuer PDF-Bodies. Jeder Upload-Endpunkt nutzt diese. */
function rawPdfBody() {
  return express.raw({ type: ['application/pdf'], limit: RAW_BODY_LIMIT });
}

/** Inhalts-Hash des Original-PDFs (sha256, gekuerzt — gleiche Form wie
 *  lib/embed-chunk.js#contentHash, aber direkt ueber den Buffer statt ueber
 *  einen Umweg-String). Nur ein Gleichheits-Vergleich, keine Signatur. */
function docHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

/** Anzeige-Dateiname aus `?name=`. Reiner Anzeigewert — er landet nur in der
 *  Content-Disposition (URL-encoded) und in der Liste, nie im Dateisystem. */
function cleanDocName(s) {
  return String(s || '').trim().replace(/[\r\n]+/g, ' ').slice(0, DOCNAME_MAX) || DOCNAME_FALLBACK;
}

// pdf-extract wirft sprechende Marker; die Route soll sie nicht alle auf ein
// „PDF kaputt" einebnen. Alles Unbekannte (Parser-Crash, verschluesselt) bleibt
// DOC_UNREADABLE.
const _EXTRACT_ERRORS = {
  'pdf-not-buffer': { status: 400, error_code: 'NO_DOC' },
  'pdf-empty': { status: 400, error_code: 'NO_DOC' },
  'pdf-too-large': { status: 413, error_code: 'DOC_TOO_LARGE' },
  'pdf-unsupported-format': { status: 415, error_code: 'DOC_NOT_PDF' },
};

/**
 * Upload-Body pruefen und auswerten. Wirft nie — der Aufrufer bekommt entweder
 * das fertige Doc-Objekt oder eine fertige Fehlerantwort.
 *
 * @param {Buffer} body        req.body aus rawPdfBody()
 * @param {string} nameParam   req.query.name
 * @returns {Promise<{ok: true, doc: {name,text,pages,chars,truncated,hash,mime,buffer}}
 *                   |{ok: false, status: number, error_code: string, detail?: string}>}
 */
async function readDocUpload(body, nameParam) {
  if (!Buffer.isBuffer(body) || !body.length) {
    return { ok: false, status: 400, error_code: 'NO_DOC' };
  }
  try {
    const { text, pages, chars, truncated } = await extractPdfText(body);
    return {
      ok: true,
      doc: {
        name: cleanDocName(nameParam),
        mime: 'application/pdf',
        buffer: body,
        text, pages, chars, truncated,
        hash: docHash(body),
      },
    };
  } catch (e) {
    const mapped = _EXTRACT_ERRORS[e?.message] || { status: 400, error_code: 'DOC_UNREADABLE' };
    return { ...mapped, ok: false, detail: e?.message };
  }
}

/** BLOB ausliefern: inline mit Original-Dateinamen, aber mit gebundenem
 *  Content-Type (`nosniff`) — der Browser darf fremdes Upload-Material nicht
 *  zu etwas Ausfuehrbarem umdeuten. */
function sendDoc(res, { buffer, mime, name }) {
  const safeName = encodeURIComponent(name || 'dokument.pdf');
  res.set('Content-Type', mime || 'application/pdf');
  res.set('Content-Disposition', `inline; filename*=UTF-8''${safeName}`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(buffer);
}

module.exports = {
  rawPdfBody, cleanDocName, docHash, readDocUpload, sendDoc,
  DOCNAME_MAX, DOCNAME_FALLBACK, RAW_BODY_LIMIT, MAX_INPUT_BYTES, MAX_TEXT_CHARS,
};
