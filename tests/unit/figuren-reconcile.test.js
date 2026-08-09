'use strict';
// db/figures.js#saveFigurenToDb Reconcile-Modus (Komplettanalyse): figures.id muss
// über Re-Analysen stabil bleiben, damit FK-Referenzen (plot_beat_figures etc.)
// überleben. Verschwundene Figuren werden stale-markiert statt gelöscht; im Buch
// umbenannte Figuren via Indizien-Score wiedererkannt.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `figuren-reconcile-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const { saveFigurenToDb, rebuildFigureAppearances } = require('../../db/figures');

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch {} }
});

const BOOK = 5001;
const USER = 'autor@x.ch';

function _seed() {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO app_users (email, display_name) VALUES (?, ?)')
    .run(USER, 'Autor');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'Testbuch', now, now, USER);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(9001, BOOK, 'Kapitel 1', 0, now);
}

const idMaps = { chNameToId: { 'Kapitel 1': 9001 }, pageNameToIdByChapter: {} };

function _dbId(figId) {
  return db.prepare('SELECT id FROM figures WHERE book_id = ? AND fig_id = ? AND user_email = ?')
    .get(BOOK, figId, USER)?.id;
}

// Ein Komplettanalyse-Lauf, wie ihn job-komplett.js fährt: Figuren reconcilen, danach
// den abgeleiteten Auftritts-Index neu aufbauen. saveFigurenToDb schreibt
// `figure_appearances` bewusst nicht mehr selbst — die Kapitel-Auftritte sind hier
// relevant, weil planFigurenMatch sie als Indizien-Signal fürs Rename-Matching liest.
function _komplettLauf(figuren) {
  saveFigurenToDb(BOOK, figuren, USER, idMaps, { reconcile: true, onMissing: 'stale' });
  rebuildFigureAppearances(BOOK, USER, figuren, idMaps);
}

test('Reconcile: figures.id bleibt stabil + plot_beat_figures überlebt', () => {
  _seed();

  // --- Lauf 1: zwei Figuren ---
  _komplettLauf([
    { id: 'fig_1', name: 'Paul Schmidt', typ: 'hauptfigur', beruf: 'Arzt', geschlecht: 'm',
      kapitel: [{ name: 'Kapitel 1', haeufigkeit: 3 }], eigenschaften: ['mutig'], beziehungen: [] },
    { id: 'fig_2', name: 'Marta Klein', typ: 'nebenfigur', beruf: 'Lehrerin', geschlecht: 'w',
      kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] },
  ]);

  const paulId = _dbId('fig_1');
  const martaId = _dbId('fig_2');
  assert.ok(paulId && martaId, 'beide Figuren angelegt');

  // Externe Referenz simulieren: Plot-Beat zeigt auf Paul.
  db.prepare('INSERT INTO plot_acts (book_id, user_email, name, position) VALUES (?, ?, ?, 0)').run(BOOK, USER, 'Akt 1');
  const actId = db.prepare('SELECT id FROM plot_acts WHERE book_id = ?').get(BOOK).id;
  db.prepare('INSERT INTO plot_beats (act_id, book_id, user_email, titel, sort_order) VALUES (?, ?, ?, ?, 0)').run(actId, BOOK, USER, 'Beat 1');
  const beatId = db.prepare('SELECT id FROM plot_beats WHERE book_id = ?').get(BOOK).id;
  db.prepare('INSERT INTO plot_beat_figures (beat_id, figure_id) VALUES (?, ?)').run(beatId, paulId);

  // --- Lauf 2: Paul bleibt (gleicher Name), Marta verschwindet,
  //     "Hans Weber" ist Marta umbenannt (gleicher Beruf+Kapitel+Geschlecht → Rename-Match),
  //     "Lena Neu" ist echt neu. ---
  _komplettLauf([
    { id: 'fig_1', name: 'Paul Schmidt', typ: 'hauptfigur', beruf: 'Arzt', geschlecht: 'm',
      kapitel: [{ name: 'Kapitel 1', haeufigkeit: 5 }], beziehungen: [] },
    { id: 'fig_2', name: 'Hans Weber', typ: 'nebenfigur', beruf: 'Lehrerin', geschlecht: 'w',
      kapitel: [{ name: 'Kapitel 1', haeufigkeit: 2 }], beziehungen: [] },
    { id: 'fig_3', name: 'Lena Neu', typ: 'randfigur', beruf: 'Bäckerin', geschlecht: 'w',
      kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] },
  ]);

  // Paul: gleiche DB-id (Name-Match Stufe 1).
  assert.equal(_dbId('fig_1'), paulId, 'Paul behält figures.id über Re-Analyse');

  // Plot-Beat-Referenz auf Paul überlebt (kein CASCADE-Wipe).
  const beatRef = db.prepare('SELECT COUNT(*) AS c FROM plot_beat_figures WHERE beat_id = ? AND figure_id = ?').get(beatId, paulId);
  assert.equal(beatRef.c, 1, 'plot_beat_figures-Zuordnung überlebt die Re-Analyse');

  // Marta wurde zu "Hans Weber" umbenannt → Indizien-Match auf dieselbe id (kein orphan).
  const hansId = _dbId('fig_2');
  assert.equal(hansId, martaId, 'umbenannte Figur (Hans=Marta) via Indizien wiedererkannt → id stabil');
  const hansRow = db.prepare('SELECT name, stale FROM figures WHERE id = ?').get(hansId);
  assert.equal(hansRow.name, 'Hans Weber', 'Name aktualisiert');
  assert.equal(hansRow.stale, 0, 'wiedererkannte Figur ist nicht stale');

  // Keine stale-Figur, weil alle bestehenden wiedererkannt wurden.
  const staleCount = db.prepare('SELECT COUNT(*) AS c FROM figures WHERE book_id = ? AND stale = 1').get(BOOK).c;
  assert.equal(staleCount, 0, 'alle Bestandsfiguren gematcht → keine verwaisten');

  // Lena ist neu.
  assert.ok(_dbId('fig_3'), 'neue Figur Lena angelegt');
});

