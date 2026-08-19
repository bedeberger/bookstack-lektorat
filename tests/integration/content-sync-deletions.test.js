'use strict';
// GET /content/books/:id/sync — Loeschungen im Delta.
//
// Die nativen Clients (macOS, Android) halten einen lokalen Spiegel des Buchs und
// ziehen ihn ueber dieses Delta nach. Aenderungen und Neuanlagen kommen als
// `pages`; eine geloeschte Seite kann dort per Definition nicht auftauchen — ohne
// eigenen `deleted`-Block bliebe sie im Spiegel und im Pagetree des Clients
// stehen, bis er zusaetzlich den ganzen Tree zieht.
//
// Geprueft wird der Vertrag, auf den ein Client-Autor sich verlaesst:
//   - Voll-Pull (kein `since`) liefert `deleted: []` (Baseline kennt die Seite nicht)
//   - Delta mit `since` VOR dem Loeschen liefert die Seite in `deleted`, nicht in `pages`
//   - NICHT self-exkludierend (anders als /changes) — der eigene Spiegel braucht es auch
//   - Delta mit `since` NACH dem Loeschen liefert sie nicht mehr

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

const USER = 'sync@x.test';
let ctx, server, baseUrl, contentStore, bookId, chapterId;

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: USER } }; next(); });
    app.use('/content', require('../../routes/content'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function sync(params = '') {
  const res = await fetch(`${baseUrl}/content/books/${bookId}/sync${params}`);
  return { status: res.status, json: await res.json() };
}

test.before(async () => {
  ctx = bootstrap();
  contentStore = require('../../lib/content-store');
  const appUsers = require('../../db/app-users');
  if (!appUsers.getUser(USER)) {
    appUsers.createUser({ email: USER, displayName: 'Sync', globalRole: 'user', status: 'active' });
  }
  const book = await contentStore.createBook({ name: 'Sync-Delta-Buch' }, { session: { user: { email: USER } } });
  bookId = book.id;
  require('../../db/book-access').grantAccess(bookId, USER, 'owner', USER);
  const chapter = await contentStore.createChapter({ book_id: bookId, name: 'K1' }, null);
  chapterId = chapter.id;
  await startServer();
});

test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test('Voll-Pull ohne since: deleted ist leer', async () => {
  const page = await contentStore.createPage({ book_id: bookId, chapter_id: chapterId, name: 'Bleibt', html: '<p>x</p>' }, null);
  assert.ok(page.id);
  const { status, json } = await sync();
  assert.equal(status, 200);
  assert.deepEqual(json.deleted, []);
  assert.equal(json.deleted_has_more, false);
  assert.ok(json.pages.some(p => p.page_id === page.id), 'Seite im Voll-Pull');
});

test('Delta mit since vor dem Loeschen: Seite steht in deleted, nicht in pages', async () => {
  const page = await contentStore.createPage({ book_id: bookId, chapter_id: chapterId, name: 'Geht weg', html: '<p>y</p>' }, null);
  // Cursor NACH dem Anlegen setzen: die Seite ist dem Client also bekannt und
  // taucht als Aenderung nicht mehr auf — genau die Lage, in der nur der
  // deleted-Block sie noch melden kann.
  const cursor = new Date().toISOString();
  await new Promise(r => setTimeout(r, 5));
  await contentStore.deletePage(page.id, null, { deletedBy: USER });

  const { status, json } = await sync(`?since=${encodeURIComponent(cursor)}`);
  assert.equal(status, 200);
  assert.equal(json.pages.some(p => p.page_id === page.id), false, 'geloeschte Seite nicht in pages');
  const row = json.deleted.find(d => d.page_id === page.id);
  assert.ok(row, 'geloeschte Seite fehlt im deleted-Block');
  assert.equal(row.page_name, 'Geht weg');
  assert.ok(row.deleted_at);
});

test('Delta ist NICHT self-exkludierend (eigene Loeschung wird geliefert)', async () => {
  // Das Loeschen oben lief unter demselben Konto wie die Anfrage — /changes
  // filtert das aus, /sync darf es nicht: sonst erfaehrt der eigene Spiegel des
  // Zweitgeraets nie davon.
  const page = await contentStore.createPage({ book_id: bookId, chapter_id: chapterId, name: 'Selbst geloescht', html: '<p>z</p>' }, null);
  const cursor = new Date().toISOString();
  await new Promise(r => setTimeout(r, 5));
  await contentStore.deletePage(page.id, null, { deletedBy: USER });

  const { json } = await sync(`?since=${encodeURIComponent(cursor)}`);
  assert.ok(json.deleted.some(d => d.page_id === page.id), 'eigene Loeschung muss im Delta stehen');
});

test('Delta mit since nach dem Loeschen: nicht mehr enthalten', async () => {
  const page = await contentStore.createPage({ book_id: bookId, chapter_id: chapterId, name: 'Alt geloescht', html: '<p>q</p>' }, null);
  await contentStore.deletePage(page.id, null, { deletedBy: USER });
  await new Promise(r => setTimeout(r, 5));

  const { json } = await sync(`?since=${encodeURIComponent(new Date().toISOString())}`);
  assert.equal(json.deleted.some(d => d.page_id === page.id), false);
});
