'use strict';
// Regression-Guards: kritische Invarianten, die bei refactor leicht brechen.

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

test('truncated: callAI gibt truncated=true → Job → error (kein partial in DB)', async () => {
  const BOOK_ID = 70;
  ctx.mockBs.setBook({
    chapters: [{ id: 9100, book_id: BOOK_ID, name: 'K1' }],
    pages: [{ id: 9200, book_id: BOOK_ID, chapter_id: 9100, name: 'S1', updated_at: '' }],
    pageBodies: { 9200: '<p>' + 'x '.repeat(150) + '</p>' },
  });

  // Truncated response — would parse to empty object (jsonrepair would tolerate),
  // but shared.aiCall MUST throw before parseJSON because truncated=true.
  ctx.mockAi.on(
    () => true,
    { __raw: { text: '{"zusammenfassung": "abge', truncated: true, tokensIn: 100, tokensOut: 5 } },
  );

  const jobId = ctx.shared.createJob('kontinuitaet', BOOK_ID, 'tester@test.dev', 'job.label.kontinuitaet');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKontinuitaetJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error', `expected error, got ${job.status}`);
  assert.equal(job.error, 'job.error.aiTruncated');

  // No continuity_check row.
  const cont = ctx.dbSchema.getLatestContinuityCheck(BOOK_ID, 'tester@test.dev');
  assert.equal(cont, null, 'expected NO continuity row when AI truncated');
});

test('AbortError: cancel während Job-Lauf → status cancelled', async () => {
  const BOOK_ID = 71;
  ctx.mockBs.setBook({
    chapters: [{ id: 9300, book_id: BOOK_ID, name: 'K1' }],
    pages: [{ id: 9400, book_id: BOOK_ID, chapter_id: 9300, name: 'S1', updated_at: '' }],
    pageBodies: { 9400: '<p>' + 'x '.repeat(150) + '</p>' },
  });

  let aiCalled = false;
  ctx.mockAi.on(
    () => true,
    () => {
      aiCalled = true;
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    },
  );

  const jobId = ctx.shared.createJob('kontinuitaet', BOOK_ID, 'tester@test.dev', 'job.label.kontinuitaet');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKontinuitaetJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );

  // Mark as cancelled before AI returns.
  const job0 = ctx.shared.jobs.get(jobId);
  job0.cancelled = true;

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'cancelled');
  assert.ok(aiCalled, 'AI should have been called before cancellation took effect');
});
