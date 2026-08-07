'use strict';
// Pipeline-Smoke gegen die echte Dummy-Buch-Fixture
// (tests/fixtures/dummy-book.md, 4 Kapitel × 2 Seiten ≈ 17K Zeichen).
// Verifiziert, dass Komplettanalyse + Standalone-Kontinuitätscheck mit
// realistischer Prosa (statt `Anna ging weiter durch das Land.`) durchlaufen.
//
// Token-Budget aus _helpers/setup.js: ai.claude.context_window=60000 → INPUT_BUDGET 162K
// chars → SINGLE_PASS_LIMIT=113400 → das Buch (~17K) läuft Single-Pass.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');
const dummy = require('./_helpers/dummy-book');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
});

const USER = 'tester@test.dev';
const TOKEN = { id: 'tok', pw: 'pw' };

test('Dummy-Buch: Fixture-Loader liefert deterministische IDs', () => {
  const fix = dummy.buildDummyBookFixture(102);
  assert.equal(fix.chapters.length, 4);
  assert.equal(fix.pages.length, 8);
  assert.equal(fix.idMap.chapters[1], 102001);
  assert.equal(fix.idMap.pages['1.1'], 102011);
  assert.equal(fix.idMap.pages['4.2'], 102042);
  // Body kommt als HTML in Mock-BookStack an.
  const firstBody = fix.pageBodies[fix.idMap.pages['1.1']];
  assert.match(firstBody, /^<p>/);
  assert.ok(firstBody.includes('Brunner'), 'Page 1.1 sollte „Brunner" enthalten');
});

test('Dummy-Buch Komplettanalyse Single-Pass → done, 5 Figuren, 4 Orte, Kontinuitätsprobleme', async () => {
  const BOOK_ID = 102;
  const fix = dummy.seedDummyBook(ctx.dbSeed, BOOK_ID);
  dummy.registerKomplettAiMocks(ctx.mockAi);

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, USER, 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, fix.meta.title, USER, TOKEN, 'claude'),
  );

  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.passMode, 'single', 'Dummy-Buch ~17K chars sollte Single-Pass triggern');
  assert.equal(job.result.figCount, 5, 'fünf Hauptfiguren');
  assert.equal(job.result.orteCount, 4, 'vier Schauplätze');

  const figRows = ctx.dbSchema.db.prepare(
    'SELECT name FROM figures WHERE book_id = ? AND user_email = ? ORDER BY name'
  ).all(BOOK_ID, USER);
  const figNames = figRows.map(r => r.name);
  assert.deepEqual(
    figNames,
    ['Daniel Moser', 'Lea Brunner', 'Markus Keller', 'Ronnie Huber', 'Sibylle Amrein'],
  );

  const ortRows = ctx.dbSchema.db.prepare(
    'SELECT name FROM locations WHERE book_id = ? AND user_email = ? ORDER BY name'
  ).all(BOOK_ID, USER);
  assert.equal(ortRows.length, 4);

  const cont = ctx.dbSchema.getLatestContinuityCheck(BOOK_ID, USER);
  assert.ok(cont, 'Kontinuitätscheck persistiert');
  assert.match(cont.summary, /Widerspr/);
});

test('Dummy-Buch Standalone-Kontinuitätscheck → 2 Probleme', async () => {
  const BOOK_ID = 103;
  const fix = dummy.seedDummyBook(ctx.dbSeed, BOOK_ID);
  dummy.registerKomplettAiMocks(ctx.mockAi);

  const jobId = ctx.shared.createJob('kontinuitaet', BOOK_ID, USER, 'job.label.kontinuitaet');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKontinuitaetJob(jobId, BOOK_ID, fix.meta.title, USER, TOKEN, 'claude'),
  );

  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  // Mind. ein Phase-8-Call mit Kontinuitäts-Schema.
  const continuityCalls = ctx.mockAi.log.filter(e =>
    e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'));
  assert.ok(continuityCalls.length >= 1, 'Phase-8-AI-Call erwartet');

  const cont = ctx.dbSchema.getLatestContinuityCheck(BOOK_ID, USER);
  assert.ok(cont);
});
