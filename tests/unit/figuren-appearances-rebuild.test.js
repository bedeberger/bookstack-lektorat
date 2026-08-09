'use strict';
// db/figures.js#backfillAppearancesFromScenesEvents: ergänzt figure_appearances um
// Kapitel-Auftritte, die über Szenen (scene_figures → figure_scenes.chapter_id) oder
// Lebensereignisse (figure_events.chapter_id) belegt sind, aber im KI-gemeldeten
// kapitel-Feld fehlen (Single-Pass-Recall-Lücke). Bestehende Paare bleiben unverändert.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `figuren-app-backfill-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const { backfillAppearancesFromScenesEvents } = require('../../db/figures');

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch {} }
});

const BOOK = 6001;
const USER = 'autor@x.ch';
const now = new Date().toISOString();

// Kapitel: K1 (AI-gemeldet), K2 (nur Szene), K3 (nur Event), K4 (Szene aber stale → ignoriert)
function seed() {
  db.prepare('INSERT INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'Autor');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'Testbuch', now, now, USER);
  for (const [cid, name, pos] of [[1, 'K1', 0], [2, 'K2', 1], [3, 'K3', 2], [4, 'K4', 3]]) {
    db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(cid, BOOK, name, pos, now);
  }
  // Eine Figur „Pamela"
  const r = db.prepare('INSERT INTO figures (book_id, fig_id, name, user_email, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'fig_1', 'Pamela', USER, now);
  const figId = Number(r.lastInsertRowid);

  // AI hat nur K1 gemeldet (haeufigkeit 5)
  db.prepare('INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)')
    .run(figId, 1, 5);

  // Szene in K2 (frisch) + Szene in K4 (stale → darf nicht zählen)
  const s2 = db.prepare('INSERT INTO figure_scenes (book_id, user_email, titel, chapter_id, stale, updated_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(BOOK, USER, 'Szene K2', 2, now).lastInsertRowid;
  const s4 = db.prepare('INSERT INTO figure_scenes (book_id, user_email, titel, chapter_id, stale, updated_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(BOOK, USER, 'Szene K4 stale', 4, now).lastInsertRowid;
  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(Number(s2), figId);
  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(Number(s4), figId);

  // Lebensereignis in K3
  db.prepare('INSERT INTO figure_events (figure_id, datum, ereignis, chapter_id) VALUES (?, ?, ?, ?)')
    .run(figId, '1990', 'Geburt', 3);

  return figId;
}

test('backfill ergänzt Szenen-/Event-Kapitel, lässt AI-Paar + stale-Szene unberührt', () => {
  const figId = seed();
  const added = backfillAppearancesFromScenesEvents(BOOK, USER);
  assert.equal(added, 2, 'genau K2 (Szene) + K3 (Event) neu ergänzt');

  const rows = db.prepare(
    'SELECT chapter_id, haeufigkeit FROM figure_appearances WHERE figure_id = ? ORDER BY chapter_id'
  ).all(figId);
  const byChap = Object.fromEntries(rows.map(r => [r.chapter_id, r.haeufigkeit]));

  assert.deepEqual(Object.keys(byChap).map(Number).sort((a, b) => a - b), [1, 2, 3],
    'K1 (AI) + K2 (Szene) + K3 (Event); K4 stale nicht');
  assert.equal(byChap[1], 5, 'AI-Häufigkeit von K1 unverändert');
  assert.equal(byChap[2], 1, 'K2 aus einer Szene');
  assert.equal(byChap[3], 1, 'K3 aus einem Event');
});

test('idempotent: zweiter Lauf ergänzt nichts mehr', () => {
  const added = backfillAppearancesFromScenesEvents(BOOK, USER);
  assert.equal(added, 0, 'alle Paare existieren bereits → INSERT OR IGNORE no-op');
});
