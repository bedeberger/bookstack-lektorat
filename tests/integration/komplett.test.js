'use strict';
// Integration test: runKomplettAnalyseJob single-pass.
// Pipeline: Phase 1 (extraction) → Phase 2/3 skipped (single-pass)
// → Phase 6 Zeitstrahl skipped (< 5 events) → Phase 8 Kontinuität.
// Expected: 2 AI calls (P1 + P8).

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.mockBs.reset();
});

function seedTinyBook(bookId) {
  ctx.mockBs.setBook({
    chapters: [{ id: 1100, book_id: bookId, name: 'Kapitel Eins' }],
    pages: [{ id: 1200, book_id: bookId, chapter_id: 1100, name: 'Seite Eins', updated_at: '2026-01-01' }],
    pageBodies: { 1200: '<p>' + 'Anna ging in den Wald. Es war kalt. '.repeat(40) + '</p>' },
  });
}

function extraktionResponse() {
  return {
    figuren: [{
      id: 'fig_1', name: 'Anna', kurzname: 'Anna', typ: 'protagonist',
      beschreibung: 'Hauptfigur', sozialschicht: 'mitte', praesenz: 'zentral',
      kapitel: [{ name: 'Kapitel Eins', haeufigkeit: 1 }],
      beziehungen: [], eigenschaften: [], schluesselzitate: [],
    }],
    orte: [{
      id: 'ort_1', name: 'Wald', typ: 'natur', beschreibung: 'kalt',
      kapitel: [{ name: 'Kapitel Eins', haeufigkeit: 1 }], figuren: ['fig_1'],
    }],
    fakten: [{ kategorie: 'wetter', subjekt: 'Wald', fakt: 'kalt', seite: 'Seite Eins' }],
    szenen: [{
      seite: 'Seite Eins', kapitel: 'Kapitel Eins', titel: 'Anna im Wald',
      wertung: 'mittel', kommentar: 'kurze Szene',
      figuren_namen: ['Anna'], orte_namen: ['Wald'],
    }],
    assignments: [{ figur_name: 'Anna', lebensereignisse: [] }],
  };
}

function kontinuitaetResponse() {
  return {
    zusammenfassung: 'Stimmig.',
    probleme: [],
  };
}

test('Komplettanalyse Single-Pass: 1 Kapitel, P1 + P8 → done', async () => {
  const BOOK_ID = 50;
  seedTinyBook(BOOK_ID);

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('orte') && e.schemaKeys.includes('assignments'),
    extraktionResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    kontinuitaetResponse(),
  );

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Testbuch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );

  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.figCount, 1);
  assert.equal(job.result.orteCount, 1);
  assert.equal(job.result.szenenCount, 1);
  assert.equal(job.passMode, 'single');

  // Exactly 2 AI calls: P1 + P8.
  assert.equal(ctx.mockAi.log.length, 2, `expected 2 AI calls, got ${ctx.mockAi.log.length}`);

  // Figures saved.
  const figRows = ctx.dbSchema.db.prepare(
    'SELECT name, typ FROM figures WHERE book_id = ? AND user_email = ?'
  ).all(BOOK_ID, 'tester@test.dev');
  assert.equal(figRows.length, 1);
  assert.equal(figRows[0].name, 'Anna');

  // Locations saved.
  const ortRows = ctx.dbSchema.db.prepare(
    'SELECT name FROM locations WHERE book_id = ? AND user_email = ?'
  ).all(BOOK_ID, 'tester@test.dev');
  assert.equal(ortRows.length, 1);
  assert.equal(ortRows[0].name, 'Wald');

  // Continuity check stored.
  const cont = ctx.dbSchema.getLatestContinuityCheck(BOOK_ID, 'tester@test.dev');
  assert.ok(cont);
  assert.equal(cont.summary, 'Stimmig.');
});

test('Komplettanalyse: leeres Buch → result.empty, kein AI-Call', async () => {
  const BOOK_ID = 51;
  ctx.mockBs.setBook({ chapters: [], pages: [], pageBodies: {} });

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Leer', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.empty, true);
  assert.equal(ctx.mockAi.log.length, 0);
});