test('Reconcile: echte verschwundene Figur wird stale, nicht gelöscht', () => {
  // Lauf 3: nur noch Paul. Hans + Lena verschwinden ohne Nachfolger.
  _komplettLauf([
    { id: 'fig_1', name: 'Paul Schmidt', typ: 'hauptfigur', beruf: 'Arzt', geschlecht: 'm',
      kapitel: [{ name: 'Kapitel 1', haeufigkeit: 5 }], beziehungen: [] },
  ]);

  const total = db.prepare('SELECT COUNT(*) AS c FROM figures WHERE book_id = ?').get(BOOK).c;
  assert.equal(total, 3, 'verschwundene Figuren bleiben erhalten (Paul + 2 stale)');

  const stale = db.prepare("SELECT name, fig_id, stale FROM figures WHERE book_id = ? AND stale = 1 ORDER BY name").all(BOOK);
  assert.equal(stale.length, 2, 'Hans + Lena als stale markiert');
  assert.ok(stale.every(r => r.fig_id.startsWith('orphan_')), 'stale-fig_id aus dem fig_N-Namespace gezogen');

  // Paul bleibt aktiv mit fig_N.
  const paul = db.prepare("SELECT fig_id, stale FROM figures WHERE book_id = ? AND stale = 0").all(BOOK);
  assert.equal(paul.length, 1);
  assert.equal(paul[0].fig_id, 'fig_1');
});

