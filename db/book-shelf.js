'use strict';
// Buecherregal: die persoenliche Ordnungsschicht auf dem Buchbestand
// (Anheften/Archivieren) plus die Kennzahlen, aus denen die Karte „Meine
// Buecher" ihre Zeilen baut.
//
// Zwei Dinge, die dieses Modul bewusst NICHT tut:
//   1. Es liest keine Buch-/Seiten-/Kapitelnamen. Die Karte hat die Buchliste
//      schon (Root-State aus `/content/books`) und joint im Frontend ueber
//      `book_id` — dieselbe Konvention wie `/me/profile-stats`. Damit bleibt der
//      Content-Store der einzige Eintrittspunkt fuer Buchinhalte.
//   2. Es kennt kein „fertig". Das ist `book_settings.is_finished` und gilt
//      buchweit (es geht in die Prompts); die Karte schreibt diesen bestehenden
//      Schalter ueber `/booksettings` statt eines eigenen.
//
// Alle Kennzahlen kommen aus Aggregat-/Cache-/Log-Tabellen (`page_stats`,
// `book_stats_history`, `writing_time`, `lektorat_time`, `share_*`,
// `book_snapshots`, `job_runs`) — kein Zugriff auf `pages`/`chapters`/`books`
// ausser der Buch-ID selbst.

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { requireUserEmail } = require('./write-helpers');

// Export-Job-Typen, die als „Export" zaehlen. Der synchrone Weg
// (`GET /export/:scope/:id/:fmt` fuer HTML/MD/TXT/EPUB) wird nirgends
// protokolliert und kann darum nicht mitgezaehlt werden — die Zahl ist
// ausdruecklich „Export-LAEUFE (PDF/EPUB/Word)", nicht „Downloads".
const EXPORT_JOB_TYPES = ['pdf-export', 'epub-export', 'docx-export'];

/* ------------------------------------------------------------------ Regal */

const _stmtShelf = db.prepare(`
  SELECT book_id, pinned_at, archived_at, last_opened_at, updated_at
    FROM book_shelf WHERE user_email = ? COLLATE NOCASE
`);

/** Regal-Zeilen des Users als Map book_id → { pinnedAt, archivedAt, lastOpenedAt }. */
function shelfMap(userEmail) {
  const email = userEmail == null ? '' : String(userEmail).trim();
  const out = new Map();
  if (!email) return out;
  for (const r of _stmtShelf.all(email)) {
    out.set(r.book_id, {
      pinnedAt: r.pinned_at || null,
      archivedAt: r.archived_at || null,
      lastOpenedAt: r.last_opened_at || null,
      updatedAt: r.updated_at || null,
    });
  }
  return out;
}

const _stmtSetShelf = db.prepare(`
  INSERT INTO book_shelf (book_id, user_email, pinned_at, archived_at, updated_at)
  VALUES (@book_id, @user_email, @pinned_at, @archived_at, ${NOW_ISO_SQL})
  ON CONFLICT(book_id, user_email) DO UPDATE SET
    pinned_at   = excluded.pinned_at,
    archived_at = excluded.archived_at,
    updated_at  = excluded.updated_at
`);

// Zeitstempel aus derselben Quelle wie die Spalten-Defaults (SSoT db/now.js).
const _stmtNow = db.prepare(`SELECT ${NOW_ISO_SQL} AS now`);

const _stmtGetOne = db.prepare(`
  SELECT pinned_at, archived_at FROM book_shelf
   WHERE book_id = ? AND user_email = ? COLLATE NOCASE
`);

/**
 * Regal-Zustand eines Buchs fuer einen User setzen. `pinned`/`archived` sind
 * Teil-Updates: was nicht uebergeben wird, bleibt stehen (die Karte schaltet
 * die beiden Achsen unabhaengig). Zeitstempel statt Boolean, damit „seit wann
 * angeheftet" sortierbar ist — die Reihenfolge im Regal ist sonst willkuerlich.
 */
