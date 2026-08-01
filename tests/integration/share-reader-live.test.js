'use strict';
// Share-Reader liefert LIVE-Content: editiert der Autor eine Seite, die in einem
// Share-Link (Seite ODER Buch) enthalten ist, MUSS ein erneuter GET /share/:token
// den neuen Text zeigen — es gibt keinen eingefrorenen Snapshot (docs/share-link.md,
// "Cache-Headers": no-store, Content live).
//
// Diagnose-Wert: schlaegt dieser Test fehl, liest der Server stale (Content-Store-
// /Prozess-Cache). Ist er gruen, kommt ein im Browser beobachtetes "Reload zeigt
// die Aenderung nicht" NICHT vom Server — dann ist die Edit nicht in der DB
// gelandet (Save nie ausgeloest / falsche Seite) oder ein Browser-Layer haelt fest.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const tmp = path.join('/tmp', `share-reader-live-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { db } = require('../../db/connection');
require('../../db/migrations').runMigrations();
const appUsers = require('../../db/app-users');
const sl = require('../../db/share-links');
const contentStore = require('../../lib/content-store');

const express = require('express');
const shareRouter = require('../../routes/share');

const OWNER = 'autor@live.test';
const BOOK_ID = 7001;
const CHAPTER_ID = 7101;
const PAGE_A = 7201;
const PAGE_B = 7202;

function seed() {
  const now = new Date().toISOString();
  if (!appUsers.getUser(OWNER)) appUsers.createUser({ email: OWNER, displayName: 'Autor Anna' });
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(BOOK_ID, 'Live-Buch', now, now);
  db.prepare(`INSERT INTO chapters (chapter_id, book_id, chapter_name, position, priority, updated_at)
              VALUES (?, ?, ?, 0, 0, ?)`).run(CHAPTER_ID, BOOK_ID, 'Kapitel Eins', now);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, priority, updated_at, body_html)
              VALUES (?, ?, ?, ?, 0, 0, ?, ?)`)
    .run(PAGE_A, BOOK_ID, 'Seite A', CHAPTER_ID, now, '<p>URSPRUNG_ALPHA</p>');
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, priority, updated_at, body_html)
              VALUES (?, ?, ?, ?, 1, 1, ?, ?)`)
    .run(PAGE_B, BOOK_ID, 'Seite B', CHAPTER_ID, now, '<p>URSPRUNG_BETA</p>');
}

let server, baseUrl;
test.before(async () => {
  seed();
  const app = express();
  app.use('/share', shareRouter);
  await new Promise((res) => { server = app.listen(0, res); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); });

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + pathname, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
    }).on('error', reject);
  });
}

test('Page-Share: Edit der Seite ist nach erneutem GET sofort sichtbar', async () => {
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_A, bookId: BOOK_ID, ownerEmail: OWNER });

  const before = await get(`/share/${link.token}`);
  assert.equal(before.status, 200);
  assert.match(before.body, /URSPRUNG_ALPHA/, 'Ausgangstext muss im ersten Render stehen');
  assert.equal(before.headers['cache-control'], 'no-store', 'Reader-Response muss no-store sein');

  // Autor editiert die Seite (kanonischer Schreibpfad ueber die Content-Store-Facade).
  await contentStore.savePage(PAGE_A, { html: '<p>EDITIERT_ALPHA</p>' }, { session: { user: { email: OWNER } } });

  const after = await get(`/share/${link.token}`);
  assert.equal(after.status, 200);
  assert.match(after.body, /EDITIERT_ALPHA/, 'Reload MUSS den editierten Text zeigen (live, kein Snapshot)');
  assert.doesNotMatch(after.body, /URSPRUNG_ALPHA/, 'Alter Text darf nicht mehr erscheinen');
});

test('Buch-Share: Edit einer enthaltenen Seite ist nach erneutem GET sichtbar', async () => {
  const link = sl.createShareLink({ kind: 'book', bookId: BOOK_ID, ownerEmail: OWNER, showToc: true });

  const before = await get(`/share/${link.token}`);
  assert.equal(before.status, 200);
  assert.match(before.body, /URSPRUNG_BETA/, 'Ausgangstext der Seite B muss im Buch-Stream stehen');

  await contentStore.savePage(PAGE_B, { html: '<p>EDITIERT_BETA</p>' }, { session: { user: { email: OWNER } } });

  const after = await get(`/share/${link.token}`);
  assert.equal(after.status, 200);
  assert.match(after.body, /EDITIERT_BETA/, 'Reload des Buch-Shares MUSS die Seiten-Edit zeigen');
  assert.doesNotMatch(after.body, /URSPRUNG_BETA/, 'Alter Seitentext darf nicht mehr erscheinen');
});

// ── Aktive Inhalte erreichen die oeffentliche View nicht ─────────────────────
// Der Schreibweg raeumt `<script>`/`on*`/`javascript:` bereits weg
// (lib/html-clean.js#stripActiveContent, harte Regel „Aktive Inhalte fallen im
// Sanitizer"). Dieser Test deckt den Fall ab, den der Schreibweg NICHT sieht:
// eine Zeile, die schon vorher in der DB lag (Alt-Bestand, Import, Restore) und
// nie erneut gespeichert wurde. Ausgeliefert wird sie hier ohne Login an Fremde.
const PAGE_LEGACY = 7203;

test('Share-Reader: Alt-Bestand mit aktivem Markup wird beim Ausliefern entschaerft', async () => {
  const now = new Date().toISOString();
  // Direkt per SQL, also bewusst UM den Sanitizer herum — genau der Alt-Zustand.
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, priority, updated_at, body_html)
              VALUES (?, ?, ?, ?, 2, 2, ?, ?)`)
    .run(PAGE_LEGACY, BOOK_ID, 'Seite Alt', CHAPTER_ID, now,
      '<p>SICHTBARER_TEXT</p><script>window.__pwn=1</script>'
      + '<p onclick="window.__pwn=2">Klick</p>'
      + '<p><a href="javascript:window.__pwn=3">Link</a></p>');

  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_LEGACY, bookId: BOOK_ID, ownerEmail: OWNER });
  const r = await get(`/share/${link.token}`);
  assert.equal(r.status, 200);
  assert.match(r.body, /SICHTBARER_TEXT/, 'der Text selbst muss erhalten bleiben');
  assert.match(r.body, /Klick/, 'Absatz bleibt, nur der Handler faellt');
  assert.doesNotMatch(r.body, /window\.__pwn/, 'kein ausfuehrbares Fragment in der Antwort');
  assert.doesNotMatch(r.body, /onclick/, 'kein Event-Handler-Attribut in der Antwort');
  assert.doesNotMatch(r.body, /javascript:/, 'keine Script-URL in der Antwort');
});
