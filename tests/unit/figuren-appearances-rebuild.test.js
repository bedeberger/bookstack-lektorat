'use strict';
// db/figures.js#rebuildFigureAppearances: baut `figure_appearances` als abgeleiteten
// Index neu auf — Full-Replace an einem Chokepoint, aus drei Quellen (KI-`kapitel`-Feld
// der Figur, Szenen, Lebensereignisse). Der Index ist bewusst NICHT mehr Nebenwirkung
// von saveFigurenToDb: dort liegen zwei der drei Quellen noch nicht vor.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `figuren-app-rebuild-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const {
  rebuildFigureAppearances, saveFigurenToDb, getChapterFigures, listFigurenWithDetails,
} = require('../../db/figures');

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch {} }
});

const BOOK = 6001;
const USER = 'autor@x.ch';
const now = new Date().toISOString();
const idMaps = { chNameToId: { K1: 1, K2: 2, K3: 3, K4: 4 }, pageNameToIdByChapter: {} };

function _apps(figId) {
  const rows = db.prepare(
    'SELECT chapter_id, haeufigkeit FROM figure_appearances WHERE figure_id = ? ORDER BY chapter_id'
  ).all(figId);
  return Object.fromEntries(rows.map(r => [r.chapter_id, r.haeufigkeit]));
}
function _figId(figId) {
  return db.prepare('SELECT id FROM figures WHERE book_id = ? AND fig_id = ? AND user_email = ?')
    .get(BOOK, figId, USER)?.id;
}