function seedMultiChapterBook(bookId, chapters = 3) {
  const cs = [];
  const ps = [];
  const bodies = {};
  for (let i = 0; i < chapters; i++) {
    const cid = 2000 + i;
    const pid = 3000 + i;
    cs.push({ id: cid, book_id: bookId, name: `Kapitel ${i + 1}` });
    ps.push({ id: pid, book_id: bookId, chapter_id: cid, name: `Seite ${i + 1}`, updated_at: '2026-01-01' });
    // ~9000 chars body each → 27K total → multi-pass with 3 chunks under PER_CHUNK_LIMIT=10000.
    bodies[pid] = '<p>' + 'Anna ging weiter durch das Land. '.repeat(280) + '</p>';
  }
  ctx.mockBs.setBook({ chapters: cs, pages: ps, pageBodies: bodies });
}

function extraktionResponseFor(chapterName) {
  return {
    figuren: [{
      id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist',
      beschreibung: 'Hauptfigur', sozialschicht: 'mitte', praesenz: 'zentral',
      kapitel: [{ name: chapterName, haeufigkeit: 1 }],
      beziehungen: [], eigenschaften: [], schluesselzitate: [],
    }],
    orte: [{
      id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: 'weit',
      kapitel: [{ name: chapterName, haeufigkeit: 1 }], figuren: ['fig_anna'],
    }],
    fakten: [],
    szenen: [{
      seite: 'Seite', kapitel: chapterName, titel: 'Anna unterwegs',
      wertung: 'mittel', kommentar: 'k', figuren_namen: ['Anna'], orte_namen: ['Land'],
    }],
    assignments: [{ figur_name: 'Anna', lebensereignisse: [] }],
  };
}

test('Komplettanalyse Multi-Pass: 3 Kapitel → 3 P1-Chunks + Konsol-Calls', async () => {
  const BOOK_ID = 60;
  seedMultiChapterBook(BOOK_ID, 3);

  // Phase 1 extraction (combined schema, claude path) — return same Anna across chunks.
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('orte') && e.schemaKeys.includes('assignments'),
    ({ prompt }) => {
      const m = prompt.match(/Kapitel \d+/);
      return extraktionResponseFor(m ? m[0] : 'Kapitel');
    },
  );
  // Phase 2 figuren consolidation.
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('figuren'),
    {
      figuren: [{
        id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist',
        beschreibung: 'Hauptfigur', sozialschicht: 'mitte', praesenz: 'zentral',
        kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }],
        beziehungen: [], eigenschaften: [], schluesselzitate: [],
      }],
    },
  );
  // Phase 3 orte consolidation.
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('orte'),
    {
      orte: [{
        id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: 'weit',
        kapitel: [{ name: 'Kapitel 1', haeufigkeit: 3 }], figuren: ['fig_anna'],
      }],
    },
  );
  // Phase 8 kontinuität.
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    kontinuitaetResponse(),
  );

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.passMode, 'multi');
  assert.equal(job.result.figCount, 1);
  assert.equal(job.result.orteCount, 1);

  // 3 P1 chunks + 1 P2 + 1 P3 + 1 P8 = 6.
  // (P3b skipped: figuren.length=1 < 2; Zeitstrahl skipped: 0 events; Soziogramm skipped: < 4 figuren.)
  assert.equal(ctx.mockAi.log.length, 6, `expected 6 AI calls, got ${ctx.mockAi.log.length}`);

  // Per-chunk cache populated (3 entries, eine pro Kapitel).
  const cacheRows = ctx.dbSchema.db.prepare(
    `SELECT chapter_id FROM chapter_extract_cache WHERE book_id = ? AND user_email = ?`
  ).all(BOOK_ID, 'tester@test.dev');
  assert.equal(cacheRows.length, 3, 'expected 3 chapter_extract_cache rows');
});

