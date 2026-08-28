'use strict';
// Buecherregal (db/book-shelf.js): die zwei persoenlichen Achsen + die
// Kennzahlen-Aggregation. Zwei Eigenschaften sind hier die eigentlichen
// Testgegenstaende:
//   1. `setShelf` ist ein TEIL-Update — eine Achse zu schalten darf die andere
//      nicht loeschen (die Karte hat zwei unabhaengige Knoepfe pro Zeile).
//   2. Die Kennzahlen sind zweiachsig skopiert: Umfang/Fassungen/Exporte gelten
//      buchweit, Schreibzeit und Share-/Kommentarzahlen gehoeren dem
//      anfragenden User. Ein Lektor darf die Share-Links des Autors nicht sehen.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tmp = path.join('/tmp', `book-shelf-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const { db } = require('../../db/connection');
const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const bookShelf = require('../../db/book-shelf');

const AUTOR = 'autor@x.test';
const LEKTOR = 'lektor@x.test';
const BOOK = 501;
const BOOK2 = 502;

function seed() {
  appUsers.createUser({ email: AUTOR, displayName: 'Autor' });
  appUsers.createUser({ email: LEKTOR, displayName: 'Lektor' });
  schema.upsertBookByName(BOOK, 'Regal-Buch');
  schema.upsertBookByName(BOOK2, 'Zweites Buch');
}

test('setShelf: die zwei Achsen sind unabhaengig, Zeitstempel bleibt stabil', () => {
  seed();
  assert.equal(bookShelf.shelfMap(AUTOR).size, 0);

  const pinned = bookShelf.setShelf(BOOK, AUTOR, { pinned: true });
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.archived, false);
  assert.ok(pinned.pinned_at, 'pinned_at gesetzt');

  // Archivieren darf den Pin nicht abwerfen ...
  const both = bookShelf.setShelf(BOOK, AUTOR, { archived: true });
  assert.equal(both.pinned, true);
  assert.equal(both.archived, true);
  // ... und den Pin-Zeitstempel nicht neu setzen (Regal-Reihenfolge = seit wann).
  assert.equal(both.pinned_at, pinned.pinned_at);

  const unpinned = bookShelf.setShelf(BOOK, AUTOR, { pinned: false });
  assert.equal(unpinned.pinned, false);
  assert.equal(unpinned.pinned_at, null);
  assert.equal(unpinned.archived, true, 'Archiv-Zustand ueberlebt das Loesen des Pins');

  // Das Regal ist pro User: der Lektor sieht davon nichts.
  assert.equal(bookShelf.shelfMap(LEKTOR).size, 0);
  const mine = bookShelf.shelfMap(AUTOR);
  assert.equal(mine.get(BOOK).archivedAt !== null, true);
  assert.equal(mine.get(BOOK).pinnedAt, null);
});

test('setShelf: Schreibzugriff ohne User-Kontext bricht ab', () => {
  assert.throws(() => bookShelf.setShelf(BOOK, '', { pinned: true }), /user_email fehlt/);
  assert.throws(() => bookShelf.setShelf(0, AUTOR, { pinned: true }), /book_id ungueltig/);
});

