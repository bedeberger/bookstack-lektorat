'use strict';
// Zugriffs-Vorspann der Recherche-Wege. Das Board ist buchweit GETEILT: es gibt
// keine Besitz-Achse wie bei der Quellen-Bibliothek (routes/sources-acl.js),
// alles haengt allein an der Buch-ACL. `user_email` am Fundstueck ist
// Ersteller-Attribution, kein Sichtbarkeits-Scope.
//
// Eigenes Modul, weil drei Router denselben Vorspann brauchen (CRUD, Medien,
// Interview) und er dort achtmal wortgleich stand — inklusive einer
// 401-Pruefung, die der Buch-Guard ohnehin macht.
//
// Beide Helfer ANTWORTEN SELBST und liefern dann `null`; der Aufrufer prueft nur
// auf null und kehrt zurueck (Muster `_ownedSource` in routes/sources-doc.js).

const { toIntId } = require('../lib/validate');
const { guardBook } = require('../lib/acl');
const { itemBookId } = require('../db/research-items');

/** Buch-Scope aus `?book_id=` samt ACL. Liefert die Buch-Id oder null. */
function bookScope(req, res, minRole = 'editor') {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  if (!guardBook(req, res, bookId, minRole)) return null;
  return bookId;
}

/** Fundstueck aus `:id` samt Buch-ACL. Liefert `{ id, bookId }` oder null.
 *
 *  Die ACL laeuft VOR jeder inhaltlichen Pruefung des Aufrufers (etwa „hat das
 *  Fundstueck ueberhaupt ein Bild"): sonst beantwortet der Server einem
 *  Unberechtigten erst die Bestandsfrage und verweigert danach den Zugriff. */
function scopedItem(req, res, minRole = 'editor') {
  const id = toIntId(req.params.id);
  if (!id) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  const bookId = itemBookId(id);
  if (!bookId) { res.status(404).json({ error_code: 'ITEM_NOT_FOUND' }); return null; }
  if (!guardBook(req, res, bookId, minRole)) return null;
  return { id, bookId };
}

module.exports = { bookScope, scopedItem };