test('Komplettanalyse Delta-Cache: Touch einer Seite → nur dieser Chunk re-extrahiert', async () => {
  const BOOK_ID = 61;
  seedMultiChapterBook(BOOK_ID, 3);

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('orte') && e.schemaKeys.includes('assignments'),
    ({ prompt }) => {
      const m = prompt.match(/Kapitel \d+/);
      return extraktionResponseFor(m ? m[0] : 'Kapitel');
    },
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('figuren'),
    { figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', beschreibung: '', sozialschicht: 'mitte', praesenz: 'zentral', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [], eigenschaften: [], schluesselzitate: [] }] },
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('orte'),
    { orte: [{ id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: '', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren: ['fig_anna'] }] },
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    kontinuitaetResponse(),
  );

  // Run 1: full pipeline.
  const jobId1 = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId1, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  await waitForJob(ctx.shared, jobId1, { timeoutMs: 10000 });
  const run1Calls = ctx.mockAi.log.length;
  assert.equal(run1Calls, 6, `run 1: expected 6 AI calls, got ${run1Calls}`);

  // Touch one page: change updated_at on page 3001 (chapter 2).
  const cur = ctx.mockBs;
  const seeded = { ...cur };
  // setBook again with one page mutated.
  const chapters = [
    { id: 2000, book_id: BOOK_ID, name: 'Kapitel 1' },
    { id: 2001, book_id: BOOK_ID, name: 'Kapitel 2' },
    { id: 2002, book_id: BOOK_ID, name: 'Kapitel 3' },
  ];
  const pages = [
    { id: 3000, book_id: BOOK_ID, chapter_id: 2000, name: 'Seite 1', updated_at: '2026-01-01' },
    { id: 3001, book_id: BOOK_ID, chapter_id: 2001, name: 'Seite 2', updated_at: '2026-02-15' }, // touched
    { id: 3002, book_id: BOOK_ID, chapter_id: 2002, name: 'Seite 3', updated_at: '2026-01-01' },
  ];
  const bodies = {
    3000: '<p>' + 'Anna ging weiter durch das Land. '.repeat(280) + '</p>',
    3001: '<p>' + 'Anna ging weiter durch das Land. '.repeat(280) + '</p>',
    3002: '<p>' + 'Anna ging weiter durch das Land. '.repeat(280) + '</p>',
  };
  ctx.mockBs.setBook({ chapters, pages, pageBodies: bodies });

  // Run 2: only chunk for page 3001 should re-extract.
  const jobId2 = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId2, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  await waitForJob(ctx.shared, jobId2, { timeoutMs: 10000 });
  const run2Calls = ctx.mockAi.log.length - run1Calls;
  // Expected: 1 P1 chunk re-extract + 1 P2 + 1 P3 + 1 P8 = 4 calls.
  // (Other 2 chunks served from cache.)
  assert.equal(run2Calls, 4, `delta-cache run: expected 4 AI calls, got ${run2Calls}`);
});

