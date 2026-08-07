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
  ctx.dbSeed.reset();
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
  ctx.dbSeed.setBook({
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
  // 3 Kapitel × ~40K Zeichen = 120K → Multi-Pass (SINGLE_PASS_LIMIT = 113400 aus
  // dem Test-Token-Budget in _helpers/setup.js — beide Seiten zusammen ändern).
  const chapters = [], pages = [], bodies = {};
  for (let i = 0; i < 3; i++) {
    chapters.push({ id: 8300 + i, book_id: BOOK_ID, name: `Kap ${i + 1}` });
    pages.push({ id: 8400 + i, book_id: BOOK_ID, chapter_id: 8300 + i, name: `S ${i + 1}`, updated_at: '' });
    bodies[8400 + i] = '<p>' + 'Anna ging weiter durch das Land. '.repeat(1215) + '</p>';
  }
  ctx.dbSeed.setBook({ chapters, pages, pageBodies: bodies });

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
  ctx.dbSeed.setBook({
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

test('Buch-Review Cache: Single-Pass-Rerun trifft book_review_cache → 0 AI-Calls', async () => {
  const BOOK_ID = 88;
  ctx.dbSeed.setBook({
    chapters: [{ id: 8800, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 8801, book_id: BOOK_ID, chapter_id: 8800, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' }],
    pageBodies: { 8801: '<p>' + 'Anna ging weiter. '.repeat(60) + '</p>' },
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('gesamtnote') && e.schemaKeys.includes('struktur'),
    reviewResponse(4.5),
  );

  // Erster Run → schreibt Cache.
  const jobId1 = ctx.shared.createJob('review', BOOK_ID, 'tester@test.dev', 'job.label.review');
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.review.runReviewJob(jobId1, BOOK_ID, 'Mein Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job1 = await waitForJob(ctx.shared, jobId1);
  assert.equal(job1.status, 'done');
  assert.equal(ctx.mockAi.log.length, 1, '1. Run = 1 Call');

  const cacheRow = ctx.dbSchema.db.prepare(
    'SELECT pages_sig FROM book_review_cache WHERE book_id = ? AND user_email = ?'
  ).get(BOOK_ID, 'tester@test.dev');
  assert.ok(cacheRow, 'book_review_cache fehlt nach 1. Run');

  // Zweiter Run identische Inputs → Cache-HIT.
  const jobId2 = ctx.shared.createJob('review', BOOK_ID, 'tester@test.dev', 'job.label.review');
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.review.runReviewJob(jobId2, BOOK_ID, 'Mein Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job2 = await waitForJob(ctx.shared, jobId2);
  assert.equal(job2.status, 'done');
  assert.equal(job2.result.review.gesamtnote, 4.5);
  assert.equal(ctx.mockAi.log.length, 1, '2. Run = Cache-HIT, kein neuer AI-Call');
});

test('Buch-Review Cache: Multi-Pass — geänderte Seite invalidiert nur 1 Kapitel', async () => {
  const BOOK_ID = 89;
  const chapters = [], pages = [], bodies = {};
  for (let i = 0; i < 3; i++) {
    chapters.push({ id: 8900 + i, book_id: BOOK_ID, name: `Kap ${i + 1}` });
    pages.push({ id: 8910 + i, book_id: BOOK_ID, chapter_id: 8900 + i, name: `S ${i + 1}`, updated_at: '2026-05-01T10:00:00Z' });
    bodies[8910 + i] = '<p>' + 'Anna ging weiter durch das Land. '.repeat(1215) + '</p>';
  }
  ctx.dbSeed.setBook({ chapters, pages, pageBodies: bodies });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('themen') && e.schemaKeys.includes('qualitaet'),
    chapterAnalysisResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('gesamtnote') && e.schemaKeys.includes('struktur'),
    reviewResponse(3.8),
  );

  // 1. Run → 3 Analysen + 1 Final.
  const jobId1 = ctx.shared.createJob('review', BOOK_ID, 'tester@test.dev', 'job.label.review');
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.review.runReviewJob(jobId1, BOOK_ID, 'Multi', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job1 = await waitForJob(ctx.shared, jobId1, { timeoutMs: 8000 });
  assert.equal(job1.status, 'done');
  assert.equal(ctx.mockAi.log.length, 4, '1. Run = 3 Analysen + 1 Final');

  const cachedCount = ctx.dbSchema.db.prepare(
    'SELECT COUNT(*) AS n FROM chapter_review_cache WHERE book_id = ? AND user_email = ?'
  ).get(BOOK_ID, 'tester@test.dev').n;
  assert.equal(cachedCount, 3, '3 Kapitelanalysen gecacht');

  // Seite in Kapitel 2 ändert sich → updated_at neu.
  pages[1].updated_at = '2026-05-02T11:00:00Z';
  ctx.dbSeed.setBook({ chapters, pages, pageBodies: bodies });

  ctx.mockAi.reset();
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('themen') && e.schemaKeys.includes('qualitaet'),
    chapterAnalysisResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('gesamtnote') && e.schemaKeys.includes('struktur'),
    reviewResponse(3.8),
  );

  const jobId2 = ctx.shared.createJob('review', BOOK_ID, 'tester@test.dev', 'job.label.review');
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.review.runReviewJob(jobId2, BOOK_ID, 'Multi', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job2 = await waitForJob(ctx.shared, jobId2, { timeoutMs: 8000 });
  assert.equal(job2.status, 'done');
  // 2 Kapitel cached + 1 neu analysiert + 1 Final = 2 Calls.
  assert.equal(ctx.mockAi.log.length, 2, '2. Run: 1 Kapitelanalyse + 1 Final (2 aus Cache)');
});

test('Buch-Review: leeres Buch → result.empty', async () => {
  const BOOK_ID = 83;
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {}, books: [{ id: BOOK_ID, name: 'Leer' }] });

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
  ctx.dbSeed.setBook({
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

test('Kapitel-Review: ausgeschlossenes Kapitel bleibt direkt bewertbar', async () => {
  const BOOK_ID = 94;
  const CHAPTER_ID = 9050;
  ctx.dbSeed.setBook({
    chapters: [{ id: CHAPTER_ID, book_id: BOOK_ID, name: 'Kap Excl' }],
    pages: [
      { id: 9060, book_id: BOOK_ID, chapter_id: CHAPTER_ID, name: 'S 1', priority: 0 },
      { id: 9061, book_id: BOOK_ID, chapter_id: CHAPTER_ID, name: 'S 2', priority: 1 },
    ],
    pageBodies: {
      9060: '<p>Anna ging in den Wald.</p>',
      9061: '<p>Es war kalt.</p>',
    },
  });
  // Kapitel ausschliessen — Buch-/Komplettanalyse wuerden es ueberspringen,
  // die direkte Kapitelbewertung muss es trotzdem laden koennen.
  ctx.dbSchema.db.prepare('UPDATE chapters SET excluded = 1 WHERE chapter_id = ?').run(CHAPTER_ID);

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('gesamtnote') && e.schemaKeys.includes('dramaturgie'),
    chapterReviewResponse(3.7),
  );

  const jobId = ctx.shared.createJob('chapter-review', BOOK_ID, 'tester@test.dev', 'job.label.chapterReview', null, CHAPTER_ID);
  ctx.shared.enqueueJob(jobId, () =>
    ctx.kapitel.runChapterReviewJob(jobId, BOOK_ID, CHAPTER_ID, 'Kap Excl', 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.notEqual(job.result.empty, true, 'ausgeschlossenes Kapitel darf nicht als leer durchfallen');
  assert.equal(job.result.review.gesamtnote, 3.7);
  assert.equal(job.result.pageCount, 2, 'beide Seiten des ausgeschlossenen Kapitels bewertet');
  assert.equal(ctx.mockAi.log.length, 1);
});

test('Kapitel-Review Cache: Rerun trifft chapter_macro_review_cache → 0 AI-Calls', async () => {
  const BOOK_ID = 93;
  const CHAPTER_ID = 9800;
  ctx.dbSeed.setBook({
    chapters: [{ id: CHAPTER_ID, book_id: BOOK_ID, name: 'Kap A' }],
    pages: [
      { id: 9810, book_id: BOOK_ID, chapter_id: CHAPTER_ID, name: 'S 1', priority: 0, updated_at: '2026-05-01T10:00:00Z' },
      { id: 9811, book_id: BOOK_ID, chapter_id: CHAPTER_ID, name: 'S 2', priority: 1, updated_at: '2026-05-01T10:00:00Z' },
    ],
    pageBodies: {
      9810: '<p>Anna ging in den Wald.</p>',
      9811: '<p>Es war kalt.</p>',
    },
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('gesamtnote') && e.schemaKeys.includes('dramaturgie'),
    chapterReviewResponse(4.1),
  );

  // Erster Run → schreibt Cache.
  const jobId1 = ctx.shared.createJob('chapter-review', BOOK_ID, 'tester@test.dev', 'job.label.chapterReview', null, CHAPTER_ID);
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.kapitel.runChapterReviewJob(jobId1, BOOK_ID, CHAPTER_ID, 'Kap A', 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job1 = await waitForJob(ctx.shared, jobId1);
  assert.equal(job1.status, 'done');
  assert.equal(ctx.mockAi.log.length, 1, '1. Run = 1 Call');

  const cacheRow = ctx.dbSchema.db.prepare(
    'SELECT pages_sig FROM chapter_macro_review_cache WHERE book_id = ? AND chapter_id = ? AND user_email = ?'
  ).get(BOOK_ID, CHAPTER_ID, 'tester@test.dev');
  assert.ok(cacheRow, 'chapter_macro_review_cache fehlt nach 1. Run');

  // Zweiter Run → Cache-HIT.
  const jobId2 = ctx.shared.createJob('chapter-review', BOOK_ID, 'tester@test.dev', 'job.label.chapterReview', null, CHAPTER_ID);
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.kapitel.runChapterReviewJob(jobId2, BOOK_ID, CHAPTER_ID, 'Kap A', 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job2 = await waitForJob(ctx.shared, jobId2);
  assert.equal(job2.status, 'done');
  assert.equal(job2.result.review.gesamtnote, 4.1);
  assert.equal(job2.result.cached, true);
  assert.equal(ctx.mockAi.log.length, 1, '2. Run = Cache-HIT');

  // chapter_reviews-Zeile wird trotz HIT geschrieben (History-Eintrag).
  const reviewRows = ctx.dbSchema.db.prepare(
    'SELECT COUNT(*) AS n FROM chapter_reviews WHERE book_id = ? AND chapter_id = ? AND user_email = ?'
  ).get(BOOK_ID, CHAPTER_ID, 'tester@test.dev').n;
  assert.equal(reviewRows, 2, 'beide Runs in chapter_reviews persistiert');
});

test('Kapitel-Review: leeres Kapitel → result.empty, kein AI-Call', async () => {
  const BOOK_ID = 91;
  const CHAPTER_ID = 9400;
  ctx.dbSeed.setBook({
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
  ctx.dbSeed.setBook({
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
