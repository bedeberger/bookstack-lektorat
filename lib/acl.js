'use strict';
// Guard-Middleware fuer alle book-scoped Routen. Eine zentrale Stelle, die `book_access` liest und
// 403 wirft, wenn die Buch-Rolle des Session-Users unter `minRole` liegt.
// Hierarchie: owner > editor > lektor > viewer (siehe db/book-access.js).
//
// Zwei Verwendungsformen:
//   1) URL-Param-Routes: router.param('book_id', aclParamGuard('viewer'))
//      laeuft AUTOMATISCH vor jedem :book_id-Handler. Setzt zusätzlich
//      `req.bookRole`.
//   2) Body/Query-Routes: requireBookAccess(req, bookId, minRole) im Handler
//      nach toIntId-Validierung aufrufen. Wirft ACLError.
//
// Admins der globalen Rolle haben KEINE impliziten Buchrechte — sonst Bruch
// der Privacy-Boundary (siehe Phase-4a-Plan). Wer Admin ist und auf Buch X
// zugreifen will, braucht eine explizite book_access-Row.

const { getBookRole, hasMinRole } = require('../db/book-access');
const { setContext } = require('./log-context');
const logger = require('../logger');

class ACLError extends Error {
  constructor(code, status = 403, detail = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function _userEmail(req) {
  return req?.session?.user?.email || null;
}

// Resolved gegen book_access. Liefert die Rolle (Role-String) oder null.
function resolveBookRole(req, bookId) {
  const email = _userEmail(req);
  if (!email) return null;
  return getBookRole(bookId, email);
}

// Pruefroutine fuer Handler-Code (Body/Query-Routes). Wirft ACLError, sonst
// liefert die effektive Rolle zurueck.
function requireBookAccess(req, bookId, minRole = 'viewer') {
  if (!_userEmail(req)) throw new ACLError('NOT_LOGGED_IN', 401);
  const id = parseInt(bookId, 10);
  if (!Number.isInteger(id) || id <= 0) throw new ACLError('INVALID_BOOK_ID', 400);
  const role = resolveBookRole(req, id);
  if (!role) throw new ACLError('NO_BOOK_ACCESS', 403);
  if (!hasMinRole(role, minRole)) {
    throw new ACLError('INSUFFICIENT_ROLE', 403, { actual: role, required: minRole });
  }
  req.bookRole = role;
  return role;
}

// Guard-Factory fuer `:book_id`-Routes mit Mindestrolle. Funktioniert in
// beiden Kontexten:
//   - als Express-Middleware: `router.get('/x/:book_id', aclParamGuard('viewer'), …)`
//   - als Express-Param-Handler: `router.param('book_id', aclParamGuard('viewer'))`
// 3-arg-Signatur ist Pflicht — Express deutet 4-arg-Middleware als Error-Handler
// und ueberspringt sie im normalen Flow. `req.params.book_id` ist in beiden
// Kontexten bereits gesetzt, wenn dieser Handler laeuft.
// Setzt zugleich den ALS-Logging-Context (book), `req.bookId` und `req.bookRole`.
function aclParamGuard(minRole = 'viewer') {
  return function _aclParamHandler(req, res, next) {
    const raw = req.params?.book_id;
    const id = parseInt(raw, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
    }
    setContext({ book: id });
    if (!_userEmail(req)) {
      return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
    }
    try {
      const role = requireBookAccess(req, id, minRole);
      req.bookId = id;
      req.bookRole = role;
      next();
    } catch (e) {
      if (e instanceof ACLError) {
        logger.warn(`ACL-Guard verweigert: book=${id} user=${_userEmail(req)} minRole=${minRole} → ${e.code}`);
        return res.status(e.status).json({ error_code: e.code, ...(e.detail ? { detail: e.detail } : {}) });
      }
      throw e;
    }
  };
}

// Helper fuer 403-Response, wenn ACLError im Handler abgefangen wird.
function sendACLError(res, e) {
  if (e instanceof ACLError) {
    return res.status(e.status).json({ error_code: e.code, ...(e.detail ? { detail: e.detail } : {}) });
  }
  return null;
}

// Session-E-Mail des Requests (oder null). Einzige Quelle: die Frage wurde in
// jedem book-scoped Router einzeln beantwortet, mit vier wortgleichen Kopien.
function sessionEmail(req) {
  return _userEmail(req);
}

/** Buch-Guard fuer Body-/Query-Routen als Praedikat: `true` = weiter,
 *  `false` = die 401/403-Antwort ist bereits raus.
 *
 *  Ein Nicht-ACL-Fehler wird WEITERGEWORFEN, nicht als „erlaubt" gedeutet:
 *  `sendACLError` liefert dafuer `null`, und ein `return !sendACLError(...)`
 *  macht daraus ein `true` — der Handler laeuft dann ohne Rechtepruefung
 *  weiter und der eigentliche Fehler (z.B. ein DB-Fehler beim Rollen-Lookup)
 *  verschwindet still. Setzt zugleich den ALS-Logging-Context (book). */
function guardBook(req, res, bookId, minRole = 'viewer') {
  setContext({ book: bookId });
  try {
    requireBookAccess(req, bookId, minRole);
    return true;
  } catch (e) {
    if (sendACLError(res, e)) return false;
    throw e;
  }
}

// Helper: load the role for a body-supplied book_id (POST-Routen mit
// {book_id} im Body), wirft ACLError. Verwendung im Job-Router & Co.
function requireBookAccessFromBody(req, minRole = 'viewer', field = 'book_id') {
  const raw = req.body?.[field];
  return requireBookAccess(req, raw, minRole);
}

module.exports = {
  ACLError,
  aclParamGuard,
  guardBook,
  requireBookAccess,
  requireBookAccessFromBody,
  resolveBookRole,
  sendACLError,
  sessionEmail,
};