test('Komplettanalyse Checkpoint-Recovery: p1_full_done → überspringt Phase 1', async () => {
  const BOOK_ID = 62;
  seedMultiChapterBook(BOOK_ID, 3);

  // Pre-seed checkpoint as if Phase 1 ran successfully but job died before P2.
  ctx.dbSchema.saveCheckpoint('komplett-analyse', BOOK_ID, 'tester@test.dev', {
    phase: 'p1_full_done',
    chapterFiguren: [
      { kapitel: 'Kapitel 1', figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] }] },
      { kapitel: 'Kapitel 2', figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', kapitel: [{ name: 'Kapitel 2', haeufigkeit: 1 }], beziehungen: [] }] },
      { kapitel: 'Kapitel 3', figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', kapitel: [{ name: 'Kapitel 3', haeufigkeit: 1 }], beziehungen: [] }] },
    ],
    chapterOrte: [
      { kapitel: 'Kapitel 1', orte: [{ id: 'ort_land', name: 'Land', typ: 'natur', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren: ['fig_anna'] }] },
      { kapitel: 'Kapitel 2', orte: [] },
      { kapitel: 'Kapitel 3', orte: [] },
    ],
    chapterFakten: [{ kapitel: 'Kapitel 1', fakten: [] }, { kapitel: 'Kapitel 2', fakten: [] }, { kapitel: 'Kapitel 3', fakten: [] }],
    chapterSzenen: [
      { kapitel: 'Kapitel 1', szenen: [{ seite: 'Seite 1', kapitel: 'Kapitel 1', titel: 'Anna 1', wertung: 'mittel', figuren_namen: ['Anna'], orte_namen: ['Land'] }] },
      { kapitel: 'Kapitel 2', szenen: [] },
      { kapitel: 'Kapitel 3', szenen: [] },
    ],
    chapterAssignments: [
      { kapitel: 'Kapitel 1', assignments: [{ figur_name: 'Anna', lebensereignisse: [] }] },
      { kapitel: 'Kapitel 2', assignments: [] },
      { kapitel: 'Kapitel 3', assignments: [] },
    ],
    tokIn: 5000, tokOut: 1000, tokMs: 0,
  });

  // Phase 1 must NOT be called. Register handler that throws if hit.
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('orte') && e.schemaKeys.includes('assignments'),
    () => { throw new Error('Phase 1 should NOT run after checkpoint recovery'); },
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('figuren'),
    { figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] }] },
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('orte'),
    { orte: [{ id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: '', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren: ['fig_anna'] }] },
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    kontinuitaetResponse(),
  );

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  // Resume path: P2 + P3 + P8 = 3 calls. No P1.
  assert.equal(ctx.mockAi.log.length, 3, `resume: expected 3 AI calls (no P1), got ${ctx.mockAi.log.length}`);

  // Checkpoint deleted after success.
  const cp = ctx.dbSchema.loadCheckpoint('komplett-analyse', BOOK_ID, 'tester@test.dev');
  assert.equal(cp, null, 'checkpoint should be deleted after successful run');
});

test('Komplettanalyse Checkpoint-Invalid: altes Format → ignoriert, voller Lauf', async () => {
  const BOOK_ID = 63;
  seedMultiChapterBook(BOOK_ID, 3);

  // Pre-seed checkpoint with stale phase ('p1_done' instead of 'p1_full_done').
  ctx.dbSchema.saveCheckpoint('komplett-analyse', BOOK_ID, 'tester@test.dev', {
    phase: 'p1_done',
    chapterFiguren: [{ kapitel: 'X', figuren: [{ id: 'old', name: 'Old' }] }],
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('orte') && e.schemaKeys.includes('assignments'),
    ({ prompt }) => {
      const m = prompt.match(/Kapitel \d+/);
      return extraktionResponseFor(m ? m[0] : 'Kapitel');
    },
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('figuren'),
    { figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] }] },
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('orte'),
    { orte: [{ id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: '', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren: ['fig_anna'] }] },
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    kontinuitaetResponse(),
  );

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done');
  // Full run: 3 P1 + P2 + P3 + P8 = 6 calls.
  assert.equal(ctx.mockAi.log.length, 6, `full re-run after invalid checkpoint: expected 6, got ${ctx.mockAi.log.length}`);
});

test('Komplettanalyse: Cache-Hit Phase 1 → nur P8 ruft AI', async () => {
  const BOOK_ID = 52;
  seedTinyBook(BOOK_ID);

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('orte') && e.schemaKeys.includes('assignments'),
    extraktionResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    kontinuitaetResponse(),
  );

  // Run 1: populates cache.
  const jobId1 = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId1, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  await waitForJob(ctx.shared, jobId1, { timeoutMs: 8000 });
  assert.equal(ctx.mockAi.log.length, 2, 'run 1: 2 AI calls');

  // Run 2: same book, cache should hit Phase 1 → only P8 calls AI.
  const callsBeforeRun2 = ctx.mockAi.log.length;
  const jobId2 = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId2, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job2 = await waitForJob(ctx.shared, jobId2, { timeoutMs: 8000 });
  assert.equal(job2.status, 'done');
  const run2Calls = ctx.mockAi.log.length - callsBeforeRun2;
  assert.equal(run2Calls, 1, `cache-hit run: expected 1 AI call (P8 only), got ${run2Calls}`);
});