// Kapitel: K1 (KI-gemeldet), K2 (nur Szene), K3 (nur Ereignis), K4 (Szene, aber stale)
function seed() {
  db.prepare('INSERT INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'Autor');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'Testbuch', now, now, USER);
  for (const [cid, name, pos] of [[1, 'K1', 0], [2, 'K2', 1], [3, 'K3', 2], [4, 'K4', 3]]) {
    db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(cid, BOOK, name, pos, now);
  }
  const r = db.prepare('INSERT INTO figures (book_id, fig_id, name, user_email, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'fig_1', 'Pamela', USER, now);
  const figId = Number(r.lastInsertRowid);

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

const PAMELA = [{ id: 'fig_1', name: 'Pamela', kapitel: [{ name: 'K1', haeufigkeit: 5 }] }];

test('drei Quellen vereint; KI-Häufigkeit gewinnt, stale-Szene zählt nicht', () => {
  const figId = seed();
  const { figuren, paare } = rebuildFigureAppearances(BOOK, USER, PAMELA, idMaps);
  assert.equal(figuren, 1, 'eine Figur abgedeckt');
  assert.equal(paare, 3, 'K1 (KI) + K2 (Szene) + K3 (Ereignis)');

  const byChap = _apps(figId);
  assert.deepEqual(Object.keys(byChap).map(Number).sort((a, b) => a - b), [1, 2, 3],
    'K4 fehlt, weil seine Szene stale ist');
  assert.equal(byChap[1], 5, 'K1 trägt die KI-Häufigkeit, nicht einen abgeleiteten Zähler');
  assert.equal(byChap[2], 1, 'K2 aus einer Szene');
  assert.equal(byChap[3], 1, 'K3 aus einem Ereignis');
});

test('idempotent: zweiter Aufbau liefert dasselbe Bild', () => {
  const figId = _figId('fig_1');
  const before = _apps(figId);
  const { paare } = rebuildFigureAppearances(BOOK, USER, PAMELA, idMaps);
  assert.equal(paare, 3, 'Full-Replace schreibt wieder alle drei Paare');
  assert.deepEqual(_apps(figId), before, 'Ergebnis unverändert');
});

test('Full-Replace: weggefallenes KI-Kapitel verschwindet, Belege bleiben', () => {
  const figId = _figId('fig_1');
  // Lauf ohne K1 im `kapitel`-Feld — K2/K3 sind weiter über Szene/Ereignis belegt.
  rebuildFigureAppearances(BOOK, USER, [{ id: 'fig_1', name: 'Pamela', kapitel: [] }], idMaps);
  assert.deepEqual(Object.keys(_apps(figId)).map(Number).sort((a, b) => a - b), [2, 3],
    'K1 fällt weg (kein Beleg mehr), K2+K3 bleiben');
  // Zurück auf den vollen Stand für die folgenden Tests.
  rebuildFigureAppearances(BOOK, USER, PAMELA, idMaps);
});

test('stale-Figur behält ihre Kapitel: der Rebuild räumt nur die Figuren des Laufs', () => {
  // Zweite Figur mit einem KI-Kapitel anlegen und indexieren …
  db.prepare('INSERT INTO figures (book_id, fig_id, name, user_email, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'fig_2', 'Nebenfigur', USER, now);
  const nebenId = _figId('fig_2');
  rebuildFigureAppearances(BOOK, USER, [
    ...PAMELA,
    { id: 'fig_2', name: 'Nebenfigur', kapitel: [{ name: 'K1', haeufigkeit: 2 }] },
  ], idMaps);
  assert.deepEqual(_apps(nebenId), { 1: 2 }, 'Nebenfigur indexiert');

  // … und ein Folgelauf enthält sie nicht mehr (sie wäre stale-markiert).
  rebuildFigureAppearances(BOOK, USER, PAMELA, idMaps);
  assert.deepEqual(_apps(nebenId), { 1: 2 },
    'nicht wiedergefundene Figur behält ihre Kapitel – sonst sähe sie kapitellos statt ausgemustert aus');
});

test('leere Lauf-Liste ist ein No-Op, kein Wipe', () => {
  const figId = _figId('fig_1');
  const before = _apps(figId);
  assert.deepEqual(rebuildFigureAppearances(BOOK, USER, [], idMaps), { figuren: 0, paare: 0 });
  assert.deepEqual(rebuildFigureAppearances(BOOK, USER, null, idMaps), { figuren: 0, paare: 0 });
  assert.deepEqual(_apps(figId), before, 'Index unangetastet');
});

test('ohne idMaps bleibt Quelle 1 leer, Szenen/Ereignisse tragen weiter', () => {
  const figId = _figId('fig_1');
  rebuildFigureAppearances(BOOK, USER, PAMELA, null);
  assert.deepEqual(Object.keys(_apps(figId)).map(Number).sort((a, b) => a - b), [2, 3],
    'K1 nicht auflösbar ohne chNameToId; K2+K3 kommen aus der DB');
  rebuildFigureAppearances(BOOK, USER, PAMELA, idMaps);
});

// Der eigentliche Bugfix: der Reconcile in Phase 2 darf den Index nicht leeren. Sonst
// verliert jede Figur mit leerem `kapitel`-Feld ihre Kapitel dauerhaft, wenn der Lauf
// vor dem Szenen-Save abbricht (Abbruch, Provider-Fehler, Timeout).
test('saveFigurenToDb fasst figure_appearances nicht an – auch nicht mit idMaps', () => {
  const figId = _figId('fig_1');
  const before = _apps(figId);
  assert.ok(Object.keys(before).length >= 2, 'Vorbedingung: Index ist gefüllt');

  // Reconcile-Lauf wie in Phase 2, Figur ohne `kapitel`-Feld (der kritische Fall).
  saveFigurenToDb(BOOK, [{ id: 'fig_1', name: 'Pamela', beziehungen: [] }], USER, idMaps,
    { reconcile: true, onMissing: 'stale' });
  assert.deepEqual(_apps(figId), before,
    'Kapitel-Auftritte überleben den Reconcile – der Rebuild am Laufende ist der einzige Schreiber');
});

// Die Lese-Seite des Index. `getChapterFigures` und `listFigurenWithDetails`
// sind zwei Sichten auf dieselben Figuren und treffen im Frontend aufeinander
// (der Referenz-Slot vereinigt Kapitel-Index und Katalog). Sie MUESSEN darum
// dieselbe Identitaet ausliefern: die TEXT-`fig_id`. Mit zwei Achsen (hier die
// Zeilen-ID, dort die fig_id) findet der Vergleich kein Gegenstueck — jede
// Kapitel-Figur gilt als unbekannt und erscheint ein zweites Mal in der Liste,
// waehrend der Figuren-Katalog sie einmal zeigt.
test('getChapterFigures liefert dieselbe Identitaet wie der Figuren-Katalog', () => {
  const kapitelFiguren = getChapterFigures(BOOK, 1, USER);
  assert.ok(kapitelFiguren.length >= 1, 'Vorbedingung: K1 hat Auftritte');
  assert.equal(kapitelFiguren.find(f => f.name === 'Pamela')?.id, 'fig_1',
    '`id` ist die fig_id, nicht die INTEGER-Zeilen-ID');

  const katalogIds = new Set(listFigurenWithDetails(BOOK, USER).figuren.map(f => f.id));
  for (const f of kapitelFiguren) {
    assert.ok(katalogIds.has(f.id), `Kapitel-Figur ${f.name} (${f.id}) hat ein Katalog-Gegenstueck`);
  }

  // Auch der Fallback-Zweig (kein Kapitel bzw. keine Auftritte) spricht die Achse.
  for (const f of getChapterFigures(BOOK, null, USER)) {
    assert.ok(katalogIds.has(f.id), `Fallback-Figur ${f.name} (${f.id}) auf derselben Achse`);
  }
});
