'use strict';
// db/entity-merge.js — manuelles Zusammenfuehren zweier Katalog-Eintraege.
//
// Der Merge existiert, damit die Verknuepfungen eines verwaisten Eintrags
// (Plot-Beats, Recherche-Links, manuell editierte Ereignisse) nicht verloren gehen,
// wenn der Autor erkennt, dass zwei Eintraege dieselbe Figur/denselben Ort/dieselbe
// Szene bezeichnen. Getestet wird genau das: jede Bruecke muss beim Ziel landen,
// Constraint-Kollisionen duerfen nicht werfen, und die FK-Integritaet muss halten.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `entity-merge-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const { mergeFigures, mergeLocations, mergeScenes } = require('../../db/entity-merge');

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch {} }
});

const USER = 'autor@x.ch';
const OTHER = 'fremd@x.ch';
let seq = 0;
const NOW = new Date().toISOString();

function fkClean() {
  return db.pragma('foreign_key_check').length === 0;
}

// Frisches Buch pro Test — die Faelle sollen sich nicht ueber gemeinsame Zeilen
// beeinflussen (ein Merge loescht Zeilen, das faellt sonst dem naechsten Test auf).
function newBook(owner = USER) {
  const bookId = 7000 + (++seq);
  db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(owner, 'A');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'Buch ' + bookId, NOW, NOW, owner);
  return bookId;
}

function addChapter(bookId, name, pos = 0) {
  const id = 90000 + (++seq);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, bookId, name, pos, NOW);
  return id;
}

function addPage(bookId, chapterId, name) {
  const id = 60000 + (++seq);
  db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, body_html, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, bookId, chapterId, name, '<p>x</p>', NOW);
  return id;
}

function addFigur(bookId, figId, name, extra = {}, email = USER) {
  const cols = { book_id: bookId, fig_id: figId, name, updated_at: NOW, user_email: email, ...extra };
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO figures (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => cols[k]));
  return db.prepare('SELECT id FROM figures WHERE book_id = ? AND fig_id = ?').get(bookId, figId).id;
}

function addOrt(bookId, locId, name, extra = {}, email = USER) {
  const cols = { book_id: bookId, loc_id: locId, name, updated_at: NOW, user_email: email, ...extra };
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO locations (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => cols[k]));
  return db.prepare('SELECT id FROM locations WHERE book_id = ? AND loc_id = ?').get(bookId, locId).id;
}

