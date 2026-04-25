'use strict';
// ideen-Tabelle: CRUD + User-Isolation gegen frische In-Memory-DB.
// Wir replizieren das Migrations-DDL hier, damit der Test ohne lektorat.db läuft.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.prepare(`
    CREATE TABLE ideen (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id     INTEGER NOT NULL,
      page_id     INTEGER NOT NULL,
      page_name   TEXT,
      user_email  TEXT NOT NULL,
      content     TEXT NOT NULL,
      erledigt    INTEGER NOT NULL DEFAULT 0,
      erledigt_at TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )
  `).run();
  return db;
}

test('ideen: Insert + Select pro User isoliert', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, created_at, updated_at)
              VALUES (1, 10, 'a@x.de', 'Idee A', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, created_at, updated_at)
              VALUES (1, 10, 'b@x.de', 'Idee B', ?, ?)`).run(now, now);
  const a = db.prepare('SELECT content FROM ideen WHERE page_id = ? AND user_email = ?').all(10, 'a@x.de');
  const b = db.prepare('SELECT content FROM ideen WHERE page_id = ? AND user_email = ?').all(10, 'b@x.de');
  assert.deepEqual(a.map(r => r.content), ['Idee A']);
  assert.deepEqual(b.map(r => r.content), ['Idee B']);
});

test('ideen: getOpenIdeen-Filter (erledigt=0)', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, erledigt, created_at, updated_at)
              VALUES (1, 10, 'u@x.de', 'offen', 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, erledigt, created_at, updated_at)
              VALUES (1, 10, 'u@x.de', 'erledigt', 1, ?, ?)`).run(now, now);
  const open = db.prepare(
    'SELECT content FROM ideen WHERE page_id = ? AND user_email = ? AND erledigt = 0 ORDER BY created_at ASC'
  ).all(10, 'u@x.de');
  assert.deepEqual(open.map(r => r.content), ['offen']);
});

test('ideen: PATCH erledigt → erledigt_at', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, created_at, updated_at)
                          VALUES (1, 10, 'u@x.de', 'X', ?, ?)`).run(now, now);
  const id = ins.lastInsertRowid;
  const later = new Date(Date.now() + 1000).toISOString();
  db.prepare('UPDATE ideen SET erledigt = 1, erledigt_at = ?, updated_at = ? WHERE id = ?').run(later, later, id);
  const row = db.prepare('SELECT erledigt, erledigt_at FROM ideen WHERE id = ?').get(id);
  assert.equal(row.erledigt, 1);
  assert.equal(row.erledigt_at, later);
});

test('ideen: DELETE nur eigene Zeilen (Ownership-Pattern)', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, created_at, updated_at)
                          VALUES (1, 10, 'a@x.de', 'A', ?, ?)`).run(now, now);
  const id = ins.lastInsertRowid;
  // fremder User → 0 Treffer
  const r1 = db.prepare('DELETE FROM ideen WHERE id = ? AND user_email = ?').run(id, 'b@x.de');
  assert.equal(r1.changes, 0);
  // eigener User → gelöscht
  const r2 = db.prepare('DELETE FROM ideen WHERE id = ? AND user_email = ?').run(id, 'a@x.de');
  assert.equal(r2.changes, 1);
});
