// Einarbeitungs-Achse des Recherche-Boards (`research_items.status`, Spalten des
// Status-Boards). Drei Dinge, die ohne Gate still auseinanderlaufen:
//
//   1. Die Stufenliste steht ZWEIMAL — serverseitig in lib/research-validate.js
//      (CJS, Validierung + CHECK-Wortlaut) und im Browser in
//      public/js/book/recherche/shared.js (ESM, Spaltenfolge). Ein Wert nur auf
//      einer Seite heisst: die Spalte existiert, aber der PATCH antwortet 400 —
//      oder umgekehrt, ein gueltiger Wert hat keine Spalte und die Karte fiele
//      aus dem Board.
//   2. Der CHECK der Tabelle muss dieselben Werte tragen. Sonst wirft erst der
//      Schreibversuch, nachdem die Validierung durchgelassen hat.
//   3. Jede Stufe braucht ihr Label in BEIDEN Locales.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { rechercheStatusMethods as statusMethods } from '../../public/js/book/recherche/status.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { RESEARCH_STATUSES, RESEARCH_STATUS_SET, DEFAULT_RESEARCH_STATUS } =
  require('../../lib/research-validate.js');
const { SQUASHED_SCHEMA } = require('../../db/squashed-schema.js');

const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

const T = '2026-01-01T00:00:00.000Z';

function freshDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SQUASHED_SCHEMA);
  return db;
}

function seedItem(db) {
  const bookId = db.prepare('INSERT INTO books(name, created_at, updated_at) VALUES(?,?,?)')
    .run('Testbuch', T, T).lastInsertRowid;
  const itemId = db.prepare(
    `INSERT INTO research_items(book_id, user_email, kind, title, created_at, updated_at)
     VALUES(?,?,?,?,?,?)`
  ).run(bookId, 'a@b.c', 'note', 'Notiz', T, T).lastInsertRowid;
  return { bookId, itemId };
}

test('Frontend-Stufenliste ist wortgleich mit der Server-SSoT (gleiche Werte, gleiche Reihenfolge)', () => {
  const src = read('public/js/book/recherche/shared.js');
  const m = /export const STATUSES = \[([^\]]+)\]/.exec(src);
  assert.ok(m, 'STATUSES nicht in public/js/book/recherche/shared.js gefunden');
  const fromFrontend = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(fromFrontend, RESEARCH_STATUSES);
  assert.equal(RESEARCH_STATUSES[0], DEFAULT_RESEARCH_STATUS,
    'Die erste Spalte des Boards muss der Default sein — sonst startet ein neues Fundstueck nicht dort, wo man es sucht');
});

test('CHECK der Tabelle traegt genau diese Stufen', () => {
  const db = freshDb();
  const { itemId } = seedItem(db);
  // Default: ein Fundstueck ohne Angabe ist unbearbeitet.
  assert.equal(db.prepare('SELECT status FROM research_items WHERE id = ?').get(itemId).status,
    DEFAULT_RESEARCH_STATUS);
  // Jede erlaubte Stufe geht durch …
  for (const st of RESEARCH_STATUSES) {
    db.prepare('UPDATE research_items SET status = ? WHERE id = ?').run(st, itemId);
    assert.equal(db.prepare('SELECT status FROM research_items WHERE id = ?').get(itemId).status, st);
  }
  // … und nichts sonst.
  assert.throws(
    () => db.prepare('UPDATE research_items SET status = ? WHERE id = ?').run('erledigt', itemId),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare('UPDATE research_items SET status = NULL WHERE id = ?').run(itemId),
    /NOT NULL constraint failed/,
  );
});

test('`verworfen` ist eine Stufe, nicht das Archiv — beide Achsen bleiben getrennt', () => {
  const db = freshDb();
  const { itemId } = seedItem(db);
  db.prepare('UPDATE research_items SET status = ? WHERE id = ?').run('verworfen', itemId);
  const row = db.prepare('SELECT status, archived FROM research_items WHERE id = ?').get(itemId);
  assert.equal(row.status, 'verworfen');
  assert.equal(row.archived, 0, 'Verworfen darf ein Fundstueck nicht aus dem Board raeumen');
});

test('Jede Stufe hat ein Label in beiden Locales', () => {
  for (const loc of ['de', 'en']) {
    const dict = JSON.parse(read(`public/js/i18n/${loc}.json`));
    for (const st of RESEARCH_STATUSES) {
      const key = `recherche.status.${st}`;
      assert.ok(dict[key] && String(dict[key]).trim(), `${key} fehlt in ${loc}.json`);
    }
    for (const key of ['recherche.status.label', 'recherche.viewLabel',
      'recherche.view.list', 'recherche.view.status',
      'recherche.status.noPlace', 'recherche.status.emptyColumn',
      'recherche.status.otherLinks', 'recherche.status.drag']) {
      assert.ok(dict[key] && String(dict[key]).trim(), `${key} fehlt in ${loc}.json`);
    }
  }
});