test('metricsForBooks: buchweite Zahlen vs. eigene Zahlen', () => {
  // Seiten als FK-Anker fuer page_stats/lektorat_time.
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name) VALUES (9001, ?, 'S1'), (9002, ?, 'S2')`)
    .run(BOOK, BOOK);
  // Umfang (buchweit).
  db.prepare(`INSERT INTO page_stats (page_id, book_id, chars, words, tok)
              VALUES (9001, ?, 1200, 200, 300), (9002, ?, 800, 130, 200)`).run(BOOK, BOOK);
  // Schreibzeit: beide User am selben Buch.
  db.prepare(`INSERT INTO writing_time (user_email, book_id, date, seconds)
              VALUES (?, ?, '2026-08-01', 600), (?, ?, '2026-08-02', 90)`)
    .run(AUTOR, BOOK, LEKTOR, BOOK);
  db.prepare(`INSERT INTO lektorat_time (user_email, book_id, page_id, date, seconds)
              VALUES (?, ?, 9001, '2026-08-03', 45)`).run(LEKTOR, BOOK);
  // Share-Link des Autors mit einem Leser-Kommentar (ungelesen) und einem
  // eigenen (zaehlt nie als ungelesen).
  db.prepare(`INSERT INTO share_links (token, kind, book_id, owner_email, view_count)
              VALUES ('tok-a', 'book', ?, ?, 7)`).run(BOOK, AUTOR);
  db.prepare(`INSERT INTO share_comments (share_token, reader_name, body, author_email)
              VALUES ('tok-a', 'Leserin', 'Schoen', NULL), ('tok-a', NULL, 'Danke', ?)`).run(AUTOR);
  // Fassung + erfolgreicher Export-Lauf + ein fehlgeschlagener (zaehlt nicht).
  db.prepare(`INSERT INTO book_snapshots (book_id, seq, content_json, created_at)
              VALUES (?, 1, '{}', '2026-08-04T10:00:00.000Z')`).run(BOOK);
  db.prepare(`INSERT INTO job_runs (job_id, type, book_id, user_email, status, queued_at, ended_at)
              VALUES ('j1', 'pdf-export', ?, ?, 'done',  '2026-08-05T10:00:00.000Z', '2026-08-05T10:01:00.000Z'),
                     ('j2', 'docx-export', ?, ?, 'error', '2026-08-06T10:00:00.000Z', '2026-08-06T10:01:00.000Z')`)
    .run(BOOK, AUTOR, BOOK, AUTOR);

  const mineAutor = bookShelf.metricsForBooks(AUTOR, [BOOK, BOOK2]).get(BOOK);
  assert.equal(mineAutor.chars, 2000);
  assert.equal(mineAutor.words, 330);
  assert.equal(mineAutor.pages, 2);
  assert.equal(mineAutor.writing_seconds, 600, 'nur die eigene Schreibzeit');
  assert.equal(mineAutor.lektorat_seconds, 0);
  assert.equal(mineAutor.share_links, 1);
  assert.equal(mineAutor.share_links_active, 1);
  assert.equal(mineAutor.share_views, 7);
  assert.equal(mineAutor.comments, 2);
  assert.equal(mineAutor.comments_unread, 1, 'eigener Kommentar zaehlt nicht als ungelesen');
  assert.equal(mineAutor.snapshots, 1);
  assert.equal(mineAutor.exports, 1, 'nur abgeschlossene Export-Laeufe');
  assert.equal(mineAutor.export_last_at, '2026-08-05T10:01:00.000Z');
  assert.equal(mineAutor.last_activity_at, '2026-08-01');

  const mineLektor = bookShelf.metricsForBooks(LEKTOR, [BOOK]).get(BOOK);
  assert.equal(mineLektor.chars, 2000, 'Umfang ist buchweit');
  assert.equal(mineLektor.exports, 1, 'Export-Laeufe sind buchweit');
  assert.equal(mineLektor.writing_seconds, 90);
  assert.equal(mineLektor.lektorat_seconds, 45);
  assert.equal(mineLektor.share_links, 0, 'fremde Share-Links bleiben unsichtbar');
  assert.equal(mineLektor.comments, 0);
  assert.equal(mineLektor.last_activity_at, '2026-08-03');

  // Buch ohne alles bekommt eine vollstaendige Nullzeile, nicht undefined —
  // die Karte rendert sonst leere Zellen statt einer 0.
  const leer = bookShelf.metricsForBooks(AUTOR, [BOOK, BOOK2]).get(BOOK2);
  assert.equal(leer.chars, 0);
  assert.equal(leer.comments_unread, 0);
  assert.equal(leer.export_last_at, null);
});

test('metricsForBooks: leere Eingabe erzeugt kein SQL mit leerem IN', () => {
  assert.equal(bookShelf.metricsForBooks(AUTOR, []).size, 0);
  assert.equal(bookShelf.metricsForBooks('', [BOOK]).size, 0);
});
