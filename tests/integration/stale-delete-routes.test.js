'use strict';
// Integration test: DELETE /locations/:book_id/:id und DELETE /figures/:book_id/:id
// (der "Aus Katalog löschen"-Button auf den "nicht mehr im Text"-Zeilen).
//
// Kern der Sache: `:id` ist die OEFFENTLICHE Kennung (`locations.loc_id` /
// `figures.fig_id`, TEXT) — genau der Wert, den GET als `id` ausliefert und den das
// Frontend zurueckschickt. Bei stale-Eintraegen zieht der Reconcile sie auf
// 'orphan_<rowid>'; eine Route, die dort eine INTEGER-PK erwartet, lehnt jedes
// Loeschen mit 400 ab und der Eintrag bleibt in der Liste stehen.
//
// Faehrt die echten Router unter Express hoch (Fake-Session liefert den User),
// ACL via grantAccess — Muster wie tests/integration/research-routes.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser = 'autor@test.dev';

const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: sessionUser } }; next(); });
    app.use('/locations', require('../../routes/locations'));
    app.use('/figures', require('../../routes/figures'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(method, path) {
  const res = await fetch(`${baseUrl}${path}`, { method });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  sessionUser = 'autor@test.dev';
  for (const t of ['locations', 'figures', 'book_access', 'books']) db.prepare(`DELETE FROM ${t}`).run();
});

function seedBook(bookId, user = 'autor@test.dev') {
  const { grantAccess } = require('../../db/book-access');
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)")
    .run(bookId, NOW, NOW);
  grantAccess(bookId, user, 'editor', user);
}

function seedLocation(bookId, { locId, stale }, user = 'autor@test.dev') {
  return db.prepare(
    `INSERT INTO locations (book_id, user_email, loc_id, name, sort_order, stale, updated_at)
     VALUES (?, ?, ?, 'Burg Falkenstein', 0, ?, ?)`
  ).run(bookId, user, locId, stale ? 1 : 0, NOW).lastInsertRowid;
}

function seedFigure(bookId, { figId, stale }, user = 'autor@test.dev') {
  return db.prepare(
    `INSERT INTO figures (book_id, user_email, fig_id, name, sort_order, stale, updated_at)
     VALUES (?, ?, ?, 'Anna', 0, ?, ?)`
  ).run(bookId, user, figId, stale ? 1 : 0, NOW).lastInsertRowid;
}

const locExists = (id) => !!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(id);
const figExists = (id) => !!db.prepare('SELECT 1 FROM figures WHERE id = ?').get(id);

// ── Orte ────────────────────────────────────────────────────────────────────

test('Ort: stale-Eintrag mit orphan_-loc_id wird geloescht', async () => {
  const BOOK = 9401;
  seedBook(BOOK);
  const rowId = seedLocation(BOOK, { locId: 'orphan_1', stale: true });

  const { status, json } = await api('DELETE', `/locations/${BOOK}/orphan_1`);
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(locExists(rowId), false, 'Ort muss aus der DB verschwinden');
});

test('Ort: aktiver Eintrag bleibt (409 NOT_STALE)', async () => {
  const BOOK = 9402;
  seedBook(BOOK);
  const rowId = seedLocation(BOOK, { locId: 'ort_1', stale: false });

  const { status, json } = await api('DELETE', `/locations/${BOOK}/ort_1`);
  assert.equal(status, 409);
  assert.equal(json.error_code, 'NOT_STALE');
  assert.equal(locExists(rowId), true);
});

test('Ort: unbekannte loc_id → 404', async () => {
  const BOOK = 9403;
  seedBook(BOOK);
  seedLocation(BOOK, { locId: 'orphan_1', stale: true });

  const { status, json } = await api('DELETE', `/locations/${BOOK}/orphan_999`);
  assert.equal(status, 404);
  assert.equal(json.error_code, 'NOT_FOUND');
});

test('Ort: /stale-Bulk-Route wird nicht als loc_id missverstanden', async () => {
  const BOOK = 9404;
  seedBook(BOOK);
  seedLocation(BOOK, { locId: 'orphan_1', stale: true });
  seedLocation(BOOK, { locId: 'orphan_2', stale: true });
  const keep = seedLocation(BOOK, { locId: 'ort_1', stale: false });

  const { status, json } = await api('DELETE', `/locations/${BOOK}/stale`);
  assert.equal(status, 200);
  assert.equal(json.deleted.locations, 2);
  assert.equal(locExists(keep), true, 'aktiver Ort bleibt');
});

// ── Figuren (identischer Vertrag ueber fig_id) ──────────────────────────────

test('Figur: stale-Eintrag mit orphan_-fig_id wird geloescht', async () => {
  const BOOK = 9411;
  seedBook(BOOK);
  const rowId = seedFigure(BOOK, { figId: 'orphan_1', stale: true });

  const { status, json } = await api('DELETE', `/figures/${BOOK}/orphan_1`);
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(figExists(rowId), false, 'Figur muss aus der DB verschwinden');
});

test('Figur: aktiver Eintrag bleibt (409 NOT_STALE)', async () => {
  const BOOK = 9412;
  seedBook(BOOK);
  const rowId = seedFigure(BOOK, { figId: 'fig_1', stale: false });

  const { status, json } = await api('DELETE', `/figures/${BOOK}/fig_1`);
  assert.equal(status, 409);
  assert.equal(json.error_code, 'NOT_STALE');
  assert.equal(figExists(rowId), true);
});