// ── Spalten-Aufteilung (pure Logik der Karte) ──────────────────────────────
// Die vier Methoden laufen ohne Alpine: `items` + `_memos` genuegen als Kontext.
function boardCtx(items) {
  return { _memos: {}, items, ...statusMethods };
}

test('statusBuckets sortiert jedes Fundstueck in genau eine Spalte', () => {
  const ctx = boardCtx([
    { id: 1, status: 'offen', links: [] },
    { id: 2, status: 'eingearbeitet', links: [] },
    { id: 3, status: 'in_arbeit', links: [] },
    { id: 4, status: 'verworfen', links: [] },
  ]);
  const ids = Object.fromEntries(
    Object.entries(ctx.statusBuckets()).map(([k, v]) => [k, v.map(i => i.id)]),
  );
  assert.deepEqual(ids, { offen: [1], in_arbeit: [3], eingearbeitet: [2], verworfen: [4] });
  assert.deepEqual(Object.keys(ids), RESEARCH_STATUSES, 'Spaltenfolge = Stufenfolge');
});

test('Unbekannter oder fehlender Status landet in der ersten Spalte, nicht im Nichts', () => {
  const ctx = boardCtx([
    { id: 1, status: null, links: [] },
    { id: 2, links: [] },
    { id: 3, status: 'erledigt', links: [] },
  ]);
  assert.deepEqual(ctx.statusBuckets().offen.map(i => i.id), [1, 2, 3]);
  const total = RESEARCH_STATUSES.reduce((n, st) => n + ctx.itemsForStatus(st).length, 0);
  assert.equal(total, 3, 'Kein Fundstueck darf beim Aufteilen verschwinden');
});

test('Der Memo haelt, bis `items` neu zugewiesen wird', () => {
  const ctx = boardCtx([{ id: 1, status: 'offen', links: [] }]);
  const first = ctx.statusBuckets();
  assert.equal(ctx.statusBuckets(), first, 'gleiche Liste → gleiches Ergebnis-Objekt');
  ctx.items = [{ id: 1, status: 'im_buch', links: [] }, { id: 2, status: 'offen', links: [] }];
  assert.notEqual(ctx.statusBuckets(), first, 'neue Listen-Referenz → neu gerechnet');
  assert.equal(ctx.itemsForStatus('offen').length, 2);
});

test('Stelle im Buch = nur Kapitel/Seite; „eingearbeitet ohne Stelle" ist ein Befund', () => {
  const chapter = { link_id: 1, target_kind: 'chapter', target_id: 7, label: 'Kapitel 1' };
  const figure = { link_id: 2, target_kind: 'figure', target_id: 4, label: 'Anna' };
  const ctx = boardCtx([]);

  const placed = { id: 1, status: 'eingearbeitet', links: [chapter, figure] };
  assert.deepEqual(ctx.placeLinks(placed), [chapter]);
  assert.equal(ctx.otherLinkCount(placed), 1);
  assert.equal(ctx.statusNeedsPlace(placed), false);

  // Als eingearbeitet markiert, aber nirgends steht wo → Befund.
  const unplaced = { id: 2, status: 'eingearbeitet', links: [figure] };
  assert.equal(ctx.statusNeedsPlace(unplaced), true);

  // Auf jeder anderen Stufe ist eine fehlende Stelle normal, kein Befund.
  for (const st of ['offen', 'in_arbeit', 'verworfen']) {
    assert.equal(ctx.statusNeedsPlace({ id: 3, status: st, links: [] }), false, st);
  }
});

test('Die Plakette erscheint nur, wenn die Stufe gesetzt wurde', () => {
  const ctx = boardCtx([]);
  assert.equal(ctx.showStatusBadge({ status: DEFAULT_RESEARCH_STATUS }), false,
    'Der Default traegt keine Plakette — sonst steht an jeder unbearbeiteten Zeile ein Abzeichen ohne Aussage');
  assert.equal(ctx.showStatusBadge({ status: null }), false, 'kein Status = Default');
  for (const st of RESEARCH_STATUSES.slice(1)) {
    assert.equal(ctx.showStatusBadge({ status: st }), true, st);
  }
});

test('Der PATCH-Deskriptor validiert gegen dieselbe Menge', () => {
  const src = read('routes/research.js');
  assert.match(src, /name: 'status',\s+validate: \(v\) => RESEARCH_STATUS_SET\.has\(v\)/,
    'PATCH /research/:id muss `status` gegen RESEARCH_STATUS_SET pruefen, nicht gegen eine eigene Liste');
  assert.match(src, /ri\.status/, 'Die Listen-Route muss `status` mitliefern, sonst hat das Board keine Spalte');
  assert.ok(RESEARCH_STATUS_SET.has('offen') && !RESEARCH_STATUS_SET.has('offen '),
    'RESEARCH_STATUS_SET enthaelt getrimmte Werte');
});
