'use strict';
// routes/jobs/komplett/entity-reconcile.js — KI-Urteil fuer den Graubereich des
// Entitaeten-Matchings.
//
// Warum als eigener Test: die Integration-Suite fahert die Pipeline gegen eine FRISCHE
// DB, dort gibt es keinen Bestand — also keine Cross-Run-Paare, also laeuft der Judge
// nie. Genau die Zustaende, auf die es ankommt (bestaetigt / abgelehnt / Call kaputt /
// Deckel / Doppelzuweisung), sind dort strukturell unerreichbar.
//
// Der `call` wird gestubbt: der Vertrag dieses Moduls ist «was mache ich aus der
// Antwort», nicht «wie antwortet ein Modell».

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `entity-judge-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appSettings = require('../../lib/app-settings');
const { judgeEntityPairs, isJudgeEnabled, JUDGE_PAIR_CAP } = require('../../routes/jobs/komplett/entity-reconcile');

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch {} }
});

// Minimaler ctx: nur was judgeEntityPairs anfasst.
function makeCtx({ answer, throwErr = null, provider = 'claude' } = {}) {
  const calls = [];
  return {
    jobId: 'test-job', bookName: 'Testbuch', tok: {}, effectiveProvider: provider,
    warnings: [],
    log: { info() {}, warn() {} },
    sys: { SYSTEM_ORTE_BLOCKS: [] },
    prompts: {
      SCHEMA_ENTITY_MATCH: {},
      buildEntityMatchJudgePrompt: (bookName, kind, pairs) => {
        calls.push({ kind, pairs });
        return `PROMPT ${kind} ${pairs.length}`;
      },
    },
    call: async () => {
      if (throwErr) throw throwErr;
      return answer;
    },
    _calls: calls,
  };
}

const ORTE_IN = [
  { id: 'ort_1', name: 'Schulhaus Frohheim', typ: 'GEBAEUDE', beschreibung: 'Die Schule im Quartier.' },
  { id: 'ort_2', name: 'Beiz zum Stern', typ: 'GEBAEUDE' },
];
const ORTE_EX = [
  { id: 11, name: 'Frohheim-Schule Olten', typ: 'GEBAEUDE' },
  { id: 12, name: 'Sternen-Wirtschaft', typ: 'GEBAEUDE' },
];
const UNSURE = [
  { index: 0, existingId: 11, sim: 0.4, evidence: 2, reason: 'grey' },
  { index: 1, existingId: 12, sim: 0.3, evidence: 2, reason: 'grey' },
];

test('bestaetigte Paare werden zu Hints, abgelehnte nicht', async () => {
  const ctx = makeCtx({ answer: { paare: [
    { nr: 1, _reasoning: 'dieselbe Schule', gleich: true },
    { nr: 2, _reasoning: 'zwei verschiedene Wirtschaften', gleich: false },
  ] } });
  const hints = await judgeEntityPairs(ctx, 'ort', { incoming: ORTE_IN, existing: ORTE_EX, unsure: UNSURE });
  assert.equal(hints.size, 1);
  assert.equal(hints.get('ort_1'), 11, 'Hint-Key ist die loc_id des Laufs');
  assert.equal(hints.has('ort_2'), false);
});

test('fehlendes/unklares Urteil fuehrt NIE zum Merge', async () => {
  for (const paare of [
    [{ nr: 1 }],                                  // gleich fehlt
    [{ nr: 1, gleich: 'ja' }],                    // nicht boolean true
    [{ nr: 99, gleich: true }],                   // Nummer existiert nicht
    [],                                           // kein Urteil
  ]) {
    const ctx = makeCtx({ answer: { paare } });
    const hints = await judgeEntityPairs(ctx, 'ort', { incoming: ORTE_IN, existing: ORTE_EX, unsure: UNSURE });
    assert.equal(hints.size, 0, `paare=${JSON.stringify(paare)}`);
  }
});

test('kaputter Call und kaputte Antwort sind non-critical (leere Hints + Warnung)', async () => {
  const ctxErr = makeCtx({ throwErr: new Error('upstream 500') });
  const h1 = await judgeEntityPairs(ctxErr, 'ort', { incoming: ORTE_IN, existing: ORTE_EX, unsure: UNSURE });
  assert.equal(h1.size, 0);
  assert.deepEqual(ctxErr.warnings, [{ key: 'job.warn.entityMatchDegraded' }]);

  const ctxBad = makeCtx({ answer: { irgendwas: true } });
  const h2 = await judgeEntityPairs(ctxBad, 'ort', { incoming: ORTE_IN, existing: ORTE_EX, unsure: UNSURE });
  assert.equal(h2.size, 0);
  assert.deepEqual(ctxBad.warnings, [{ key: 'job.warn.entityMatchDegraded' }]);
});

test('AbortError propagiert (Job-Abbruch darf nicht verschluckt werden)', async () => {
  const abort = new Error('abort'); abort.name = 'AbortError';
  const ctx = makeCtx({ throwErr: abort });
  await assert.rejects(
    () => judgeEntityPairs(ctx, 'ort', { incoming: ORTE_IN, existing: ORTE_EX, unsure: UNSURE }),
    /abort/);
});

test('ein Incoming bekommt nur EIN Ziel, eine Bestands-Zeile nur EIN Incoming', async () => {
  // Ambiger Fall: «Bahnhof» passt auf zwei Bestands-Zeilen, das Modell sagt zweimal ja.
  const incoming = [{ id: 'ort_1', name: 'Bahnhof', typ: 'GEBAEUDE' }];
  const existing = [
    { id: 21, name: 'Bahnhof Solothurn', typ: 'GEBAEUDE' },
    { id: 22, name: 'Bahnhof Bern', typ: 'GEBAEUDE' },
  ];
  const unsure = [
    { index: 0, existingId: 21, sim: 0.7, evidence: 1, reason: 'ambiguous' },
    { index: 0, existingId: 22, sim: 0.7, evidence: 0, reason: 'ambiguous' },
  ];
  const ctx = makeCtx({ answer: { paare: [{ nr: 1, gleich: true }, { nr: 2, gleich: true }] } });
  const hints = await judgeEntityPairs(ctx, 'ort', { incoming, existing, unsure });
  assert.equal(hints.size, 1, 'nur das staerkste Urteil zaehlt');
  assert.equal(hints.get('ort_1'), 21);
});

test('Deckel: mehr Verdachtsfaelle als JUDGE_PAIR_CAP werden nicht alle vorgelegt', async () => {
  const n = JUDGE_PAIR_CAP + 6;
  const incoming = Array.from({ length: n }, (_, i) => ({ id: `ort_${i}`, name: `Ort ${i}` }));
  const existing = Array.from({ length: n }, (_, i) => ({ id: 100 + i, name: `Ort ${i} alt` }));
  const unsure = Array.from({ length: n }, (_, i) => ({ index: i, existingId: 100 + i, sim: 0.5, evidence: 1 }));
  const ctx = makeCtx({ answer: { paare: [] } });
  await judgeEntityPairs(ctx, 'ort', { incoming, existing, unsure });
  assert.equal(ctx._calls.length, 1);
  assert.equal(ctx._calls[0].pairs.length, JUDGE_PAIR_CAP);
});

test('kein Graubereich → kein Call', async () => {
  const ctx = makeCtx({ answer: { paare: [] } });
  const hints = await judgeEntityPairs(ctx, 'ort', { incoming: ORTE_IN, existing: ORTE_EX, unsure: [] });
  assert.equal(hints.size, 0);
  assert.equal(ctx._calls.length, 0, 'kein Prompt gebaut');
});

test('Gattungs-Hint-Keys: Figur = fig_id, Szene = titel|kapitel', async () => {
  const ctxF = makeCtx({ answer: { paare: [{ nr: 1, gleich: true }] } });
  const hF = await judgeEntityPairs(ctxF, 'figur', {
    incoming: [{ id: 'fig_7', name: 'Gerold', kapitel: [{ name: 'K1' }] }],
    existing: [{ id: 5, name: 'Gerold Brunner' }],
    unsure: [{ index: 0, existingId: 5, sim: 0.7, evidence: 1 }],
  });
  assert.equal(hF.get('fig_7'), 5);

  const ctxS = makeCtx({ answer: { paare: [{ nr: 1, gleich: true }] } });
  const hS = await judgeEntityPairs(ctxS, 'szene', {
    incoming: [{ titel: 'Ankunft', chapterId: 3, kapitel: 'K1' }],
    existing: [{ id: 9, titel: 'Ankunft am Bahnhof', chapter_id: 3 }],
    unsure: [{ index: 0, existingId: 9, sim: 0.7, evidence: 1 }],
  });
  assert.equal(hS.get('ankunft|3'), 9);
});

test('Gate: nicht-Claude und ausgeschaltetes Setting fahren keinen Call', async () => {
  const ctxLocal = makeCtx({ answer: { paare: [{ nr: 1, gleich: true }] }, provider: 'ollama' });
  const h = await judgeEntityPairs(ctxLocal, 'ort', { incoming: ORTE_IN, existing: ORTE_EX, unsure: UNSURE });
  assert.equal(h.size, 0);
  assert.equal(ctxLocal._calls.length, 0);
  assert.equal(isJudgeEnabled('ollama'), false);

  assert.equal(isJudgeEnabled('claude'), true, 'Default an');
  appSettings.set('ai.komplett.entity_match_judge', false, 'test');
  try {
    assert.equal(isJudgeEnabled('claude'), false);
    const ctxOff = makeCtx({ answer: { paare: [{ nr: 1, gleich: true }] } });
    const hOff = await judgeEntityPairs(ctxOff, 'ort', { incoming: ORTE_IN, existing: ORTE_EX, unsure: UNSURE });
    assert.equal(hOff.size, 0);
    assert.equal(ctxOff._calls.length, 0);
  } finally {
    appSettings.set('ai.komplett.entity_match_judge', true, 'test');
  }
});

// ── Der Zahltag: wirkt der Hint im SCHREIBPFAD? ──────────────────────────────
// Ohne bestaetigtes Urteil bleibt eine Namensvariante ein zweiter Eintrag und die alte
// Zeile wird stale (genau die Dubletten, die man hinterher von Hand zusammenfuehrt).
// Mit Hint behaelt sie ihre locations.id — alle FK-Referenzen darauf ueberleben.
const { saveOrteToDb } = require('../../db/schema');

function seedBookWithLocation(bookId, locName) {
  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run('a@x.ch', 'A');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'B' + bookId, now, now, 'a@x.ch');
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)')
    .run(bookId * 10, bookId, 'Kapitel 1', now);
  db.prepare(`INSERT INTO locations (book_id, loc_id, name, typ, user_email, updated_at)
              VALUES (?, 'ort_1', ?, 'GEBAEUDE', 'a@x.ch', ?)`).run(bookId, locName, now);
  return db.prepare('SELECT id FROM locations WHERE book_id = ?').get(bookId).id;
}

const VARIANT = [{
  id: 'ort_1', name: 'Frohheim-Schule Olten', typ: 'GEBAEUDE',
  kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren: [],
}];
const SAVE_OPTS = { matchBy: 'name', onMissing: 'stale', preserveExistingCoords: true };

test('ohne Hint: unsichere Variante wird ein zweiter Eintrag, alte Zeile stale', () => {
  const book = 8101;
  const oldId = seedBookWithLocation(book, 'Schulhaus Frohheim');
  saveOrteToDb(book, JSON.parse(JSON.stringify(VARIANT)), 'a@x.ch', { 'Kapitel 1': book * 10 }, {}, SAVE_OPTS);
  const rows = db.prepare('SELECT id, name, stale FROM locations WHERE book_id = ? ORDER BY id').all(book);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.id === oldId).stale, 1, 'alte Zeile verwaist');
  assert.ok(rows.some(r => r.name === 'Frohheim-Schule Olten' && !r.stale));
});

test('mit Hint: dieselbe Variante behaelt die locations.id (Referenzen ueberleben)', () => {
  const book = 8102;
  const oldId = seedBookWithLocation(book, 'Schulhaus Frohheim');
  saveOrteToDb(book, JSON.parse(JSON.stringify(VARIANT)), 'a@x.ch', { 'Kapitel 1': book * 10 }, {},
    { ...SAVE_OPTS, matchHint: new Map([['ort_1', oldId]]) });
  const rows = db.prepare('SELECT id, name, stale FROM locations WHERE book_id = ?').all(book);
  assert.equal(rows.length, 1, 'kein zweiter Eintrag');
  assert.equal(rows[0].id, oldId, 'id stabil');
  assert.equal(rows[0].name, 'Frohheim-Schule Olten', 'auf den neuen Namen aktualisiert');
  assert.equal(rows[0].stale, 0);
});

test('Qualifizierer-Konflikt: ein Hint kann ihn ueberstimmen, die Regel nie', () => {
  // «Kreuz (Olten)» vs. «Kreuz (Bern)» trennt die Regel hart — ohne Hint zwei Zeilen.
  const book = 8103;
  const oldId = seedBookWithLocation(book, 'Restaurant Kreuz (Olten)');
  const incoming = [{ id: 'ort_1', name: 'Restaurant Kreuz (Bern)', typ: 'GEBAEUDE', kapitel: [], figuren: [] }];
  saveOrteToDb(book, JSON.parse(JSON.stringify(incoming)), 'a@x.ch', { 'Kapitel 1': book * 10 }, {}, SAVE_OPTS);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM locations WHERE book_id = ?').get(book).n, 2);
  assert.equal(db.prepare('SELECT stale FROM locations WHERE id = ?').get(oldId).stale, 1);
});