function setShelf(bookId, userEmail, { pinned, archived } = {}) {
  const email = requireUserEmail(userEmail, 'book-shelf.setShelf');
  const id = parseInt(bookId, 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error('book-shelf.setShelf: book_id ungueltig.');
  const cur = _stmtGetOne.get(id, email) || { pinned_at: null, archived_at: null };
  const now = _stmtNow.get().now;
  const pinnedAt = pinned === undefined
    ? (cur.pinned_at || null)
    : (pinned ? (cur.pinned_at || now) : null);
  const archivedAt = archived === undefined
    ? (cur.archived_at || null)
    : (archived ? (cur.archived_at || now) : null);
  _stmtSetShelf.run({ book_id: id, user_email: email, pinned_at: pinnedAt, archived_at: archivedAt });
  return { book_id: id, pinned: !!pinnedAt, archived: !!archivedAt, pinned_at: pinnedAt, archived_at: archivedAt };
}

// Platzhalter-Liste fuer `IN (...)` — von der Regal-Abfrage und den
// Kennzahlen geteilt.
function _ph(n) { return new Array(n).fill('?').join(','); }

const _stmtTouchOpened = db.prepare(`
  INSERT INTO book_shelf (book_id, user_email, last_opened_at, updated_at)
  VALUES (@book_id, @user_email, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
  ON CONFLICT(book_id, user_email) DO UPDATE SET
    last_opened_at = excluded.last_opened_at,
    updated_at     = excluded.updated_at
`);

/**
 * „Dieses Buch hatte ich gerade vor mir." Setzt `last_opened_at` auf jetzt und
 * legt die Regal-Zeile an, falls es noch keine gibt.
 *
 * Die dritte persoenliche Achse neben Anheften und Archivieren — und die
 * einzige, die der Client selbsttaetig schreibt. Sie entscheidet, mit welchem
 * Buch die App beim Aufruf der Stamm-URL startet: die Antwort ist der groesste
 * Zeitstempel, nicht der letzte Schreiber. Das ist der Unterschied zu einem
 * lokalen Merker — localStorage ist browserweit und nicht pro Tab, dort gewann
 * bei mehreren offenen Tabs der zuletzt GELADENE.
 *
 * Beruehrt `pinned_at`/`archived_at` NICHT (und `setShelf` umgekehrt nicht
 * `last_opened_at`): die drei Achsen sind unabhaengig, ein Tab-Wechsel darf
 * kein Archiv aufheben.
 */
function touchOpened(bookId, userEmail) {
  const email = requireUserEmail(userEmail, 'book-shelf.touchOpened');
  const id = parseInt(bookId, 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error('book-shelf.touchOpened: book_id ungueltig.');
  _stmtTouchOpened.run({ book_id: id, user_email: email });
  return { book_id: id, last_opened_at: _stmtNow.get().now };
}

/**
 * Das Buch mit dem groessten `last_opened_at` — die Antwort auf „womit startet
 * die App". `allowedIds` ist die `book_access`-Grenze des Users (der Aufrufer
 * hat sie schon) und damit die ACL dieser Abfrage.
 *
 * Archivierte Buecher fallen HIER heraus, nicht erst beim Aufrufer: sonst
 * muesste der Client, wenn der Spitzenreiter archiviert ist, den zweitbesten
 * kennen — den er nicht hat. Ein Archiv ist die Aussage „raus aus meiner
 * Liste", und die Buchwahl-Combobox zeigt es ebenfalls nicht.
 *
 * Null, wenn der User noch nie ein Buch geoeffnet hat (oder nur archivierte) —
 * dann entscheidet der Client mit seinem lokalen Rueckfall.
 */
function lastOpenedBook(userEmail, allowedIds) {
  const email = userEmail == null ? '' : String(userEmail).trim();
  const ids = (Array.isArray(allowedIds) ? allowedIds : [])
    .map(v => parseInt(v, 10))
    .filter(v => Number.isInteger(v) && v > 0);
  if (!email || !ids.length) return null;
  const row = db.prepare(`
    SELECT book_id, last_opened_at
      FROM book_shelf
     WHERE user_email = ? COLLATE NOCASE
       AND last_opened_at IS NOT NULL
       AND archived_at IS NULL
       AND book_id IN (${_ph(ids.length)})
     ORDER BY last_opened_at DESC
     LIMIT 1
  `).get(email, ...ids);
  return row ? { book_id: row.book_id, last_opened_at: row.last_opened_at } : null;
}

/* -------------------------------------------------------------- Kennzahlen */

/**
 * Kennzahlen je Buch fuer die Regal-Karte.
 *
 * `bookIds` ist die Liste der fuer den User via `book_access` sichtbaren
 * Buecher — der Aufrufer hat sie schon und sie ist die ACL-Grenze dieser
 * Abfrage. Leere Liste → leere Map (kein SQL mit leerem IN).
 *
 * Zwei Achsen mit Absicht getrennt: buchweite Zahlen (Umfang, Fassungen,
 * Exporte, Share-Links) gelten fuer alle Beteiligten gleich; `writing_seconds`
 * und `lektorat_seconds` sind die des ANFRAGENDEN Users. Share-Kennzahlen
 * haengen an `share_links.owner_email` — ein Lektor sieht die Links des Autors
 * nicht, und genau das ist richtig.
 */
function metricsForBooks(userEmail, bookIds) {
  const email = userEmail == null ? '' : String(userEmail).trim();
  const ids = (Array.isArray(bookIds) ? bookIds : [])
    .map(v => parseInt(v, 10))
    .filter(v => Number.isInteger(v) && v > 0);
  const out = new Map();
  if (!ids.length || !email) return out;
  const ph = _ph(ids.length);

  const base = () => ({
    chars: 0, words: 0, pages: 0, chapters: 0,
    writing_seconds: 0, lektorat_seconds: 0,
    share_links: 0, share_links_active: 0, share_views: 0,
    comments: 0, comments_unread: 0,
    snapshots: 0, snapshot_last_at: null,
    exports: 0, export_last_at: null,
    findings: 0, pages_checked: 0,
    last_activity_at: null,
  });
  for (const id of ids) out.set(id, { book_id: id, ...base() });
  const row = (id) => out.get(id);

  // Umfang live aus page_stats (frischer als der Tages-Snapshot).
  for (const r of db.prepare(`
    SELECT book_id,
           COALESCE(SUM(chars), 0) AS chars,
           COALESCE(SUM(words), 0) AS words,
           COUNT(*)                AS pages
      FROM page_stats WHERE book_id IN (${ph}) GROUP BY book_id
  `).all(...ids)) {
    const t = row(r.book_id); if (t) { t.chars = r.chars; t.words = r.words; t.pages = r.pages; }
  }

  // Kapitelzahl aus dem jeweils juengsten Tages-Snapshot des Buchs.
  for (const r of db.prepare(`
    SELECT bsh.book_id, COALESCE(bsh.chapter_count, 0) AS chapters
      FROM book_stats_history bsh
      JOIN (SELECT book_id, MAX(recorded_at) AS mx
              FROM book_stats_history WHERE book_id IN (${ph}) GROUP BY book_id) m
        ON m.book_id = bsh.book_id AND m.mx = bsh.recorded_at
  `).all(...ids)) {
    const t = row(r.book_id); if (t) t.chapters = r.chapters;
  }

  for (const r of db.prepare(`
    SELECT book_id, COALESCE(SUM(seconds), 0) AS s
      FROM writing_time WHERE user_email = ? COLLATE NOCASE AND book_id IN (${ph})
     GROUP BY book_id
  `).all(email, ...ids)) {
    const t = row(r.book_id); if (t) t.writing_seconds = r.s;
  }

  for (const r of db.prepare(`
    SELECT book_id, COALESCE(SUM(seconds), 0) AS s
      FROM lektorat_time WHERE user_email = ? COLLATE NOCASE AND book_id IN (${ph})
     GROUP BY book_id
  `).all(email, ...ids)) {
    const t = row(r.book_id); if (t) t.lektorat_seconds = r.s;
  }

  // Share-Links des Users + deren Reichweite und Rueckmeldungen. `unread`
  // folgt derselben Definition wie die Share-Karte: Leser-Kommentar (kein
  // eigener) neuer als `owner_last_seen_at`.
  for (const r of db.prepare(`
    SELECT sl.book_id,
           COUNT(*) AS links,
           COALESCE(SUM(CASE WHEN sl.revoked_at IS NULL
                              AND (sl.expires_at IS NULL
                                   OR datetime(sl.expires_at) > datetime('now'))
                             THEN 1 ELSE 0 END), 0) AS links_active,
           COALESCE(SUM(sl.view_count), 0) AS views,
           COALESCE(SUM((SELECT COUNT(*) FROM share_comments sc
                          WHERE sc.share_token = sl.token)), 0) AS comments,
           COALESCE(SUM((SELECT COUNT(*) FROM share_comments sc
                          WHERE sc.share_token = sl.token
                            AND sc.author_email IS NULL
                            AND (sl.owner_last_seen_at IS NULL
                                 OR sc.created_at > sl.owner_last_seen_at))), 0) AS unread
      FROM share_links sl
     WHERE sl.owner_email = ? COLLATE NOCASE AND sl.book_id IN (${ph})
     GROUP BY sl.book_id
  `).all(email, ...ids)) {
    const t = row(r.book_id);
    if (t) {
      t.share_links = r.links;
      t.share_links_active = r.links_active;
      t.share_views = r.views;
      t.comments = r.comments;
      t.comments_unread = r.unread;
    }
  }

  for (const r of db.prepare(`
    SELECT book_id, COUNT(*) AS n, MAX(created_at) AS last_at
      FROM book_snapshots WHERE book_id IN (${ph}) GROUP BY book_id
  `).all(...ids)) {
    const t = row(r.book_id); if (t) { t.snapshots = r.n; t.snapshot_last_at = r.last_at || null; }
  }

  // Exporte: erfolgreich beendete Export-Jobs. `job_runs.book_id` ist
  // ON DELETE SET NULL — ein Lauf ohne Buch faellt hier ohnehin aus dem IN.
  for (const r of db.prepare(`
    SELECT book_id, COUNT(*) AS n, MAX(ended_at) AS last_at
      FROM job_runs
     WHERE book_id IN (${ph}) AND status = 'done'
       AND type IN (${_ph(EXPORT_JOB_TYPES.length)})
     GROUP BY book_id
  `).all(...ids, ...EXPORT_JOB_TYPES)) {
    const t = row(r.book_id); if (t) { t.exports = r.n; t.export_last_at = r.last_at || null; }
  }

  // Offene Lektorats-Befunde: Summe der Fundstellen aus dem JEWEILS juengsten
  // page_checks-Eintrag pro Seite (= aktueller Stand), gleiche Konvention wie
  // /me/profile-stats.
  for (const r of db.prepare(`
    SELECT pc.book_id, COUNT(*) AS pages_checked,
           COALESCE(SUM(pc.error_count), 0) AS findings
      FROM page_checks pc
      JOIN (SELECT page_id, MAX(checked_at) AS mx
              FROM page_checks WHERE book_id IN (${ph}) GROUP BY page_id) m
        ON m.page_id = pc.page_id AND m.mx = pc.checked_at
     WHERE pc.book_id IN (${ph})
     GROUP BY pc.book_id
  `).all(...ids, ...ids)) {
    const t = row(r.book_id); if (t) { t.findings = r.findings; t.pages_checked = r.pages_checked; }
  }

  // Letzte eigene Schreib-/Lektoratsaktivitaet (Datumsgranularitaet, wie die
  // Zeit-Tracker sie fuehren). Bewusst NICHT `books.updated_at`: das bewegt
  // auch ein fremder Schreiber, und die Spalte gehoert dem Content-Store.
  for (const r of db.prepare(`
    SELECT book_id, MAX(date) AS d FROM (
      SELECT book_id, date FROM writing_time  WHERE user_email = ? COLLATE NOCASE AND book_id IN (${ph})
      UNION ALL
      SELECT book_id, date FROM lektorat_time WHERE user_email = ? COLLATE NOCASE AND book_id IN (${ph})
    ) GROUP BY book_id
  `).all(email, ...ids, email, ...ids)) {
    const t = row(r.book_id); if (t) t.last_activity_at = r.d || null;
  }

  return out;
}

module.exports = {
  EXPORT_JOB_TYPES,
  shelfMap,
  setShelf,
  touchOpened,
  lastOpenedBook,
  metricsForBooks,
};
