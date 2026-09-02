'use strict';
// Buecherregal des Users („Meine Buecher"): Uebersicht ueber ALLE fuer ihn
// sichtbaren Buecher mit Kennzahlen, plus die drei persoenlichen Achsen
// Anheften, Archivieren und „zuletzt offen gehabt".
//
// Eigener Router statt weiterer Routen in routes/usersettings.js: die Datei ist
// bereits eine LOC-Altlast (Ratsche in tests/unit/loc-limits.test.mjs) und darf
// nicht wachsen. Mount-Punkt `/me/books` — user-bound wie `/me/profile-stats`,
// nicht buch-bound.
//
// Was hier NICHT liegt:
//   • „fertig" — das ist `book_settings.is_finished` (buchweit, geht in die
//     Prompts) und wird ueber `PUT /booksettings/:book_id/finished` geschaltet.
//     Die Karte liest den Wert hier mit, schreibt ihn aber dort.
//   • Buchnamen — die hat das Frontend aus `/content/books` und joint ueber
//     `book_id` (Content-Store-Regel, gleiche Konvention wie /me/profile-stats).

const express = require('express');
const bookShelf = require('../db/book-shelf');
const bookAccess = require('../db/book-access');
const { db } = require('../db/connection');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json({ limit: '8kb' });

router.param('book_id', bookParamHandler);

/**
 * GET /me/books — Regal-Zeilen des Users.
 *
 * Sichtbarkeit ist `book_access` (dieselbe Grenze wie `/content/books`), nicht
 * Eigentuemerschaft: ein Buch, an dem man als Lektor mitarbeitet, gehoert ins
 * eigene Regal — sonst kann man es nicht archivieren, und genau das will man
 * bei fremden Buechern, mit denen man fertig ist.
 */
router.get('/', (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  try {
    const accessRows = bookAccess.listBookIdsForUser(email);
    const ids = accessRows.map(r => r.book_id);
    if (!ids.length) {
      return res.json({ books: [], exportTypes: bookShelf.EXPORT_JOB_TYPES });
    }
    const roleByBook = new Map(accessRows.map(r => [r.book_id, r.role]));
    const shelf = bookShelf.shelfMap(email);
    const metrics = bookShelf.metricsForBooks(email, ids);
    // is_finished + Zielwerte kommen aus book_settings (Settings, kein
    // Buchinhalt). Fehlt die Zeile, gilt der Default 0 wie ueberall sonst.
    const ph = ids.map(() => '?').join(',');
    const settings = new Map(
      db.prepare(`
        SELECT book_id, is_finished, exclude_from_stats, goal_target_chars, goal_deadline
          FROM book_settings WHERE book_id IN (${ph})
      `).all(...ids).map(r => [r.book_id, r])
    );
    const books = ids.map((id) => {
      const sh = shelf.get(id) || {};
      const st = settings.get(id) || {};
      return {
        ...(metrics.get(id) || { book_id: id }),
        role: roleByBook.get(id) || null,
        pinned: !!sh.pinnedAt,
        archived: !!sh.archivedAt,
        pinned_at: sh.pinnedAt || null,
        archived_at: sh.archivedAt || null,
        last_opened_at: sh.lastOpenedAt || null,
        is_finished: st.is_finished ? 1 : 0,
        exclude_from_stats: st.exclude_from_stats ? 1 : 0,
        goal_target_chars: st.goal_target_chars ?? null,
        goal_deadline: st.goal_deadline ?? null,
      };
    });
    res.json({ books, exportTypes: bookShelf.EXPORT_JOB_TYPES });
  } catch (e) {
    logger.error('[me/books] DB-Fehler: ' + e.message, { user: email });
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

/**
 * GET /me/books/last-opened — welches Buch hatte der User zuletzt vor sich.
 * `{ book_id, last_opened_at }` bzw. `{ book_id: null }`, wenn noch keines.
 *
 * Der Boot waehlt daraus sein Startbuch. Eigener, schlanker Endpunkt und NICHT
 * ein Feld an `GET /content/books`: die Buchliste liefert der Service Worker
 * als Stale-While-Revalidate (das ist ihr Zweck — die Sidebar steht sofort und
 * auch offline), und aus einer alten Kopie gelesen waere der Zeitstempel genau
 * der Stand des letzten Besuchs. Diese Antwort darf nicht stale sein.
 *
 * Auch nicht Teil von `GET /me/books`: das ist die Kennzahlen-Antwort der
 * Regal-Karte (ein Dutzend Aggregate ueber alle Buecher) und viel zu teuer fuer
 * den kritischen Boot-Pfad.
 */
router.get('/last-opened', (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  // Explizit unkacheln. Der Service Worker beruehrt `/me/*` ohnehin nicht (er
  // behandelt nur `/config`, `/content/*` und Shell-Assets), aber die Aussage
  // dieses Endpunkts ist „Stand JETZT" — eine aus einem Zwischenspeicher
  // beantwortete Anfrage waere wieder der Stand des letzten Besuchs.
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const ids = bookAccess.listBookIdsForUser(email).map(r => r.book_id);
    const row = bookShelf.lastOpenedBook(email, ids);
    res.json(row || { book_id: null, last_opened_at: null });
  } catch (e) {
    logger.error('[me/books/last-opened] DB-Fehler: ' + e.message, { user: email });
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

/**
 * PUT /me/books/:book_id — Regal-Zustand setzen. Teil-Update: nur uebergebene
 * Achsen aendern sich.
 *
 * Rolle `viewer` genuegt. Der Eintrag sagt nichts ueber das Buch, sondern ueber
 * die eigene Liste — wer ein Buch sehen darf, darf es auch anheften.
 */
router.put('/:book_id', jsonBody, (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  const b = req.body || {};
  if (b.pinned === undefined && b.archived === undefined) {
    return res.status(400).json({ error_code: 'NOTHING_TO_UPDATE' });
  }
  try {
    const next = bookShelf.setShelf(bookId, sessionEmail(req), {
      pinned:   b.pinned   === undefined ? undefined : !!b.pinned,
      archived: b.archived === undefined ? undefined : !!b.archived,
    });
    res.json({ ok: true, ...next });
  } catch (e) {
    logger.error(`[me/books] Regal-Write fehlgeschlagen (book=${bookId}): ${e.message}`);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

/**
 * PUT /me/books/:book_id/opened — „ich habe dieses Buch gerade vor mir".
 * Setzt `book_shelf.last_opened_at` auf jetzt.
 *
 * Der Startpunkt der App beim Aufruf der Stamm-URL ist das Buch mit dem
 * groessten dieser Zeitstempel. Bewusst eine EIGENE Route neben `PUT
 * /:book_id`: das dortige `NOTHING_TO_UPDATE` verlangt eine Achse im Body, und
 * die Aussage hier ist keine Regal-Aenderung, die der User trifft, sondern eine
 * Messung, die der Client nebenbei meldet. Kein Body, damit sie sich nicht
 * versehentlich mit Anheften/Archivieren vermischt.
 *
 * Rolle `viewer` wie die uebrigen Regal-Achsen — die Zeile sagt etwas ueber die
 * eigene Liste, nicht ueber das Buch. Der Client ruft das gedrosselt (Buchwahl,
 * Seitenoeffnung, Sichtbarwerden des Tabs); der Aufruf ist idempotent.
 */
router.put('/:book_id/opened', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  try {
    const next = bookShelf.touchOpened(bookId, sessionEmail(req));
    res.json({ ok: true, ...next });
  } catch (e) {
    logger.error(`[me/books] Opened-Write fehlgeschlagen (book=${bookId}): ${e.message}`);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

module.exports = router;
