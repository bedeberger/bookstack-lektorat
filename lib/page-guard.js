'use strict';
// Der Eintritts-Guard jeder Route, die über eine `page_id` hereinkommt.
//
// Die Kette ist immer dieselbe und ihre REIHENFOLGE ist die eigentliche Aussage:
//
//   1. `page_id` validieren            → 400 PAGE_ID_REQUIRED
//   2. Buch AUS DER SEITE ableiten     → 404 PAGE_NOT_FOUND
//   3. Log-Context setzen              (damit der `book`-Slot im Log-Tag steht)
//   4. ACL gegen dieses Buch           → 403 (sendACLError)
//   5. optional: Buchtyp-Gate          → 400 NOT_JOURNALISTIC_BOOK
//
// **Das Buch kommt nie vom Client.** Ein Handler, der `req.body.book_id` glaubt
// und danach die Seite anfasst, prüft die ACL des falschen Buchs — der Aufrufer
// könnte sein eigenes Buch nennen und in einem fremden schreiben. Darum löst
// dieser Guard es aus der Seite auf, und darum gibt es ihn genau einmal: die
// Kette war fünfmal kopiert, und eine Kopie hatte das Buchtyp-Gate verloren.
//
// Der Guard ANTWORTET selbst. Rückgabe `null` heisst „Response ist raus, brich
// ab"; sonst kommen `pageId`, `bookId` und die bereits geladenen `settings`
// zurück (der häufigste nächste Schritt braucht sie ohnehin).

const { guardBook, sessionEmail } = require('./acl');
const { resolvePageBookId } = require('./content-ownership');
const { getBookSettings } = require('../db/schema');
const { isJournalisticBook } = require('./buchtyp');
const { toIntId } = require('./validate');

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object}  [opts]
 * @param {string}  [opts.minRole='editor']   Rolle für requireBookAccess
 * @param {boolean} [opts.journalistic=false] zusätzlich Buchtyp-Gate erzwingen
 * @param {string}  [opts.param='page_id']    Name des Routen-Parameters
 * @param {number}  [opts.pageId]             ID direkt (Body statt Routen-Param)
 * @returns {{pageId: number, bookId: number, settings: object|null}|null}
 */
function pageBookGuard(req, res, {
  minRole = 'editor', journalistic = false, param = 'page_id', pageId = null,
} = {}) {
  const pid = pageId != null ? toIntId(pageId) : toIntId(req.params?.[param]);
  if (!pid) { res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' }); return null; }

  const bookId = resolvePageBookId(pid);
  if (!bookId) { res.status(404).json({ error_code: 'PAGE_NOT_FOUND' }); return null; }
  // guardBook setzt den Log-Context mit und wirft Nicht-ACL-Fehler weiter,
  // statt sie als „erlaubt" zu deuten (Begründung in lib/acl.js).
  if (!guardBook(req, res, bookId, minRole)) return null;

  const settings = getBookSettings(bookId, sessionEmail(req));
  if (journalistic && !isJournalisticBook(settings)) {
    res.status(400).json({ error_code: 'NOT_JOURNALISTIC_BOOK' });
    return null;
  }
  return { pageId: pid, bookId, settings };
}

/**
 * Dasselbe für Routen, die auf BUCH-Ebene arbeiten und das Buch schon haben
 * (`aclParamGuard` hat dort bereits ACL und Log-Context erledigt). Bleibt nur
 * das Buchtyp-Gate — plus die Settings, die der Handler danach ohnehin liest.
 *
 * Liefert `null`, wenn das Buch nicht publizistisch ist; ob das ein Fehler ist
 * oder eine leere Antwort, entscheidet der Aufrufer. Die LESENDEN Routen des
 * redaktionellen Apparats antworten `enabled: false` statt mit einem Fehler:
 * die Karten fragen unabhängig vom Buchtyp und sollen nicht in einen Fehlerpfad
 * laufen, nur weil gerade ein Roman offen ist.
 */
function journalisticBookSettings(req, bookId) {
  const settings = getBookSettings(bookId, sessionEmail(req));
  return isJournalisticBook(settings) ? settings : null;
}

module.exports = { pageBookGuard, journalisticBookSettings };
