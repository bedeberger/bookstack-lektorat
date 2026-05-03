'use strict';
// Integration test: Buch-Review (review.js) + Kapitel-Review (kapitel.js).

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

function reviewResponse(note = 4.2) {
  return {
    gesamtnote: note,
    gesamtnote_begruendung: 'solide',
    zusammenfassung: 'Buch über Anna.',
    struktur: 'klar',
    stil: 'flüssig',
    staerken: ['Atmosphäre'],
    schwaechen: ['Pacing'],
    empfehlungen: ['mehr Konflikt'],
    fazit: 'lesenswert',
  };
}

function chapterAnalysisResponse() {
  return {
    themen: 'Aufbruch',
    stil: 'erzählerisch',
    qualitaet: 'gut',
    staerken: ['Bilder'],
    schwaechen: ['kurz'],
  };
}

function chapterReviewResponse(note = 4.0) {
  return {
    gesamtnote: note,
    gesamtnote_begruendung: 'rund',
    zusammenfassung: 'Anna im Wald.',
    dramaturgie: 'klar',
    pacing: 'mittel',
    kohaerenz: 'hoch',
    perspektive: '3.Person',
    figuren: 'Anna zentral',
    staerken: ['Setting'],
    schwaechen: ['kurz'],
    empfehlungen: ['ausbauen'],
    fazit: 'gut',
  };
}

// ── Buch-Review ────────────────────────────────────────────────────────────────

test('Buch-Review Single-Pass: 1 Kapitel → 1 AI-Call, book_reviews-Zeile', async () => {
  const BOOK_ID = 80;
  ctx.mockBs.setBook({
    chapters: [{ id: 8100, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 8200, book_id: BOOK_ID, chapter_id: 8100, name: 'S 1', updated_at: '' }],
    pageBodies: { 8200: '<p>' + 'Anna ging weiter. '.repeat(60) + '</p>' },
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('gesamtnote') && e.schemaKeys.includes('struktur'),
    reviewResponse(4.5),
  );

  const jobId = ctx.shared.createJob('review', BOOK_ID, 'tester@test.dev', 'job.label.review');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.review.runReviewJob(jobId, BOOK_ID, 'Mein Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.review.gesamtnote, 4.5);
  assert.equal(ctx.mockAi.log.length, 1);

  const row = ctx.dbSchema.db.prepare(
    'SELECT review_json FROM book_reviews WHERE book_id = ? AND user_email = ?'
  ).get(BOOK_ID, 'tester@test.dev');
  assert.ok(row, 'book_reviews row missing');
  const stored = JSON.parse(row.review_json);
  assert.equal(stored.gesamtnote, 4.5);
});

test('Buch-Review Multi-Pass: 3 Kapitel → 3 Analysen + 1 Final = 4 Calls', async () => {
  const BOOK_ID = 81;
  // 3 chapters × ~9000 chars = 27K → multi-pass (SINGLE_PASS_LIMIT = 20K via setup).
  const chapters = [], pages = [], bodies = {};
  for (let i = 0; i < 3; i++) {
    chapters.push({ id: 8300 + i, book_id: BOOK_ID, name: `Kap ${i + 1}` });
    pages.push({ id: 8400 + i, book_id: BOOK_ID, chapter_id: 8300 + i, name: `S ${i + 1}`, updated_at: '' });
    bodies[8400 + i] = '<p>' + 'Anna ging weiter durch das Land. '.repeat(280) + '</p>';
  }
  ctx.mockBs.setBook({ chapters, pages, pageBodies: bodies });

  // Chapter analysis schema (no gesamtnote).
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('themen') && e.schemaKeys.includes('qualitaet'),
    chapterAnalysisResponse(),
  );
  // Final review schema (with gesamtnote + struktur).
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('gesamtnote') && e.schemaKeys.includes('struktur'),
    reviewResponse(3.8),
  );

  const jobId = ctx.shared.createJob('review', BOOK_ID, 'tester@test.dev', 'job.label.review');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.review.runReviewJob(jobId, BOOK_ID, 'Multi', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.review.gesamtnote, 3.8);
  assert.equal(ctx.mockAi.log.length, 4, 'expected 3 analyses + 1 final');

  // Last call should be the final review (struktur in schema).
  const lastCall = ctx.mockAi.log[ctx.mockAi.log.length - 1];
  assert.ok(lastCall.schemaKeys.includes('struktur'));
});

test('Buch-Review: fehlt gesamtnote → failJob', async () => {
  const BOOK_ID = 82;
  ctx.mockBs.setBook({
    chapters: [{ id: 8500, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 8600, book_id: BOOK_ID, chapter_id: 8500, name: 'S', updated_at: '' }],
    pageBodies: { 8600: '<p>' + 'x '.repeat(150) + '</p>' },
  });

  ctx.mockAi.on(
    () => true,
    { fazit: 'kein gesamtnote' }, // missing required field
  );

  const jobId = ctx.shared.createJob('review', BOOK_ID, 'tester@test.dev', 'job.label.review');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.review.runReviewJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.gesamtnoteMissing');
});

