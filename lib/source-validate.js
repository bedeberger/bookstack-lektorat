'use strict';
// Eingangspruefung fuer Quellen-Bodys, geteilt von routes/sources.js und
// routes/capture.js.
//
// Warum vor der DB-Schicht: `db/sources.js#_values` waehlt bei einem Fremdwert
// stillschweigend den Default (csl_type → 'book'). Fuer die API ist ein 400 die
// ehrlichere Antwort — sonst speichert ein Client scheinbar erfolgreich einen
// Typ, den er nie zurueckbekommt.

const { CSL_TYPES } = require('../db/sources');

/** Feldpruefung. Gibt `null` (ok) oder den Fehler-Body zurueck. */
function validateSourceBody(body) {
  if (body.csl_type !== undefined && !CSL_TYPES.includes(String(body.csl_type))) {
    return { error_code: 'INVALID_VALUE', params: { field: 'csl_type', allowed: CSL_TYPES.join(', ') } };
  }
  for (const key of ['authors', 'editors']) {
    if (body[key] !== undefined && body[key] !== null && !Array.isArray(body[key])) {
      return { error_code: 'INVALID_VALUE', params: { field: key, allowed: 'array' } };
    }
  }
  if (body.url) {
    const u = String(body.url).trim();
    if (u && !/^https?:\/\//i.test(u)) return { error_code: 'INVALID_URL' };
  }
  return null;
}

/** Eine Quelle braucht mindestens einen Titel oder eine Person — sonst entsteht
 *  ein Verzeichniseintrag, der nichts benennt. */
function hasSourceIdentity(src) {
  if (src.title && String(src.title).trim()) return true;
  const persons = [...(src.authors || []), ...(src.editors || [])];
  return persons.some(p => p && (p.family || p.literal || typeof p === 'string'));
}

module.exports = { validateSourceBody, hasSourceIdentity };