test('Reconcile: stale-Figur wird revived, wenn sie wieder auftaucht', () => {
  const lenaIdBefore = db.prepare("SELECT id FROM figures WHERE book_id = ? AND name = 'Lena Neu'").get(BOOK)?.id;
  assert.ok(lenaIdBefore, 'Lena existiert (stale) aus Lauf 3');

  // Lauf 4: Lena taucht wieder auf (gleicher Name).
  _komplettLauf([
    { id: 'fig_1', name: 'Paul Schmidt', typ: 'hauptfigur', beruf: 'Arzt', geschlecht: 'm',
      kapitel: [{ name: 'Kapitel 1', haeufigkeit: 5 }], beziehungen: [] },
    { id: 'fig_2', name: 'Lena Neu', typ: 'randfigur', beruf: 'Bäckerin', geschlecht: 'w',
      kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] },
  ]);

  const lenaAfter = db.prepare("SELECT id, fig_id, stale FROM figures WHERE book_id = ? AND name = 'Lena Neu'").get(BOOK);
  assert.equal(lenaAfter.id, lenaIdBefore, 'Lena behält ihre id (revive statt Neuanlage)');
  assert.equal(lenaAfter.stale, 0, 'Lena ist wieder aktiv');
  assert.equal(lenaAfter.fig_id, 'fig_2', 'fig_id zurück im fig_N-Namespace');
});

test('Manual-Edit (matchBy figId): id-stabil, behaltene Figur behält Referenz, gelöschte weg', () => {
  // Stand nach Lauf 4: Paul (fig_1) + Lena (fig_2), beide aktiv.
  const paulId = _dbId('fig_1');
  const lenaId = _dbId('fig_2');
  assert.ok(paulId && lenaId);

  // Externe Referenz auf Lena (simuliert Plot-Beat).
  const beatId = db.prepare('SELECT id FROM plot_beats WHERE book_id = ?').get(BOOK).id;
  db.prepare('INSERT INTO plot_beat_figures (beat_id, figure_id) VALUES (?, ?)').run(beatId, lenaId);

  // Manual-Save: User benennt Paul um (gleiche fig_id, neuer Name), entfernt niemanden,
  // fügt Lena nicht-stale lassend. Kapitel werden round-getrippt, idMaps = null.
  saveFigurenToDb(BOOK, [
    { id: 'fig_1', name: 'Paul Schmidt-Neu', typ: 'hauptfigur', beruf: 'Arzt', geschlecht: 'm',
      kapitel: [{ name: 'Kapitel 1' }], eigenschaften: ['weise'], beziehungen: [] },
    { id: 'fig_2', name: 'Lena Neu', typ: 'randfigur', beruf: 'Bäckerin', geschlecht: 'w',
      kapitel: [{ name: 'Kapitel 1' }], beziehungen: [] },
  ], USER, null, { reconcile: true, matchBy: 'figId', onMissing: 'delete' });

  assert.equal(_dbId('fig_1'), paulId, 'Paul behält id über Manual-Save (fig_id-Match)');
  assert.equal(db.prepare('SELECT name FROM figures WHERE id = ?').get(paulId).name, 'Paul Schmidt-Neu', 'Name aktualisiert');
  // Lena-Referenz überlebt.
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM plot_beat_figures WHERE beat_id = ? AND figure_id = ?').get(beatId, lenaId).c,
    1, 'Plot-Referenz auf Lena überlebt den Manual-Save');
  // Kapitel-Appearance bleibt erhalten: der Manual-Save fasst den abgeleiteten
  // Auftritts-Index gar nicht an (den baut nur rebuildFigureAppearances).
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM figure_appearances WHERE figure_id = ?').get(paulId).c,
    1, 'figure_appearances bleiben beim Manual-Save erhalten');

  // Jetzt: User löscht Lena (nicht mehr in der Liste) → echtes Delete.
  saveFigurenToDb(BOOK, [
    { id: 'fig_1', name: 'Paul Schmidt-Neu', typ: 'hauptfigur', beruf: 'Arzt', geschlecht: 'm',
      kapitel: [{ name: 'Kapitel 1' }], beziehungen: [] },
  ], USER, null, { reconcile: true, matchBy: 'figId', onMissing: 'delete' });

  assert.equal(_dbId('fig_2'), undefined, 'im Katalog entfernte Figur wird gelöscht (nicht stale)');
  assert.equal(_dbId('fig_1'), paulId, 'Paul weiterhin id-stabil');
});