test('Buch-Review: leeres Buch → result.empty', async () => {
  const BOOK_ID = 83;
  ctx.mockBs.setBook({ chapters: [], pages: [], pageBodies: {} });

  const jobId = ctx.shared.createJob('review', BOOK_ID, 'tester@test.dev', 'job.label.review');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.review.runReviewJob(jobId, BOOK_ID, 'Leer', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.empty, true);
  assert.equal(ctx.mockAi.log.length, 0);
});

// ── Kapitel-Review ────────────────────────────────────────────────────────────

test('Kapitel-Review: 1 Kapitel → 1 AI-Call, chapter_reviews-Zeile', async () => {
  const BOOK_ID = 90;
  const CHAPTER_ID = 9100;
  ctx.mockBs.setBook({
    chapters: [{ id: CHAPTER_ID, book_id: BOOK_ID, name: 'Kap A' }],
    pages: [
      { id: 9200, book_id: BOOK_ID, chapter_id: CHAPTER_ID, name: 'S 1', priority: 0 },
      { id: 9201, book_id: BOOK_ID, chapter_id: CHAPTER_ID, name: 'S 2', priority: 1 },
      // Page in different chapter — should be filtered out.
      { id: 9300, book_id: BOOK_ID, chapter_id: 9999, name: 'Andere', priority: 0 },
    ],
    pageBodies: {
      9200: '<p>Anna ging in den Wald.</p>',
      9201: '<p>Es war kalt.</p>',
      9300: '<p>nicht relevant</p>',
    },
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('gesamtnote') && e.schemaKeys.includes('dramaturgie'),
    chapterReviewResponse(4.1),
  );

  const jobId = ctx.shared.createJob('chapter-review', BOOK_ID, 'tester@test.dev', 'job.label.chapterReview', null, CHAPTER_ID);
  ctx.shared.enqueueJob(jobId, () =>
    ctx.kapitel.runChapterReviewJob(jobId, BOOK_ID, CHAPTER_ID, 'Kap A', 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.review.gesamtnote, 4.1);
  assert.equal(job.result.pageCount, 2, 'only chapter pages used');
  assert.equal(ctx.mockAi.log.length, 1);

  const row = ctx.dbSchema.db.prepare(
    'SELECT chapter_id, review_json FROM chapter_reviews WHERE book_id = ? AND chapter_id = ? AND user_email = ?'
  ).get(BOOK_ID, CHAPTER_ID, 'tester@test.dev');
  assert.ok(row);
  const stored = JSON.parse(row.review_json);
  assert.equal(stored.gesamtnote, 4.1);
});

test('Kapitel-Review: leeres Kapitel → result.empty, kein AI-Call', async () => {
  const BOOK_ID = 91;
  const CHAPTER_ID = 9400;
  ctx.mockBs.setBook({
    chapters: [{ id: CHAPTER_ID, book_id: BOOK_ID, name: 'Kap leer' }],
    pages: [{ id: 9500, book_id: BOOK_ID, chapter_id: 9999, name: 'fremd', priority: 0 }],
    pageBodies: { 9500: '<p>fremd</p>' },
  });

  const jobId = ctx.shared.createJob('chapter-review', BOOK_ID, 'tester@test.dev', 'job.label.chapterReview', null, CHAPTER_ID);
  ctx.shared.enqueueJob(jobId, () =>
    ctx.kapitel.runChapterReviewJob(jobId, BOOK_ID, CHAPTER_ID, 'Kap leer', 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.empty, true);
  assert.equal(ctx.mockAi.log.length, 0);
});

test('Kapitel-Review: AI ohne gesamtnote → failJob', async () => {
  const BOOK_ID = 92;
  const CHAPTER_ID = 9600;
  ctx.mockBs.setBook({
    chapters: [{ id: CHAPTER_ID, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 9700, book_id: BOOK_ID, chapter_id: CHAPTER_ID, name: 'S', priority: 0 }],
    pageBodies: { 9700: '<p>Anna ging in den Wald.</p>' },
  });

  ctx.mockAi.on(() => true, { fazit: 'unvollständig' });

  const jobId = ctx.shared.createJob('chapter-review', BOOK_ID, 'tester@test.dev', 'job.label.chapterReview', null, CHAPTER_ID);
  ctx.shared.enqueueJob(jobId, () =>
    ctx.kapitel.runChapterReviewJob(jobId, BOOK_ID, CHAPTER_ID, 'K', 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.gesamtnoteMissing');
});
