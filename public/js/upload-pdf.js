// Geteilter PDF-Upload fuers Frontend. Zwei Oberflaechen haengen ein PDF an
// einen Datensatz — die Quelle (public/js/sources/doc.js) und das Recherche-
// Fundstueck (public/js/book/recherche.js). Beide taten dasselbe: Typ pruefen,
// Groesse pruefen, `arrayBuffer()` lesen, mit `?name=` posten, Fehler
// uebersetzen. Server-Pendant: lib/pdf-attachment.js.
//
// Das Groessen-Limit kommt aus dem Config-Store (`pdfUpload.maxBytes` aus
// /config, SSoT lib/pdf-extract.js) — nie eine eigene Zahl hier fuehren, sonst
// laedt der Browser 30 MB hoch, um dann ein 413 zu sehen.
//
// Das File-Objekt darf NICHT durch reaktiven Alpine-State gereicht werden: ein
// Proxy bricht `File.arrayBuffer()` mit „Illegal invocation". Aufrufer lesen es
// direkt aus dem Input (Event bzw. x-ref) und geben es hier durch.

import { tRaw } from './i18n.js';

export const PDF_MIME = 'application/pdf';

/** Upload-Limit in Bytes (Server-Wert, Fallback nur bis /config geladen ist). */
export function pdfMaxBytes() {
  const v = Number(window.Alpine?.store('config')?.pdfMaxBytes);
  return v > 0 ? v : 25 * 1024 * 1024;
}

/** Vorpruefung im Browser. Rueckgabe: null (ok) oder eine fertige Meldung.
 *  Spart dem User den Upload, ersetzt aber nicht die Serverpruefung. */
export function checkPdfFile(file) {
  if (!file) return tRaw('error.NO_DOC');
  // Manche Systeme liefern keinen Typ mit — dann entscheidet der Server.
  if (file.type && file.type !== PDF_MIME) return tRaw('error.DOC_NOT_PDF');
  if (file.size > pdfMaxBytes()) {
    return tRaw('error.DOC_TOO_LARGE', { mb: Math.round(pdfMaxBytes() / (1024 * 1024)) });
  }
  return null;
}

/**
 * PDF an `url` posten (`?name=` wird angehaengt). Wirft mit uebersetzter
 * Meldung; der Aufrufer entscheidet, wo sie erscheint.
 * @returns {Promise<object>} die JSON-Antwort des Servers
 */
export async function uploadPdf(url, file, { method = 'POST' } = {}) {
  const buf = await file.arrayBuffer();
  const sep = url.includes('?') ? '&' : '?';
  const target = file.name ? `${url}${sep}name=${encodeURIComponent(file.name)}` : url;
  const r = await fetch(target, {
    method,
    headers: { 'Content-Type': PDF_MIME },
    body: new Uint8Array(buf),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(tRaw(`error.${d?.error_code || 'DOC_UNREADABLE'}`, {
      mb: Math.round(pdfMaxBytes() / (1024 * 1024)),
    }) || `HTTP ${r.status}`);
  }
  return r.json().catch(() => ({}));
}
