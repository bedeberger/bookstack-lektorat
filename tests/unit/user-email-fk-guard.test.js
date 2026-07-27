'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Eigene Test-DB pro Lauf, sonst kollidiert der Statement-Cache mit anderen
// Suites, die parallel laufen (--test-concurrency=4).
const tmp = path.join('/tmp', `useremail-guard-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');

const USER = 'guard@x.test';
const BOOK = 4711;
const CHAPTER = 991;

// Die geguardeten Tabellen tragen user_email NOT NULL DEFAULT '' plus FK auf
// app_users(email). '' ist keine app_users-Zeile — ohne Guard liefe jeder
// Write mit leerem User in einen FK-Constraint-Fehler, der den Aufrufer nicht
// benennt. Jeder Eintrag: [Name, Funktion, Argumente NACH userEmail].
// userEmail steht bei allen an Position 1 ausser saveSynonymCache (Position 0).
const GUARDED = [
  ['saveCheckpoint',              schema.saveCheckpoint,              ['komplett-analyse', BOOK], [{ step: 1 }]],
  ['saveChapterExtractCache',     schema.saveChapterExtractCache,     [BOOK], [String(CHAPTER), 'sig', { figuren: [] }, 'claude']],
  ['saveChapterReviewCache',      schema.saveChapterReviewCache,      [BOOK], [String(CHAPTER), 'sig', { note: 1 }, 'claude']],
  ['saveBookReviewCache',         schema.saveBookReviewCache,         [BOOK], ['sig', { note: 1 }, 'claude']],
  ['saveChapterMacroReviewCache', schema.saveChapterMacroReviewCache, [BOOK], [CHAPTER, 'sig', { note: 1 }, 'claude']],
  ['saveLektoratCache',           schema.saveLektoratCache,           [BOOK], [1, 'ctxsig', { fehler: [] }, 'claude']],
  ['saveFinetuneAiCache',         schema.saveFinetuneAiCache,         [BOOK], ['fact-qa', 'page:1', 'sig', 'v1', { qa: [] }]],
  ['saveZeitstrahlEvents',        schema.saveZeitstrahlEvents,        [BOOK], [[]]],
  ['saveSynonymCache',            schema.saveSynonymCache,            [],     ['keyhash', { synonyme: [] }, 'claude']],
];

const EMPTY_VALUES = [
  ['null', null],
  ['undefined', undefined],
  ['Leerstring', ''],
  ['nur Whitespace', '   '],
];

test('Schreibpfade auf FK-Tabellen werfen ohne User-Kontext', () => {
  for (const [name, fn, before, after] of GUARDED) {
    for (const [label, value] of EMPTY_VALUES) {
      assert.throws(
        () => fn(...before, value, ...after),
        /user_email fehlt/,
        `${name} haette bei ${label} werfen muessen`,
      );
    }
  }
});

test('Fehlermeldung benennt den Aufrufer', () => {
  assert.throws(
    () => schema.saveCheckpoint('komplett-analyse', BOOK, null, {}),
    /saveCheckpoint\(komplett-analyse\)/,
  );
  assert.throws(
    () => schema.saveFinetuneAiCache(BOOK, '', 'fact-qa', 'page:1', 'sig', 'v1', {}),
    /saveFinetuneAiCache\(fact-qa\)/,
  );
});

test('mit echtem User schreibt und liest der Cache weiterhin', () => {
  appUsers.createUser({ email: USER, displayName: 'Guard' });
  schema.upsertBookByName(BOOK, 'Guard-Testbuch');

  schema.saveCheckpoint('komplett-analyse', BOOK, USER, { step: 7 });
  assert.deepEqual(schema.loadCheckpoint('komplett-analyse', BOOK, USER), { step: 7 });

  schema.saveSynonymCache(USER, 'keyhash', { synonyme: ['gehen'] }, 'claude');
  assert.deepEqual(schema.loadSynonymCache(USER, 'keyhash', 'claude'), { synonyme: ['gehen'] });

  schema.saveFinetuneAiCache(BOOK, USER, 'fact-qa', 'page:1', 'sig', 'v1', { qa: ['x'] });
  assert.deepEqual(
    schema.loadFinetuneAiCache(BOOK, USER, 'fact-qa', 'page:1', 'sig', 'v1'),
    { qa: ['x'] },
  );
});

test('Lese- und Loeschpfade bleiben tolerant (Miss bzw. No-Op)', () => {
  assert.equal(schema.loadCheckpoint('komplett-analyse', BOOK, null), null);
  assert.equal(schema.loadSynonymCache('', 'keyhash', 'claude'), null);
  assert.equal(schema.loadFinetuneAiCache(BOOK, null, 'fact-qa', 'page:1', 'sig', 'v1'), null);

  assert.equal(schema.deleteFinetuneAiCache(BOOK, ''), 0);
  assert.equal(schema.deleteChapterExtractCache(BOOK, null), 0);
  assert.equal(schema.deleteSynonymCache(''), 0);
});