function addSzene(bookId, titel, extra = {}, email = USER) {
  const cols = { book_id: bookId, titel, updated_at: NOW, user_email: email, ...extra };
  const keys = Object.keys(cols);
  const r = db.prepare(`INSERT INTO figure_scenes (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => cols[k]));
  return r.lastInsertRowid;
}

function addEvent(figureId, ereignis, extra = {}) {
  const cols = { figure_id: figureId, datum: '1980', ereignis, ...extra };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO figure_events (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => cols[k])).lastInsertRowid;
}

function addRelation(bookId, from, to, typ, email = USER) {
  return db.prepare(
    'INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, user_email) VALUES (?, ?, ?, ?, ?)'
  ).run(bookId, from, to, typ, email).lastInsertRowid;
}

// Plot-Board-Kette (Akt → Beat), um plot_beat_figures fuellen zu koennen.
function addBeat(bookId) {
  const act = db.prepare(
    'INSERT INTO plot_acts (book_id, user_email, name, position) VALUES (?, ?, ?, 0)'
  ).run(bookId, USER, 'Akt 1').lastInsertRowid;
  return db.prepare(
    'INSERT INTO plot_beats (book_id, user_email, act_id, titel, sort_order) VALUES (?, ?, ?, ?, 0)'
  ).run(bookId, USER, act, 'Beat 1').lastInsertRowid;
}

function addResearchItem(bookId) {
  return db.prepare(
    'INSERT INTO research_items (book_id, user_email, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(bookId, USER, 'Fundstueck', NOW, NOW).lastInsertRowid;
}

function linkResearch(itemId, kind, col, id) {
  return db.prepare(
    `INSERT INTO research_item_links (item_id, target_kind, ${col}) VALUES (?, ?, ?)`
  ).run(itemId, kind, id).lastInsertRowid;
}

test('Figuren-Merge: alle Referenzen der Quelle landen beim Ziel, Quelle ist weg', () => {
  const book = newBook();
  const ch = addChapter(book, 'Kapitel 1');
  const src = addFigur(book, 'fig_1', 'Gerold');
  const tgt = addFigur(book, 'fig_2', 'Gerold Brunner');
  const dritte = addFigur(book, 'fig_3', 'Marta');

  const beat = addBeat(book);
  const item = addResearchItem(book);
  const szene = addSzene(book, 'Ankunft');
  const ort = addOrt(book, 'ort_1', 'Bahnhof');

  db.prepare('INSERT INTO plot_beat_figures (beat_id, figure_id) VALUES (?, ?)').run(beat, src);
  linkResearch(item, 'figure', 'figure_id', src);
  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(szene, src);
  db.prepare('INSERT INTO location_figures (location_id, figure_id) VALUES (?, ?)').run(ort, src);
  db.prepare('INSERT INTO figure_tags (figure_id, tag) VALUES (?, ?)').run(src, 'mutig');
  db.prepare('INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)').run(src, ch, 3);
  addEvent(src, 'Zieht nach Bern');
  addRelation(book, src, dritte, 'freund');

  const r = mergeFigures(book, USER, src, tgt);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM figures WHERE id = ?').get(src).n, 0, 'Quelle geloescht');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM plot_beat_figures WHERE beat_id = ? AND figure_id = ?').get(beat, tgt).n, 1);
  assert.equal(db.prepare('SELECT figure_id FROM research_item_links WHERE id = ?').get(
    db.prepare('SELECT id FROM research_item_links WHERE item_id = ?').get(item).id).figure_id, tgt);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scene_figures WHERE scene_id = ? AND figure_id = ?').get(szene, tgt).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM location_figures WHERE location_id = ? AND figure_id = ?').get(ort, tgt).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM figure_tags WHERE figure_id = ? AND tag = ?').get(tgt, 'mutig').n, 1);
  assert.equal(db.prepare('SELECT haeufigkeit h FROM figure_appearances WHERE figure_id = ? AND chapter_id = ?').get(tgt, ch).h, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM figure_events WHERE figure_id = ?').get(tgt).n, 1);
  assert.equal(db.prepare('SELECT from_fig_id f FROM figure_relations WHERE to_fig_id = ?').get(dritte).f, tgt);
  assert.equal(r.sourceName, 'Gerold');
  assert.equal(r.targetName, 'Gerold Brunner');
  assert.ok(fkClean(), 'foreign_key_check leer');
});

test('Figuren-Merge: Composite-PK-Kollision wirft nicht und hinterlaesst eine Zeile', () => {
  const book = newBook();
  const src = addFigur(book, 'fig_1', 'A');
  const tgt = addFigur(book, 'fig_2', 'B');
  const szene = addSzene(book, 'Gemeinsame Szene');
  const ort = addOrt(book, 'ort_1', 'Platz');
  const beat = addBeat(book);
  // Beide Figuren haengen an derselben Szene / demselben Ort / demselben Beat.
  for (const fid of [src, tgt]) {
    db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(szene, fid);
    db.prepare('INSERT INTO location_figures (location_id, figure_id) VALUES (?, ?)').run(ort, fid);
    db.prepare('INSERT INTO plot_beat_figures (beat_id, figure_id) VALUES (?, ?)').run(beat, fid);
    db.prepare('INSERT INTO figure_tags (figure_id, tag) VALUES (?, ?)').run(fid, 'geteilt');
  }

  assert.doesNotThrow(() => mergeFigures(book, USER, src, tgt));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scene_figures WHERE scene_id = ?').get(szene).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM location_figures WHERE location_id = ?').get(ort).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM plot_beat_figures WHERE beat_id = ?').get(beat).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM figure_tags WHERE figure_id = ?').get(tgt).n, 1);
  assert.ok(fkClean());
});

test('Figuren-Merge: Kapitel-Haeufigkeit wird summiert, Seiten-Nennungen ebenso', () => {
  const book = newBook();
  const ch = addChapter(book, 'Kapitel 1');
  const page = addPage(book, ch, 'Seite 1');
  const src = addFigur(book, 'fig_1', 'A');
  const tgt = addFigur(book, 'fig_2', 'B');
  db.prepare('INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)').run(src, ch, 4);
  db.prepare('INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)').run(tgt, ch, 6);
  db.prepare('INSERT INTO page_figure_mentions (page_id, figure_id, count, first_offset) VALUES (?, ?, ?, ?)').run(page, src, 2, 50);
  db.prepare('INSERT INTO page_figure_mentions (page_id, figure_id, count, first_offset) VALUES (?, ?, ?, ?)').run(page, tgt, 3, 120);

  mergeFigures(book, USER, src, tgt);

  assert.equal(db.prepare('SELECT haeufigkeit h FROM figure_appearances WHERE figure_id = ?').get(tgt).h, 10);
  const m = db.prepare('SELECT count, first_offset FROM page_figure_mentions WHERE figure_id = ?').get(tgt);
  assert.equal(m.count, 5);
  assert.equal(m.first_offset, 50, 'frueheste Fundstelle gewinnt');
  assert.ok(fkClean());
});

test('Figuren-Merge: Beziehung Quelle↔Ziel verschwindet statt Selbstbezug zu werden', () => {
  const book = newBook();
  const src = addFigur(book, 'fig_1', 'A');
  const tgt = addFigur(book, 'fig_2', 'B');
  addRelation(book, src, tgt, 'freund');

  const r = mergeFigures(book, USER, src, tgt);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM figure_relations WHERE book_id = ?').get(book).n, 0);
  assert.ok(r.relationsDropped >= 1);
  assert.ok(fkClean());
});

test('Figuren-Merge: UNIQUE-Dublette und Paar-Dublette gleichen Typs fallen weg', () => {
  const book = newBook();
  const src = addFigur(book, 'fig_1', 'A');
  const tgt = addFigur(book, 'fig_2', 'B');
  const x = addFigur(book, 'fig_3', 'X');
  // Beide Figuren haben dieselbe Beziehung zu X (nach dem Remap eine UNIQUE-Kollision).
  addRelation(book, src, x, 'freund');
  addRelation(book, tgt, x, 'freund');
  // Gegenrichtung gleichen Typs → ungeordnete Paar-Dublette.
  addRelation(book, x, src, 'freund');

  mergeFigures(book, USER, src, tgt);

  const rels = db.prepare('SELECT from_fig_id, to_fig_id, typ FROM figure_relations WHERE book_id = ?').all(book);
  assert.equal(rels.length, 1, 'genau eine Beziehung B↔X uebrig');
  assert.ok(rels[0].from_fig_id === tgt || rels[0].to_fig_id === tgt);
  assert.ok(fkClean());
});

test('Figuren-Merge: gerichtete Gegenrichtung anderen Typs bleibt erhalten', () => {
  const book = newBook();
  const src = addFigur(book, 'fig_1', 'A');
  const tgt = addFigur(book, 'fig_2', 'B');
  const x = addFigur(book, 'fig_3', 'X');
  addRelation(book, src, x, 'elternteil');
  addRelation(book, x, tgt, 'mentor');

  mergeFigures(book, USER, src, tgt);

  const typen = db.prepare('SELECT typ FROM figure_relations WHERE book_id = ? ORDER BY typ').all(book).map(r => r.typ);
  assert.deepEqual(typen, ['elternteil', 'mentor'], 'kein Informationsverlust bei verschiedenen Typen');
  assert.ok(fkClean());
});

test('Figuren-Merge: identische Ereignisse werden dedupliziert, manuell editierte gewinnen', () => {
  const book = newBook();
  const src = addFigur(book, 'fig_1', 'A');
  const tgt = addFigur(book, 'fig_2', 'B');
  addEvent(src, 'Heirat', { datum_year: 1990, manually_edited: 1, bedeutung: 'vom Autor gepflegt' });
  addEvent(tgt, 'heirat  ', { datum_year: 1990 });
  addEvent(src, 'Umzug', { datum_year: 1995 });

  const r = mergeFigures(book, USER, src, tgt);

  const evs = db.prepare('SELECT ereignis, manually_edited, bedeutung FROM figure_events WHERE figure_id = ? ORDER BY ereignis').all(tgt);
  assert.equal(evs.length, 2);
  assert.equal(r.eventsDeduped, 1);
  const heirat = evs.find(e => e.ereignis.trim().toLowerCase() === 'heirat');
  assert.equal(heirat.manually_edited, 1, 'die manuell editierte Zeile ueberlebt');
  assert.equal(heirat.bedeutung, 'vom Autor gepflegt');
  assert.ok(fkClean());
});

test('Figuren-Merge: leere Ziel-Felder werden gefuellt, belegte nie ueberschrieben', () => {
  const book = newBook();
  const src = addFigur(book, 'fig_1', 'Gerold', { beruf: 'Schmied', beschreibung: 'aus der Quelle', geschlecht: 'm' });
  const tgt = addFigur(book, 'fig_2', 'Gerold Brunner', { beschreibung: 'bleibt stehen' });

  const r = mergeFigures(book, USER, src, tgt);
  const row = db.prepare('SELECT name, kurzname, beruf, beschreibung, geschlecht FROM figures WHERE id = ?').get(tgt);

  assert.equal(row.beschreibung, 'bleibt stehen', 'Bestandswert unangetastet');
  assert.equal(row.beruf, 'Schmied');
  assert.equal(row.geschlecht, 'm');
  assert.equal(row.kurzname, 'Gerold', 'Quell-Name als Alias gesichert');
  assert.equal(row.name, 'Gerold Brunner');
  assert.ok(r.filled.includes('beruf'));
  assert.ok(!r.filled.includes('beschreibung'));
});

test('Figuren-Merge: gleichnamige Dublette setzt keinen kurzname == name', () => {
  const book = newBook();
  const src = addFigur(book, 'fig_1', 'Gerold Brunner');
  const tgt = addFigur(book, 'fig_2', 'gerold  brunner');

  mergeFigures(book, USER, src, tgt);

  assert.equal(db.prepare('SELECT kurzname FROM figures WHERE id = ?').get(tgt).kurzname, null);
});

test('Figuren-Merge: nullable Einzel-Referenzen wandern mit', () => {
  const book = newBook();
  const ch = addChapter(book, 'Kapitel 1');
  const src = addFigur(book, 'fig_1', 'A');
  const tgt = addFigur(book, 'fig_2', 'B');

  db.prepare('INSERT INTO chapter_narrative_profile (book_id, user_email, chapter_id, sort_order, erzaehler_figur_id) VALUES (?, ?, ?, 0, ?)')
    .run(book, USER, ch, src);
  db.prepare('INSERT INTO plot_threads (book_id, user_email, name, figure_id, position) VALUES (?, ?, ?, ?, 0)')
    .run(book, USER, 'Strang', src);
  db.prepare('INSERT INTO draft_figures (book_id, user_email, name, mindmap_json, source_figure_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(book, USER, 'Entwurf', '{}', src, NOW, NOW);
  const check = db.prepare('INSERT INTO continuity_checks (book_id, user_email, checked_at) VALUES (?, ?, ?)')
    .run(book, USER, NOW).lastInsertRowid;
  const issue = db.prepare('INSERT INTO continuity_issues (check_id, book_id, typ, schwere, beschreibung) VALUES (?, ?, ?, ?, ?)')
    .run(check, book, 'zeitlinie', 'mittel', 'x').lastInsertRowid;
  db.prepare('INSERT INTO continuity_issue_figures (issue_id, figure_id, figur_name) VALUES (?, ?, ?)')
    .run(issue, src, 'A');
  const zEvent = db.prepare('INSERT INTO zeitstrahl_events (book_id, user_email, datum, ereignis) VALUES (?, ?, ?, ?)')
    .run(book, USER, '1980', 'Ereignis').lastInsertRowid;
  db.prepare('INSERT INTO zeitstrahl_event_figures (event_id, figure_id, figur_name) VALUES (?, ?, ?)')
    .run(zEvent, src, 'A');

  mergeFigures(book, USER, src, tgt);

  assert.equal(db.prepare('SELECT erzaehler_figur_id x FROM chapter_narrative_profile WHERE chapter_id = ?').get(ch).x, tgt);
  assert.equal(db.prepare('SELECT figure_id x FROM plot_threads WHERE book_id = ?').get(book).x, tgt);
  assert.equal(db.prepare('SELECT source_figure_id x FROM draft_figures WHERE book_id = ?').get(book).x, tgt);
  assert.equal(db.prepare('SELECT figure_id x FROM continuity_issue_figures WHERE issue_id = ?').get(issue).x, tgt);
  assert.equal(db.prepare('SELECT figure_id x FROM zeitstrahl_event_figures WHERE event_id = ?').get(zEvent).x, tgt);
  assert.ok(fkClean());
});

test('Figuren-Merge: Guards — fremdes Buch, fremder User, identische ids', () => {
  const bookA = newBook();
  const bookB = newBook();
  const a = addFigur(bookA, 'fig_1', 'A');
  const b = addFigur(bookB, 'fig_1', 'B');
  db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(OTHER, 'F');
  const fremd = addFigur(bookA, 'fig_9', 'Fremd', {}, OTHER);

  assert.throws(() => mergeFigures(bookA, USER, a, b), /nicht in Buch/);
  assert.throws(() => mergeFigures(bookA, USER, a, fremd), /nicht in Buch/);
  assert.throws(() => mergeFigures(bookA, USER, a, a), /identisch/);
  assert.throws(() => mergeFigures(bookA, USER, a, 999999), /nicht in Buch/);
  // Nichts angefasst.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM figures WHERE book_id = ?').get(bookA).n, 2);
});

test('Schauplatz-Merge: Kapitel summiert, Bruecken umgehaengt, Quelle weg', () => {
  const book = newBook();
  const ch = addChapter(book, 'Kapitel 1');
  const src = addOrt(book, 'ort_1', 'Bahnhof', { beschreibung: 'aus der Quelle', lat: 47.1, lng: 7.2 });
  const tgt = addOrt(book, 'ort_2', 'Bahnhof Bettlach');
  const fig = addFigur(book, 'fig_1', 'A');
  const szene = addSzene(book, 'Ankunft');
  const item = addResearchItem(book);

  db.prepare('INSERT INTO location_chapters (location_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)').run(src, ch, 2);
  db.prepare('INSERT INTO location_chapters (location_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)').run(tgt, ch, 5);
  db.prepare('INSERT INTO location_figures (location_id, figure_id) VALUES (?, ?)').run(src, fig);
  db.prepare('INSERT INTO scene_locations (scene_id, location_id) VALUES (?, ?)').run(szene, src);
  linkResearch(item, 'location', 'location_id', src);

  const r = mergeLocations(book, USER, src, tgt);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM locations WHERE id = ?').get(src).n, 0);
  assert.equal(db.prepare('SELECT haeufigkeit h FROM location_chapters WHERE location_id = ?').get(tgt).h, 7);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM location_figures WHERE location_id = ? AND figure_id = ?').get(tgt, fig).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scene_locations WHERE scene_id = ? AND location_id = ?').get(szene, tgt).n, 1);
  assert.equal(db.prepare('SELECT location_id x FROM research_item_links WHERE item_id = ?').get(item).x, tgt);
  const row = db.prepare('SELECT beschreibung, lat, lng FROM locations WHERE id = ?').get(tgt);
  assert.equal(row.beschreibung, 'aus der Quelle');
  assert.equal(row.lat, 47.1, 'Koordinaten der Quelle retten den Ziel-Eintrag');
  assert.equal(r.sourceName, 'Bahnhof');
  assert.ok(fkClean());
});

test('Schauplatz-Merge: geteilte Szene kollidiert nicht', () => {
  const book = newBook();
  const src = addOrt(book, 'ort_1', 'A');
  const tgt = addOrt(book, 'ort_2', 'B');
  const szene = addSzene(book, 'Szene');
  db.prepare('INSERT INTO scene_locations (scene_id, location_id) VALUES (?, ?)').run(szene, src);
  db.prepare('INSERT INTO scene_locations (scene_id, location_id) VALUES (?, ?)').run(szene, tgt);

  assert.doesNotThrow(() => mergeLocations(book, USER, src, tgt));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scene_locations WHERE scene_id = ?').get(szene).n, 1);
  assert.ok(fkClean());
});

test('Szenen-Merge: Figuren/Orte/Songs/Recherche wandern, Quelle weg', () => {
  const book = newBook();
  const ch = addChapter(book, 'Kapitel 1');
  const src = addSzene(book, 'Ankunft am Bahnhof', { kommentar: 'aus der Quelle', chapter_id: ch });
  const tgt = addSzene(book, 'Ankunft');
  const fig = addFigur(book, 'fig_1', 'A');
  const ort = addOrt(book, 'ort_1', 'Bahnhof');
  const song = db.prepare('INSERT INTO songs (book_id, user_email, song_uid, titel, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(book, USER, 'song_1', 'Lied', NOW).lastInsertRowid;
  const item = addResearchItem(book);

  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(src, fig);
  db.prepare('INSERT INTO scene_locations (scene_id, location_id) VALUES (?, ?)').run(src, ort);
  db.prepare('INSERT INTO song_scenes (scene_id, song_id) VALUES (?, ?)').run(src, song);
  linkResearch(item, 'scene', 'scene_id', src);

  const r = mergeScenes(book, USER, src, tgt);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM figure_scenes WHERE id = ?').get(src).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scene_figures WHERE scene_id = ? AND figure_id = ?').get(tgt, fig).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scene_locations WHERE scene_id = ? AND location_id = ?').get(tgt, ort).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM song_scenes WHERE scene_id = ? AND song_id = ?').get(tgt, song).n, 1);
  assert.equal(db.prepare('SELECT scene_id x FROM research_item_links WHERE item_id = ?').get(item).x, tgt);
  const row = db.prepare('SELECT kommentar, chapter_id FROM figure_scenes WHERE id = ?').get(tgt);
  assert.equal(row.kommentar, 'aus der Quelle');
  assert.equal(row.chapter_id, ch, 'Kapitel-Zuordnung der Quelle rettet die verwaiste Szene');
  assert.equal(r.sourceName, 'Ankunft am Bahnhof');
  assert.ok(fkClean());
});

test('Szenen-Merge: dieselbe Figur an beiden Szenen kollidiert nicht', () => {
  const book = newBook();
  const src = addSzene(book, 'A');
  const tgt = addSzene(book, 'B');
  const fig = addFigur(book, 'fig_1', 'F');
  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(src, fig);
  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(tgt, fig);

  assert.doesNotThrow(() => mergeScenes(book, USER, src, tgt));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scene_figures WHERE figure_id = ?').get(fig).n, 1);
  assert.ok(fkClean());
});

test('Recherche-Link auf beide Seiten: UNIQUE-Tupel kollidiert nicht, ein Link bleibt', () => {
  const book = newBook();
  const src = addFigur(book, 'fig_1', 'A');
  const tgt = addFigur(book, 'fig_2', 'B');
  const item = addResearchItem(book);
  linkResearch(item, 'figure', 'figure_id', src);
  linkResearch(item, 'figure', 'figure_id', tgt);

  assert.doesNotThrow(() => mergeFigures(book, USER, src, tgt));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM research_item_links WHERE item_id = ?').get(item).n, 1);
  assert.ok(fkClean());
});
