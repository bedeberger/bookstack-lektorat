'use strict';
// Die drei Heartbeat-Zaehler als HTTP-Schicht: Schreibzeit, Diktat (STT),
// Lektoratszeit. Je Tracker ein POST (Delta melden) und ein GET (Aggregat).
//
// Alle sechs Routen werden aus EINER Spec generiert — die Mechanik ist
// identisch, nur Umfang und Scope unterscheiden sich (siehe
// [db/time-tracking.js](../../db/time-tracking.js), dort liegt die
// Daten-Spec + der Clamp). Ein vierter Zaehler ist ein Eintrag in ROUTES,
// keine vierte Kopie.
//
// Zwei Dinge, die die Generierung bewusst NICHT vereinheitlicht:
//   - Der Antwort-Body des POST heisst pro Tracker anders (`added` vs.
//     `added_seconds`/`added_chars`) — das ist Client-Vertrag, kein Detail.
//   - Der Buch-Guard laeuft im POST ueber guardBook (Body-Route); die
//     `:book_id`-GETs deckt der router.param-Guard des Facade-Routers ab, dort
//     also KEIN zweiter Login-/ACL-Check (CLAUDE.md: keine zweite
//     Login-Pruefung vor dem Guard).

const { toIntId } = require('../../lib/validate');
const { localIsoDate, localHour } = require('../../lib/local-date');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { resolvePageBookId } = require('../../lib/content-ownership');
const timeTracking = require('../../db/time-tracking');
const { jsonBody } = require('./shared');

const ROUTES = [
  {
    kind: 'writing',
    path: 'writing-time',
    // Heartbeat des Frontends alle ~30 s, solange editMode || focusMode aktiv
    // und der Tab sichtbar ist.
    reply: (added) => ({ ok: true, added: added.seconds }),
  },
  {
    kind: 'stt',
    path: 'stt-time',
    // Heartbeat solange das Mikrofon aufnimmt und der Tab sichtbar ist. Buchweit
    // wie writing-time — STT laeuft nur im Notebook-Editor.
    extraFields: ['chars'],
    reply: (added) => ({ ok: true, added_seconds: added.seconds, added_chars: added.chars }),
  },
  {
    kind: 'lektorat',
    path: 'lektorat-time',
    // Heartbeat solange checkDone (Pruefmodus) aktiv und der Tab sichtbar ist.
    // Haengt an der Seite: page_id ist Pflicht und muss zum Buch passen.
    scope: 'page',
    reply: (added) => ({ ok: true, added: added.seconds }),
  },
];

function register(router) {
  for (const spec of ROUTES) {
    router.post(`/${spec.path}`, jsonBody, (req, res) => _post(spec, req, res));
    router.get(`/${spec.path}/:book_id`, (req, res) => _get(spec, req, res));
  }
}

function _post(spec, req, res) {
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });

  let scopeId = null;
  if (spec.scope === 'page') {
    scopeId = toIntId(req.body?.page_id);
    if (!scopeId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  }
  // Guard antwortet selbst mit 401/403 — davor keine eigene Login-Pruefung.
  if (!guardBook(req, res, bookId, 'viewer')) return;
  if (spec.scope === 'page' && resolvePageBookId(scopeId) !== bookId) {
    return res.status(400).json({ error_code: 'BOOK_MISMATCH' });
  }

  const seconds = timeTracking.clampDelta(req.body?.seconds);
  const extra = {};
  for (const f of spec.extraFields || []) extra[f] = req.body?.[f];

  // Nichts zu verbuchen: der Client darf leere Pings schicken (Tab-Wechsel),
  // das ist kein Fehler. Antwortform bleibt identisch, nur mit Nullen.
  const anyExtra = (spec.extraFields || []).some(f => timeTracking.clampDelta(extra[f], Infinity) > 0);
  if (seconds <= 0 && !anyExtra) {
    return res.json(spec.reply(Object.fromEntries(
      [['seconds', 0], ...(spec.extraFields || []).map(f => [f, 0])],
    )));
  }

  const added = timeTracking.recordHeartbeat(spec.kind, {
    userEmail: sessionEmail(req),
    bookId,
    scopeId,
    date: localIsoDate(),
    hour: localHour(),
    seconds,
    extra,
  });
  res.json(spec.reply(added));
}

// ACL + Login sind hier bereits durch den router.param-Guard des Facade-Routers
// erledigt (viewer+), `req.bookId` ist gesetzt.
function _get(spec, req, res) {
  res.json(timeTracking.readSummary(spec.kind, {
    userEmail: sessionEmail(req),
    bookId: req.bookId,
  }));
}

module.exports = { register, ROUTES };
