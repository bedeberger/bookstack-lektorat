// Unit: Lesepfad der Welt-Fakten — Kategorien-Filter, Kapitel-JOIN und die
// Unterscheidung „nie analysiert" vs. „analysiert, nichts gefunden".
//
// Letztere ist die eigentliche Invariante: ein leerer Index darf NICHT als
// „dieses Buch hat keine Welt" gelesen werden. Ohne sie meldet die Plot-Pruefung
// „verletzt keine Weltregel", die Bewertung liest 0 Fakten als weltarm und die
// Karte fordert eine Komplettanalyse, die langst gelaufen ist.
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.DB_PATH = path.join('/tmp', `wf-read-test-${process.pid}-${Date.now()}.db`);
const schema = require('../../db/schema');
const db = schema.db;

const BOOK = 710;
const USER = 'wfread@test.dev';

function setup() {
  // job_runs.user_email ist FK auf app_users(email) — der Testuser muss existieren.
  db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(USER);
  schema.upsertBookByName(BOOK, 'Welt-Buch');
  db.prepare('INSERT OR IGNORE INTO chapters (chapter_id, book_id, chapter_name, position) VALUES (?, ?, ?, ?)')
    .run(7101, BOOK, 'Kapitel 1', 1);
  db.prepare('INSERT OR IGNORE INTO chapters (chapter_id, book_id, chapter_name, position) VALUES (?, ?, ?, ?)')
    .run(7102, BOOK, 'Kapitel 2', 2);
  db.prepare('DELETE FROM job_runs WHERE book_id = ?').run(BOOK);
  schema.saveFaktenToDb(BOOK, [], USER, {});
}

test('worldFactsScanState: leer + kein Lauf → nicht gescannt', () => {
  setup();
  assert.deepEqual(schema.worldFactsScanState(BOOK, USER), { scanned: false, count: 0 });
});

test('worldFactsScanState: leer, aber abgeschlossener komplett-analyse-Lauf → gescannt', () => {
  setup();
  db.prepare(`INSERT INTO job_runs (job_id, type, book_id, user_email, status, queued_at)
              VALUES (?, 'komplett-analyse', ?, ?, 'done', '2026-01-01T00:00:00.000Z')`)
    .run(`jr-done-${Date.now()}`, BOOK, USER);
  assert.deepEqual(schema.worldFactsScanState(BOOK, USER), { scanned: true, count: 0 });
});

test('worldFactsScanState: abgebrochener Lauf zaehlt nicht als gescannt', () => {
  setup();
  db.prepare(`INSERT INTO job_runs (job_id, type, book_id, user_email, status, queued_at)
              VALUES (?, 'komplett-analyse', ?, ?, 'error', '2026-01-01T00:00:00.000Z')`)
    .run(`jr-err-${Date.now()}`, BOOK, USER);
  assert.equal(schema.worldFactsScanState(BOOK, USER).scanned, false);
});

test('worldFactsScanState: vorhandene Fakten reichen (importiertes Buch ohne Job-Lauf)', () => {
  setup();
  schema.saveFaktenToDb(BOOK, [{ kapitel: 'Kapitel 1', fakten: [
    { kategorie: 'regel', subjekt: 'Magie', fakt: 'Tote kehren nie zurueck.' },
  ] }], USER, { 'Kapitel 1': 7101 });
  assert.deepEqual(schema.worldFactsScanState(BOOK, USER), { scanned: true, count: 1 });
});

test('listWorldFacts: Kapitelnamen per JOIN, eine Zeile je Fakt', () => {
  setup();
  schema.saveFaktenToDb(BOOK, [
    { kapitel: 'Kapitel 1', fakten: [{ kategorie: 'regel', subjekt: 'Magie', fakt: 'Zauber kostet Lebenszeit.', seite: 'S3' }] },
    { kapitel: 'Kapitel 2', fakten: [{ kategorie: 'kultur', fakt: 'Man grüsst mit der linken Hand.' }] },
  ], USER, { 'Kapitel 1': 7101, 'Kapitel 2': 7102 });

  const rows = schema.listWorldFacts(BOOK, USER);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].kapitel, ['Kapitel 1']);
  assert.equal(rows[0].subjekt, 'Magie');
  assert.equal(rows[0].seite, 'S3');
  assert.deepEqual(rows[1].kapitel, ['Kapitel 2']);
  assert.equal(rows[1].subjekt, null);
});

test('listWorldFacts: kategorien filtert; leere Liste heisst „nichts davon", nicht „alles"', () => {
  setup();
  schema.saveFaktenToDb(BOOK, [{ kapitel: 'Kapitel 1', fakten: [
    { kategorie: 'regel', fakt: 'Weltgesetz A.' },
    { kategorie: 'technik', fakt: 'Weltgesetz B.' },
    { kategorie: 'kultur', fakt: 'Beiwerk C.' },
  ] }], USER, { 'Kapitel 1': 7101 });

  const gesetze = schema.listWorldFacts(BOOK, USER, { kategorien: ['regel', 'technik'] });
  assert.deepEqual(gesetze.map(f => f.fakt), ['Weltgesetz A.', 'Weltgesetz B.']);
  assert.deepEqual(schema.listWorldFacts(BOOK, USER, { kategorien: [] }), []);
  // Unbekannte Kategorie wird verworfen → wie leere Liste, nicht wie „ohne Filter".
  assert.deepEqual(schema.listWorldFacts(BOOK, USER, { kategorien: ['gibtsnicht'] }), []);
  assert.equal(schema.listWorldFacts(BOOK, USER).length, 3);
});
