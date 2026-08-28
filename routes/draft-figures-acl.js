'use strict';
// Zugriffs-Vorspann der Figuren-Werkstatt. Ein Draft gehoert EINEM User
// (`draft_figures.user_email`) — anders als das Recherche-Board, das buchweit
// geteilt ist (routes/research-acl.js). Die Besitz-Achse ist darum die
// tragende Pruefung; die Buch-ACL kommt nur dort dazu, wo der Draft Kosten auf
// dem Buch verursacht (Start eines KI-Laufs, `minBookRole: 'editor'`).
//
// Eigenes Modul, weil zwei Router denselben Vorspann brauchen (CRUD + Jobs) und
// er dort achtmal wortgleich stand — inklusive einer Login-Pruefung, die
// `aclParamGuard` bzw. `guardBook` ohnehin macht, und eines handgeschriebenen
// ACL-Guards mit `require()` mitten im Handler.
//
// Beide Helfer ANTWORTEN SELBST und liefern dann `null`; der Aufrufer prueft nur
// auf null und kehrt zurueck (Muster `scopedItem` in routes/research-acl.js).
//
// Ein error_code pro Lage: `LOGIN_REQ` / `INVALID_ID` / `NOT_FOUND` /
// `FORBIDDEN`. Die Job-Routen hatten dafuer zweite Namen (`UNAUTHORIZED`,
// `DRAFT_NOT_FOUND`) — zwei Codes fuer dieselbe Lage, die kein Client las.
// Die Body-Validierung davor (`DRAFT_ID_REQUIRED`, `KNOTEN_ID_REQUIRED`) ist
// eine andere Frage und bleibt bei den Job-Routen.

const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { getDraftFigure, getWerkstattRun } = require('../db/draft-figures');

/** Werkstatt-Draft samt Besitz-Pruefung. `rawId` kommt aus Param ODER Body.
 *  `minBookRole` schaltet zusaetzlich die Buch-ACL davor (Schreibwege).
 *  Liefert den Draft oder null. */
function scopedDraft(req, res, rawId, { minBookRole = null } = {}) {
  const userEmail = sessionEmail(req);
  if (!userEmail) { res.status(401).json({ error_code: 'LOGIN_REQ' }); return null; }
  const id = toIntId(rawId);
  if (!id) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  const draft = getDraftFigure(id);
  if (!draft) { res.status(404).json({ error_code: 'NOT_FOUND' }); return null; }
  if (draft.user_email !== userEmail) { res.status(403).json({ error_code: 'FORBIDDEN' }); return null; }
  if (minBookRole && !guardBook(req, res, draft.book_id, minBookRole)) return null;
  return draft;
}

/** Einzelner KI-Lauf aus `:run_id` samt Besitz-Pruefung. Liefert den Lauf oder
 *  null. Trennt bewusst 404 von 403: ein owner-skopiertes DELETE alleine kann
 *  „gibt es nicht" und „gehoert dir nicht" nicht unterscheiden. */
function scopedRun(req, res, rawId) {
  const userEmail = sessionEmail(req);
  if (!userEmail) { res.status(401).json({ error_code: 'LOGIN_REQ' }); return null; }
  const id = toIntId(rawId);
  if (!id) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  const run = getWerkstattRun(id);
  if (!run) { res.status(404).json({ error_code: 'NOT_FOUND' }); return null; }
  if (run.user_email !== userEmail) { res.status(403).json({ error_code: 'FORBIDDEN' }); return null; }
  return run;
}

module.exports = { scopedDraft, scopedRun };
