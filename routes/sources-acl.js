'use strict';
// Zugriffsentscheidungen der Quellen-Bibliothek — zwei Achsen, bewusst getrennt
// (ausfuehrlich in routes/sources.js und docs/quellen.md):
//
//   BESITZ (owner_email)  Anlegen, Aendern, Loeschen im Pool, PDF anhaengen.
//                         Nur der Besitzer: die Quelle liegt in seinen anderen
//                         Arbeiten mit drin.
//   BUCH-ACL              Lesen (ab 'viewer' — auch ein Lektor muss den
//                         Quellen-Marker im Text aufloesen koennen).
//
// Eigenes Modul, weil zwei Router sie brauchen (CRUD + PDF-Anhang) und eine
// kopierte ACL-Pruefung die gefaehrlichste Art von Duplikat ist: sie faellt
// nicht auf, wenn nur eine der beiden Kopien nachgezogen wird.

const { listSourceBooks } = require('../db/schema');
const { hasMinRole } = require('../db/book-access');
const { resolveBookRole } = require('../lib/acl');

function userEmail(req) {
  return req.session?.user?.email || null;
}

/** Darf der User die Quelle sehen? Besitzer immer; sonst reicht Leserecht auf
 *  irgendeinem Buch, dem die Quelle zugeordnet ist — dort steht ihr Marker im
 *  Text und muss aufloesbar sein. */
function canRead(req, src) {
  const email = userEmail(req);
  if (!email) return false;
  if (src.owner_email === email) return true;
  return canReadById(req, src.id);
}

/** Wie `canRead`, aber nur mit Id + Besitzer — fuer Pfade, die keine volle
 *  Quelle geladen haben (der Download arbeitet bewusst auf der Meta-Zeile,
 *  damit ein 403 nicht erst den BLOB durch den Prozess zieht). */
function canReadById(req, sourceId) {
  return listSourceBooks(sourceId)
    .some(b => hasMinRole(resolveBookRole(req, b.book_id) || '', 'viewer'));
}

function isOwner(req, src) {
  const email = userEmail(req);
  return !!email && src.owner_email === email;
}

module.exports = { userEmail, canRead, canReadById, isOwner };
