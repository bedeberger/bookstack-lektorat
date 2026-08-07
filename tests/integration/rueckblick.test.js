'use strict';
// Integration test: Tagebuch-Rückblick (rueckblick.js) — Single-Pass, Map-Reduce
// über Monate, Cache-HIT, Leerzustand, kein content-store-Write.

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

function rueckblickResponse(summary = 'Ein ruhiger Monat.') {
  return {
    themen: [{ label: 'Arbeit', haeufigkeit: 2, belege: ['2024-03-04'] }],
    personen: [{ name: 'Anna', haeufigkeit: 3 }],
    orte: [{ name: 'Zürich', haeufigkeit: 1 }],
    bemerkenswerteTage: [{ datum: '2024-03-15', begruendung: 'großer Tag' }],
    zusammenfassung: summary,
  };
}

// Diary-Seiten: page_name = 'YYYY-MM-DD'. Ein Kapitel pro Jahr genügt.
function seedDiary(bookId, dates, { charsPerEntry = 60 } = {}) {
  const chapters = [{ id: bookId * 10, book_id: bookId, name: '2024' }];
  const pages = [];
  const pageBodies = {};
  dates.forEach((d, i) => {
    const pid = bookId * 100 + i;
    pages.push({ id: pid, book_id: bookId, chapter_id: bookId * 10, name: d, updated_at: '2024-12-31T10:00:00Z' });
    pageBodies[pid] = '<p>' + `Heute war ein Tag. `.repeat(charsPerEntry) + '</p>';
  });
  ctx.dbSeed.setBook({ chapters, pages, pageBodies });
}

test('Single-Pass: ein Monat → 1 AI-Call, Ergebnis + Cache-Zeile', async () => {
  const BOOK_ID = 700;
  seedDiary(BOOK_ID, ['2024-03-04', '2024-03-15', '2024-03-22']);

  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('themen'),
    rueckblickResponse());

  const jobId = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024-03' }, `${BOOK_ID}:2024-03`);
  ctx.shared.enqueueJob(jobId, () =>
    ctx.rueckblick.runRueckblickJob(jobId, BOOK_ID, 'tester@test.dev', null, '2024-03'));
  const job = await waitForJob(ctx.shared, jobId);

  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.rueckblick.zusammenfassung, 'Ein ruhiger Monat.');
  assert.equal(job.result.entryCount, 3);
  assert.equal(ctx.mockAi.log.length, 1);

  const cacheRow = ctx.dbSchema.db.prepare(
    'SELECT pages_sig FROM tagebuch_rueckblick_cache WHERE book_id = ? AND user_email = ? AND zeitraum = ?'
  ).get(BOOK_ID, 'tester@test.dev', '2024-03');
  assert.ok(cacheRow, 'Cache-Zeile fehlt nach 1. Run');

  // History-Zeile geschrieben (dauerhaft, re-öffenbar).
  const histRows = ctx.dbSchema.db.prepare(
    'SELECT zeitraum, result_json FROM tagebuch_rueckblicke WHERE book_id = ? AND user_email = ?'
  ).all(BOOK_ID, 'tester@test.dev');
  assert.equal(histRows.length, 1, 'eine History-Zeile nach 1. Run');
  assert.equal(histRows[0].zeitraum, '2024-03');
  assert.equal(JSON.parse(histRows[0].result_json).zusammenfassung, 'Ein ruhiger Monat.');
});

test('History: identischer Re-Run (Cache-HIT) dedupliziert, neues Ergebnis schreibt Zeile', async () => {
  const BOOK_ID = 707;
  const histCount = () => ctx.dbSchema.db.prepare(
    'SELECT COUNT(*) AS n FROM tagebuch_rueckblicke WHERE book_id = ? AND user_email = ?'
  ).get(BOOK_ID, 'tester@test.dev').n;

  seedDiary(BOOK_ID, ['2024-09-01', '2024-09-08']);
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung'), rueckblickResponse());

  for (let i = 0; i < 2; i++) {
    const jobId = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024-09' }, `${BOOK_ID}:2024-09_${i}`);
    ctx.shared.enqueueJob(jobId, () =>
      ctx.rueckblick.runRueckblickJob(jobId, BOOK_ID, 'tester@test.dev', null, '2024-09'));
    const job = await waitForJob(ctx.shared, jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.result.fromCache, i === 1, `Lauf ${i}: fromCache=${i === 1}`);
  }
  // Cache-HIT im 2. Lauf → nur 1 AI-Call; identisches result_json → keine Duplikat-Zeile.
  assert.equal(ctx.mockAi.log.length, 1, 'Cache-HIT: kein 2. AI-Call');
  assert.equal(histCount(), 1, 'identischer Re-Run dedupliziert → eine History-Zeile');

  // Inhaltlich neuer Lauf (neuer Eintrag bricht den Cache, neue Zusammenfassung)
  // → zweite History-Zeile.
  ctx.mockAi.reset();
  seedDiary(BOOK_ID, ['2024-09-01', '2024-09-08', '2024-09-20']);
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung'), rueckblickResponse('Ein bewegter Monat.'));
  const jobId3 = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024-09' }, `${BOOK_ID}:2024-09_c`);
  ctx.shared.enqueueJob(jobId3, () =>
    ctx.rueckblick.runRueckblickJob(jobId3, BOOK_ID, 'tester@test.dev', null, '2024-09'));
  const job3 = await waitForJob(ctx.shared, jobId3);
  assert.equal(job3.status, 'done');
  assert.equal(job3.result.fromCache, false, 'neuer Eintrag → Cache-MISS');
  assert.equal(histCount(), 2, 'neues Ergebnis → zweite History-Zeile');
});

