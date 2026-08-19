'use strict';
// Regression: GET /content/books/:id/changes — die Delete-Query in
// routes/content/books.js JOINt `page_deletions` gegen `app_users_devices`.
// Beide Tabellen haben eine `device_id`-Spalte; ein unqualifiziertes
// `device_id` in der WHERE-Klausel ist darum mehrdeutig und der Endpoint
// antwortet mit 500 (ambiguous column name). Der Smoke traf den Fehler nur als
// Server-WARN-Log ohne Browser-Fehler — dieser Test hält beide Filter-Zweige
// (mit/ohne device_id) auf einer echten migrierten DB grün.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-changes-'));
const dbFile = path.join(tmpDir, `fresh-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

function freshRequire(rel) {
  const abs = require.resolve(path.join(__dirname, '..', '..', rel));
  delete require.cache[abs];
  return require(abs);
}

freshRequire('db/connection');
freshRequire('db/migrations');
const { db } = freshRequire('db/connection');

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

const SELF_FILTER_DEV = 'AND NOT (deleted_by_email = ? AND (page_deletions.device_id IS NULL OR page_deletions.device_id = ?))';
const SELF_FILTER_LEGACY = 'AND (? IS NULL OR deleted_by_email <> ?)';

let BOOK_ID;

function deletionsQuery(filter, args) {
  return db.prepare(`
    SELECT page_id, page_name, deleted_at AS changed_at, deleted_by_email AS last_editor_email,
           u.display_name AS last_editor_name,
           d.label        AS last_editor_device_label
      FROM page_deletions
      LEFT JOIN app_users         u ON u.email = deleted_by_email
      LEFT JOIN app_users_devices d ON d.device_id = page_deletions.device_id
                                    AND d.user_email = ?
     WHERE book_id = ?
       AND deleted_at > ?
       ${filter}
     ORDER BY deleted_at ASC
     LIMIT 200
  `).all('alice@example.com', BOOK_ID, '2000-01-01T00:00:00.000Z', ...args);
}

test('changes-Delete-Query: mit device_id (Self-Filter) laeuft ohne ambigen Spaltenfehler', () => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_users (email, display_name, global_role, status, language, can_invite_users, first_seen_at, created_at)
    VALUES ('alice@example.com', 'Alice', 'user', 'active', 'de', 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO app_users_devices (device_id, user_email, label)
    VALUES ('dev-1', 'alice@example.com', 'Mac')
  `).run();
  BOOK_ID = db.prepare(`
    INSERT INTO books (name, description, created_at, updated_at, owner_email)
    VALUES ('B', 'd', ?, ?, NULL)
  `).run(now, now).lastInsertRowid;
  const pageId = db.prepare(`
    INSERT INTO pages (book_id, page_name, body_html, position, priority, updated_at, local_updated_at)
    VALUES (?, 'Weg', '<p>x</p>', 0, 0, ?, ?)
  `).run(BOOK_ID, now, now).lastInsertRowid;
  db.prepare(`
    INSERT INTO page_deletions (book_id, page_id, page_name, deleted_at, deleted_by_email, device_id)
    VALUES (?, ?, 'Weg', ?, 'alice@example.com', 'dev-1')
  `).run(BOOK_ID, pageId, now);

  // Eigenes Geraet (gleiche device_id) wird ausgefiltert — leeres Ergebnis.
  const self = deletionsQuery(SELF_FILTER_DEV, ['alice@example.com', 'dev-1']);
  assert.deepEqual(self, []);
  // Anderes Geraet bleibt sichtbar und traegt das Geraete-Label.
  const other = deletionsQuery(SELF_FILTER_DEV, ['alice@example.com', 'dev-2']);
  assert.equal(other.length, 1);
  assert.equal(other[0].page_name, 'Weg');
  assert.equal(other[0].last_editor_device_label, 'Mac');
});

test('changes-Delete-Query: ohne device_id (Legacy-Filter) laeuft ebenso', () => {
  // Ohne device_id faellt der Filter auf reine E-Mail-Exklusion: die eigene
  // Loeschung (gleiche E-Mail) wird ausgefiltert — kein Ergebnis, kein Fehler.
  const rows = deletionsQuery(SELF_FILTER_LEGACY, ['alice@example.com', 'alice@example.com']);
  assert.deepEqual(rows, []);
});
