'use strict';
// localdb-Backend der Content-Store-Facade. Verifiziert, dass
//   - der Vertrag (loadBook/listBooks/loadPage/savePage/createPage/bookTree/…)
//     gegen lokale SQLite-Tabellen funktioniert.
//   - Domain-Shape (id/name/html/position/chapter_id/book_id) stabil bleibt.

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

// Page-Writes bekommen am Chokepoint stabile data-bid (Block-Level-Merge).
// Für Exact-HTML-Assertions die IDs strippen — sie sind random pro Write.
const noBid = (h) => String(h ?? '').replace(/ data-bid="[^"]*"/g, '');

let ctx;
test.before(() => {
  ctx = bootstrap();
  ctx.contentStore = require('../../lib/content-store');
  ctx.connection = require('../../db/connection');
});
test.after(() => { ctx.cleanup(); });

function _seedBook({ name = 'Test-Buch', description = 'Beschreibung' } = {}) {
  const now = new Date().toISOString();
  const r = ctx.connection.db.prepare(`
    INSERT INTO books (name, description, created_at, updated_at, owner_email)
    VALUES (?, ?, ?, ?, NULL)
  `).run(name, description, now, now);
  return r.lastInsertRowid;
}

function _seedChapter(bookId, { name = 'Kapitel 1', position = 0 } = {}) {
  const now = new Date().toISOString();
  const r = ctx.connection.db.prepare(`
    INSERT INTO chapters (book_id, chapter_name, position, priority, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(bookId, name, position, position, now);
  return r.lastInsertRowid;
}

function _seedPage(bookId, chapterId, { name = 'Seite 1', html = '<p>Inhalt</p>', position = 0 } = {}) {
  const now = new Date().toISOString();
  const r = ctx.connection.db.prepare(`
    INSERT INTO pages (book_id, chapter_id, page_name, body_html, position, priority, updated_at, local_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(bookId, chapterId, name, html, position, position, now, now);
  return r.lastInsertRowid;
}

test('localdb: listBooks + loadBook (Domain-Shape)', async () => {
  const bookId = _seedBook({ name: 'Lib-Test-Buch' });
  const books = await ctx.contentStore.listBooks();
  const found = books.find(b => b.id === bookId);
  assert.ok(found, 'Buch in listBooks');
  assert.equal(found.name, 'Lib-Test-Buch');
  assert.equal(found.description, 'Beschreibung');
  assert.ok(found.created_at);

  const book = await ctx.contentStore.loadBook(bookId);
  assert.equal(book.id, bookId);
  assert.equal(book.name, 'Lib-Test-Buch');
});

test('localdb: loadPage liefert html + chapter_id + position', async () => {
  const bookId = _seedBook();
  const chapterId = _seedChapter(bookId);
  const pageId = _seedPage(bookId, chapterId, { name: 'P', html: '<p>X</p>', position: 7 });

  const p = await ctx.contentStore.loadPage(pageId);
  assert.equal(p.id, pageId);
  assert.equal(p.book_id, bookId);
  assert.equal(p.chapter_id, chapterId);
  assert.equal(p.name, 'P');
  assert.equal(p.html, '<p>X</p>');
  assert.equal(p.position, 7);
});

test('localdb: savePage updated body_html + local_updated_at', async () => {
  const bookId = _seedBook();
  const chapterId = _seedChapter(bookId);
  const pageId = _seedPage(bookId, chapterId);

  const before = await ctx.contentStore.loadPage(pageId);
  await new Promise(r => setTimeout(r, 5)); // updated_at-Unterschied
  await ctx.contentStore.savePage(pageId, { html: '<p>Neu</p>' });
  const after = await ctx.contentStore.loadPage(pageId);

  assert.equal(noBid(after.html), '<p>Neu</p>');
  assert.notEqual(after.updated_at, before.updated_at);
});

test('localdb: createPage vergibt ID >= 1_000_001 (Phase-0-Wasserzeichen)', async () => {
  const bookId = _seedBook();
  const created = await ctx.contentStore.createPage({ book_id: bookId, name: 'Neue Seite', html: '<p>x</p>' });
  assert.ok(created.id >= 1_000_001, `id ${created.id} muss >= 1_000_001 sein`);
  assert.equal(created.book_id, bookId);
  assert.equal(noBid(created.html), '<p>x</p>');
});

test('localdb: bookTree gruppiert nach Kapitel + Top-Level', async () => {
  const bookId = _seedBook();
  const c1 = _seedChapter(bookId, { name: 'Kap A', position: 0 });
  const c2 = _seedChapter(bookId, { name: 'Kap B', position: 1 });
  _seedPage(bookId, c1, { name: 'A1', position: 0 });
  _seedPage(bookId, c2, { name: 'B1', position: 0 });
  _seedPage(bookId, null, { name: 'Top', position: 0 });

  const tree = await ctx.contentStore.bookTree(bookId);
  assert.equal(tree.chapters.length, 2);
  assert.equal(tree.chapters[0].name, 'Kap A');
  assert.equal(tree.chapters[0].pages.length, 1);
  assert.equal(tree.chapters[0].pages[0].name, 'A1');
  assert.equal(tree.chapters[1].pages.length, 1);
  assert.equal(tree.topPages.length, 1);
  assert.equal(tree.topPages[0].name, 'Top');
});

test('localdb: searchPages (LIKE-Fallback)', async () => {
  const bookId = _seedBook();
  const chapterId = _seedChapter(bookId);
  _seedPage(bookId, chapterId, { name: 'Aldous Huxley', html: '<p>Schöne neue Welt</p>' });
  _seedPage(bookId, chapterId, { name: 'Orwell', html: '<p>1984</p>' });

  const hits = await ctx.contentStore.searchPages('Huxley', { bookId });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'Aldous Huxley');

  const bodyHits = await ctx.contentStore.searchPages('1984', { bookId });
  assert.equal(bodyHits.length, 1);
  assert.equal(bodyHits[0].name, 'Orwell');
});

test('localdb: deletePage entfernt Row + schreibt page_deletions + wirft NOT_FOUND auf Re-Delete', async () => {
  const bookId = _seedBook();
  const pageId = _seedPage(bookId, null, { name: 'Seite zum Loeschen' });
  await ctx.contentStore.deletePage(pageId, null, { deletedBy: 'alice@example.com', deviceId: 'dev-123' });
  await assert.rejects(() => ctx.contentStore.loadPage(pageId), { code: 'NOT_FOUND' });
  await assert.rejects(() => ctx.contentStore.deletePage(pageId), { code: 'NOT_FOUND' });

  const del = ctx.connection.db.prepare('SELECT * FROM page_deletions WHERE page_id = ?').get(pageId);
  assert.ok(del, 'page_deletions-Eintrag fehlt');
  assert.equal(del.book_id, bookId);
  assert.equal(del.page_name, 'Seite zum Loeschen');
  assert.equal(del.deleted_by_email, 'alice@example.com');
  assert.equal(del.device_id, 'dev-123');
  assert.ok(del.deleted_at);
});

// Regression: `ideen` ankert per XOR-CHECK an genau EINER Seite ODER genau einem
// Kapitel. Stand die FK-Aktion auf SET NULL, nullte das Loeschen den einzigen
// Anker und verletzte damit denselben CHECK — die ganze Transaktion brach ab und
// KEIN Seiten-, Kapitel- oder Buch-Loeschen mit angehaengter Idee ging mehr durch.
// Seit Migration 274 CASCADE: die Idee faellt mit ihrem Anker.
function _seedIdee(bookId, { pageId = null, chapterId = null } = {}) {
  const now = new Date().toISOString();
  const r = ctx.connection.db.prepare(`
    INSERT INTO ideen (book_id, page_id, chapter_id, user_email, content, created_at, updated_at)
    VALUES (?, ?, ?, 'alice@example.com', 'Notiz', ?, ?)
  `).run(bookId, pageId, chapterId, now, now);
  return r.lastInsertRowid;
}
const _ideeExists = (id) =>
  !!ctx.connection.db.prepare('SELECT 1 FROM ideen WHERE id = ?').get(id);

test('localdb: deletePage mit angehaengter Seiten-Idee loescht die Idee mit (XOR-CHECK vs. FK-Aktion)', async () => {
  const bookId = _seedBook();
  const pageId = _seedPage(bookId, null, { name: 'Seite mit Idee' });
  const ideeId = _seedIdee(bookId, { pageId });

  await ctx.contentStore.deletePage(pageId, null, { deletedBy: 'alice@example.com' });

  await assert.rejects(() => ctx.contentStore.loadPage(pageId), { code: 'NOT_FOUND' });
  assert.equal(_ideeExists(ideeId), false, 'Idee muss mit ihrer Seite fallen');
});

test('localdb: deleteChapter mit angehaengter Kapitel-Idee loescht die Idee mit', async () => {
  const bookId = _seedBook();
  const chapterId = _seedChapter(bookId);
  const ideeId = _seedIdee(bookId, { chapterId });

  await ctx.contentStore.deleteChapter(chapterId, null);

  assert.equal(_ideeExists(ideeId), false, 'Idee muss mit ihrem Kapitel fallen');
});

test('localdb: deleteBook raeumt Seiten- UND Kapitel-Ideen des Buchs', async () => {
  const bookId = _seedBook();
  const chapterId = _seedChapter(bookId);
  const pageId = _seedPage(bookId, chapterId);
  const pageIdee = _seedIdee(bookId, { pageId });
  const chapterIdee = _seedIdee(bookId, { chapterId });

  await ctx.contentStore.deleteBook(bookId, null);

  assert.equal(_ideeExists(pageIdee), false);
  assert.equal(_ideeExists(chapterIdee), false);
});

test('localdb: savePage mit expected_updated_at = aktueller Stand → ok, setzt last_editor_email', async () => {
  const bookId = _seedBook();
  const pageId = _seedPage(bookId, null);
  const before = await ctx.contentStore.loadPage(pageId);
  await new Promise(r => setTimeout(r, 5));

  const ctxReq = { session: { user: { email: 'alice@example.com' } } };
  const saved = await ctx.contentStore.savePage(
    pageId,
    { html: '<p>Update durch Alice</p>', expected_updated_at: before.updated_at },
    ctxReq,
  );
  assert.equal(noBid(saved.html), '<p>Update durch Alice</p>');
  assert.equal(saved.last_editor_email, 'alice@example.com');
  assert.notEqual(saved.updated_at, before.updated_at);
});

test('localdb: savePage mit stale expected_updated_at → PAGE_CONFLICT', async () => {
  const bookId = _seedBook();
  const pageId = _seedPage(bookId, null);
  const v0 = await ctx.contentStore.loadPage(pageId);
  await new Promise(r => setTimeout(r, 5));

  // Erster Save durch Bob — Stamp veraltet.
  await ctx.contentStore.savePage(
    pageId,
    { html: '<p>Bob writes first</p>', expected_updated_at: v0.updated_at },
    { session: { user: { email: 'bob@example.com' } } },
  );

  // Alice schreibt mit dem (jetzt staleen) Stamp aus v0 → 409.
  await assert.rejects(
    () => ctx.contentStore.savePage(
      pageId,
      { html: '<p>Alice late</p>', expected_updated_at: v0.updated_at },
      { session: { user: { email: 'alice@example.com' } } },
    ),
    (err) => {
      assert.equal(err.code, 'PAGE_CONFLICT');
      assert.equal(err.status, 409);
      assert.equal(err.serverEditorEmail, 'bob@example.com');
      assert.ok(err.serverUpdatedAt);
      return true;
    },
  );

  // Bobs Inhalt steht weiterhin in der DB — kein Overwrite durch Alice.
  const final = await ctx.contentStore.loadPage(pageId);
  assert.equal(noBid(final.html), '<p>Bob writes first</p>');
  assert.equal(final.last_editor_email, 'bob@example.com');
});

test('localdb: savePage ohne expected_updated_at → kein Conflict-Check (Legacy-Pfad)', async () => {
  const bookId = _seedBook();
  const pageId = _seedPage(bookId, null);
  await new Promise(r => setTimeout(r, 5));
  // Server-Job ohne Editor-Snapshot soll weiterhin schreiben koennen.
  const saved = await ctx.contentStore.savePage(
    pageId,
    { html: '<p>Cron</p>' },
    null,
  );
  assert.equal(noBid(saved.html), '<p>Cron</p>');
  assert.equal(saved.last_editor_email, null);
});

test('localdb: Rename ohne html ueberschreibt last_editor_email nicht', async () => {
  const bookId = _seedBook();
  const pageId = _seedPage(bookId, null);
  await ctx.contentStore.savePage(
    pageId,
    { html: '<p>Initial</p>' },
    { session: { user: { email: 'alice@example.com' } } },
  );
  // Reine Rename-Operation (kein html-Field) durch Bob.
  await ctx.contentStore.savePage(
    pageId,
    { name: 'Renamed by Bob' },
    { session: { user: { email: 'bob@example.com' } } },
  );
  const p = await ctx.contentStore.loadPage(pageId);
  assert.equal(p.name, 'Renamed by Bob');
  assert.equal(p.last_editor_email, 'alice@example.com', 'Body-Autor bleibt Alice');
});

test('localdb: loadPagesBatch laeuft sequentiell ohne Token', async () => {
  const bookId = _seedBook();
  const chapterId = _seedChapter(bookId);
  const p1 = _seedPage(bookId, chapterId, { name: 'P1' });
  const p2 = _seedPage(bookId, chapterId, { name: 'P2' });
  const out = await ctx.contentStore.loadPagesBatch([{ id: p1 }, { id: p2 }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'P1');
  assert.equal(out[1].name, 'P2');
});