test('Zeitraum-Filter: nur Einträge des gewählten Monats', async () => {
  const BOOK_ID = 701;
  seedDiary(BOOK_ID, ['2024-03-04', '2024-03-15', '2024-04-02', '2023-12-31']);

  let seenEntryCount = null;
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung'), (entry) => {
    // Prompt enthält die Einträge — zähle die Datums-Header des Monats März.
    seenEntryCount = (entry.prompt.match(/### 2024-03-/g) || []).length;
    return rueckblickResponse();
  });

  const jobId = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024-03' }, `${BOOK_ID}:2024-03`);
  ctx.shared.enqueueJob(jobId, () =>
    ctx.rueckblick.runRueckblickJob(jobId, BOOK_ID, 'tester@test.dev', null, '2024-03'));
  const job = await waitForJob(ctx.shared, jobId);

  assert.equal(job.status, 'done');
  assert.equal(job.result.entryCount, 2, 'nur die zwei März-Einträge');
  assert.equal(seenEntryCount, 2);
});

test('Map-Reduce: Jahr über mehrere große Monate → Monats-Calls + Reduce', async () => {
  const BOOK_ID = 702;
  // 3 Monate × große Einträge → totalChars (~120K) überschreitet SINGLE_PASS_LIMIT
  // (113400 aus dem Test-Token-Budget in _helpers/setup.js).
  seedDiary(BOOK_ID, ['2024-01-10', '2024-02-10', '2024-03-10'], { charsPerEntry: 2110 });

  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung'), rueckblickResponse('Jahr.'));

  const jobId = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024' }, `${BOOK_ID}:2024`);
  ctx.shared.enqueueJob(jobId, () =>
    ctx.rueckblick.runRueckblickJob(jobId, BOOK_ID, 'tester@test.dev', null, '2024'));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });

  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(ctx.mockAi.log.length, 4, '3 Monats-Analysen + 1 Reduce');
  assert.equal(job.result.rueckblick.zusammenfassung, 'Jahr.');
});

test('Map-Reduce: ein einzelner überlanger Monat wird größenbasiert gechunkt', async () => {
  const BOOK_ID = 708;
  // Alle Einträge im selben Monat (byMonth.size == 1), Summe > SINGLE_PASS_LIMIT →
  // kein Monats-Split möglich, also Größen-Chunking statt eines übergroßen Single-Pass.
  seedDiary(BOOK_ID, ['2024-03-01', '2024-03-08', '2024-03-15', '2024-03-22'], { charsPerEntry: 2110 });

  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung'), rueckblickResponse('März.'));

  const jobId = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024-03' }, `${BOOK_ID}:2024-03`);
  ctx.shared.enqueueJob(jobId, () =>
    ctx.rueckblick.runRueckblickJob(jobId, BOOK_ID, 'tester@test.dev', null, '2024-03'));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });

  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.entryCount, 4);
  // Mehr als ein Call beweist: kein Single-Pass, obwohl nur ein Monat vorliegt.
  assert.ok(ctx.mockAi.log.length > 1, `erwartet Map-Reduce (>1 Call), war ${ctx.mockAi.log.length}`);
  assert.equal(job.result.rueckblick.zusammenfassung, 'März.');
});

test('entry_count: Snapshot beim Insert, Touch nach reinem Lösch-Vorgang', async () => {
  const BOOK_ID = 709;
  const latest = () => ctx.dbSchema.db.prepare(
    `SELECT entry_count FROM tagebuch_rueckblicke WHERE book_id = ? AND user_email = ?
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(BOOK_ID, 'tester@test.dev');
  const histCount = () => ctx.dbSchema.db.prepare(
    'SELECT COUNT(*) AS n FROM tagebuch_rueckblicke WHERE book_id = ? AND user_email = ?'
  ).get(BOOK_ID, 'tester@test.dev').n;

  seedDiary(BOOK_ID, ['2024-10-01', '2024-10-08', '2024-10-20']);
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung'), rueckblickResponse());

  const jobId1 = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024-10' }, `${BOOK_ID}:2024-10_a`);
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.rueckblick.runRueckblickJob(jobId1, BOOK_ID, 'tester@test.dev', null, '2024-10'));
  await waitForJob(ctx.shared, jobId1);
  assert.equal(latest().entry_count, 3, 'Insert speichert Eintrags-Snapshot');
  assert.equal(histCount(), 1);

  // Einen Eintrag löschen (Cache-MISS durch geänderten pages_sig), AI liefert
  // identisches Ergebnis → keine neue Zeile, aber entry_count-Snapshot wird aktualisiert.
  // Direktes SQL-Delete (der Seed ist additiv — Reseed würde die Seite nicht entfernen).
  ctx.dbSchema.db.prepare('DELETE FROM pages WHERE page_id = ?').run(BOOK_ID * 100 + 2);
  const jobId2 = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024-10' }, `${BOOK_ID}:2024-10_b`);
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.rueckblick.runRueckblickJob(jobId2, BOOK_ID, 'tester@test.dev', null, '2024-10'));
  const job2 = await waitForJob(ctx.shared, jobId2);
  assert.equal(job2.status, 'done');
  assert.equal(job2.result.fromCache, false, 'gelöschter Eintrag → Cache-MISS');
  assert.equal(histCount(), 1, 'identisches Ergebnis → keine Duplikat-Zeile');
  assert.equal(latest().entry_count, 2, 'Touch aktualisiert den Snapshot auf die neue Anzahl');
});

test('Cache-HIT: identischer 2. Lauf → 0 AI-Calls', async () => {
  const BOOK_ID = 703;
  seedDiary(BOOK_ID, ['2024-05-01', '2024-05-09']);
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung'), rueckblickResponse());

  const jobId1 = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024-05' }, `${BOOK_ID}:2024-05`);
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.rueckblick.runRueckblickJob(jobId1, BOOK_ID, 'tester@test.dev', null, '2024-05'));
  const job1 = await waitForJob(ctx.shared, jobId1);
  assert.equal(job1.status, 'done');
  assert.equal(ctx.mockAi.log.length, 1);

  const jobId2 = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024-05' }, `${BOOK_ID}:2024-05_b`);
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.rueckblick.runRueckblickJob(jobId2, BOOK_ID, 'tester@test.dev', null, '2024-05'));
  const job2 = await waitForJob(ctx.shared, jobId2);
  assert.equal(job2.status, 'done');
  assert.equal(job2.result.rueckblick.zusammenfassung, 'Ein ruhiger Monat.');
  assert.equal(ctx.mockAi.log.length, 1, 'Cache-HIT: kein neuer AI-Call');
});

test('Leerer Zeitraum → result.empty, kein AI-Call', async () => {
  const BOOK_ID = 704;
  seedDiary(BOOK_ID, ['2024-03-04']);

  const jobId = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024-08' }, `${BOOK_ID}:2024-08`);
  ctx.shared.enqueueJob(jobId, () =>
    ctx.rueckblick.runRueckblickJob(jobId, BOOK_ID, 'tester@test.dev', null, '2024-08'));
  const job = await waitForJob(ctx.shared, jobId);

  assert.equal(job.status, 'done');
  assert.equal(job.result.empty, true);
  assert.equal(ctx.mockAi.log.length, 0);
});

test('Pflichtfeld zusammenfassung fehlt → failJob', async () => {
  const BOOK_ID = 705;
  seedDiary(BOOK_ID, ['2024-06-01']);
  ctx.mockAi.on(() => true, { themen: [], personen: [], orte: [], bemerkenswerteTage: [] });

  const jobId = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024-06' }, `${BOOK_ID}:2024-06`);
  ctx.shared.enqueueJob(jobId, () =>
    ctx.rueckblick.runRueckblickJob(jobId, BOOK_ID, 'tester@test.dev', null, '2024-06'));
  const job = await waitForJob(ctx.shared, jobId);

  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.rueckblickEmpty');
});

test('kein content-store-Write: Buchinhalt bleibt unverändert', async () => {
  const BOOK_ID = 706;
  seedDiary(BOOK_ID, ['2024-07-01', '2024-07-02']);
  const before = ctx.dbSchema.db.prepare('SELECT page_id, body_html, updated_at FROM pages WHERE book_id = ? ORDER BY page_id').all(BOOK_ID);

  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung'), rueckblickResponse());
  const jobId = ctx.shared.createJob('rueckblick', BOOK_ID, 'tester@test.dev', 'job.label.rueckblick', { zeitraum: '2024-07' }, `${BOOK_ID}:2024-07`);
  ctx.shared.enqueueJob(jobId, () =>
    ctx.rueckblick.runRueckblickJob(jobId, BOOK_ID, 'tester@test.dev', null, '2024-07'));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done');

  const after = ctx.dbSchema.db.prepare('SELECT page_id, body_html, updated_at FROM pages WHERE book_id = ? ORDER BY page_id').all(BOOK_ID);
  assert.deepEqual(after, before, 'Seiteninhalt/updated_at unverändert (Job ist rein lesend)');
});
