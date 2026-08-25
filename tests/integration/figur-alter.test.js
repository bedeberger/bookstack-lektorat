'use strict';
// Integration: Alters-Analyse der Figuren (routes/jobs/figur-alter.js) mit Mock-AI.
//
// Testgegenstand ist die Naht zwischen den drei Schichten — Kandidatensuche →
// Modell → Verifikation/Verdichtung → abgeleiteter Index. Die reinen Schichten
// sind separat gegated (tests/unit/figure-age.test.js); hier zaehlt, dass ein
// erfundenes Zitat und eine im Zitat nicht vorkommende Zahl WIRKLICH herausfallen
// und dass nur verifizierte Angaben in figure_ages/figure_age_belege landen.

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

const USER = 'tester@test.dev';

function seedFiguren(bookId, figuren) {
  ctx.dbSchema.saveFigurenToDb(bookId, figuren, USER, null);
  return ctx.dbSchema.db.prepare(
    'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email = ?'
  ).all(bookId, USER);
}

function runJob(bookId, opts = {}) {
  const jobId = ctx.shared.createJob('figur-alter', bookId, USER, 'job.label.figurAlter');
  ctx.shared.enqueueJob(jobId, () => ctx.figurAlter.runFigurAlterJob(jobId, bookId, USER, opts));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 15000 });
}

test('Kandidatensaetze werden gefunden, verifizierte Funde landen im Index', async () => {
  const BOOK_ID = 900;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9010, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [
      { id: 9020, book_id: BOOK_ID, chapter_id: 9010, name: 'S 1', updated_at: '' },
      { id: 9021, book_id: BOOK_ID, chapter_id: 9010, name: 'S 2', updated_at: '' },
    ],
    pageBodies: {
      9020: '<p>Anna Berg betrat den Saal. Sie war damals zwölf Jahre alt und trug ein blaues Kleid.</p>',
      9021: '<p>Konrad, geboren 1888, schwieg. Die neunzehnjährige Anna Berg widersprach ihm.</p>',
    },
  });
  seedFiguren(BOOK_ID, [
    { id: 'f_anna', name: 'Anna Berg', kurzname: 'Anna', typ: 'hauptfigur' },
    { id: 'f_konrad', name: 'Konrad', typ: 'nebenfigur' },
  ]);

  // Das Modell bekommt die Kandidatensaetze und meldet, was darin steht.
  // Bewusst dabei: ein FREI ERFUNDENES Zitat und eine Zahl, die im (echten)
  // Zitat nicht vorkommt — beides muss herausfallen.
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => ({
      funde: [
        { figur: 'Anna Berg', art: 'alter', wert: 12, bezugsjahr: null, unsicher: false, zitat: 'Sie war damals zwölf Jahre alt', begruendung: 'wörtlich' },
        { figur: 'Anna', art: 'alter', wert: 19, bezugsjahr: null, unsicher: false, zitat: 'Die neunzehnjährige Anna Berg', begruendung: 'wörtlich' },
        { figur: 'Konrad', art: 'geburtsjahr', wert: 1888, bezugsjahr: null, unsicher: false, zitat: 'Konrad, geboren 1888', begruendung: 'wörtlich' },
        // erfundenes Zitat → Zitat-Pruefung
        { figur: 'Konrad', art: 'alter', wert: 55, bezugsjahr: null, unsicher: false, zitat: 'Konrad war fünfundfünfzig Jahre alt', begruendung: 'erfunden' },
        // echtes Zitat, aber die Zahl steht nicht darin → Zahl-Pruefung
        { figur: 'Anna Berg', art: 'alter', wert: 30, bezugsjahr: null, unsicher: false, zitat: 'Sie war damals zwölf Jahre alt', begruendung: 'gerechnet' },
        // unbekannte Figur → Namens-Zuordnung
        { figur: 'Niemand', art: 'alter', wert: 40, bezugsjahr: null, unsicher: false, zitat: 'egal', begruendung: '' },
      ],
    }),
  );

  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.verworfen.zitat, 1, 'erfundenes Zitat verworfen');
  assert.equal(job.result.verworfen.zahl, 1, 'Zahl nicht im Zitat → verworfen');
  assert.equal(job.result.verworfen.figur, 1, 'unbekannte Figur verworfen');

  const rows = require('../../db/figure-ages').listFigureAges(BOOK_ID, USER);
  const anna = rows.find(r => r.fig_id === 'f_anna');
  const konrad = rows.find(r => r.fig_id === 'f_konrad');

  // Anna: Spanne aus zwei verifizierten Angaben, Quelle Text.
  assert.ok(anna, 'Anna hat eine Zeile');
  assert.equal(anna.alter_von, 12);
  assert.equal(anna.alter_bis, 19);
  assert.equal(anna.quelle, 'text');
  assert.equal(anna.belege.length, 2, 'nur die verifizierten Belege');
  assert.ok(anna.belege.every(b => b.page_id != null), 'Beleg hat ein Sprungziel');

  // Konrad: Geburtsjahr aus dem Text, kein Alter (das erfundene fiel heraus).
  assert.ok(konrad, 'Konrad hat eine Zeile');
  assert.equal(konrad.geburtsjahr, 1888);
  assert.equal(konrad.geburtsjahr_quelle, 'text');
  assert.equal(konrad.alter_von, null, 'kein erfundenes Alter');

  // Lauf-Kopf für „Stand vom" + Delta-Skip.
  const scan = require('../../db/figure-ages').getFigureAgeScan(BOOK_ID, USER);
  assert.ok(scan?.content_sig, 'content_sig gesetzt');
  assert.equal(scan.figuren_total, 2);
  assert.equal(scan.mit_alter, 1);
});

test('Delta-Skip: unveraenderter Buchstand ohne force laeuft nicht erneut durchs Modell', async () => {
  const BOOK_ID = 901;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9110, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9120, book_id: BOOK_ID, chapter_id: 9110, name: 'S 1', updated_at: '' }],
    pageBodies: { 9120: '<p>Mara war vierzig Jahre alt, als sie ging.</p>' },
  });
  seedFiguren(BOOK_ID, [{ id: 'f_mara', name: 'Mara', typ: 'hauptfigur' }]);
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => ({ funde: [{ figur: 'Mara', art: 'alter', wert: 40, bezugsjahr: null, unsicher: false, zitat: 'Mara war vierzig Jahre alt', begruendung: '' }] }),
  );

  const first = await runJob(BOOK_ID, { force: true });
  assert.equal(first.status, 'done');
  const callsAfterFirst = ctx.mockAi.log.length;
  assert.ok(callsAfterFirst >= 1);

  const second = await runJob(BOOK_ID, { force: false });
  assert.equal(second.status, 'done');
  assert.equal(second.result.skipped, true, 'zweiter Lauf uebersprungen');
  assert.equal(ctx.mockAi.log.length, callsAfterFirst, 'kein weiterer KI-Call');

  // Mit force laeuft er trotzdem — „ich will jetzt eine Zahl sehen".
  const third = await runJob(BOOK_ID, { force: true });
  assert.equal(third.status, 'done');
  assert.notEqual(third.result.skipped, true);
  assert.ok(ctx.mockAi.log.length > callsAfterFirst);
});

test('Figur ohne Altersangabe im Text bekommt keine Zeile', async () => {
  const BOOK_ID = 902;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9210, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9220, book_id: BOOK_ID, chapter_id: 9210, name: 'S 1', updated_at: '' }],
    pageBodies: { 9220: '<p>Jonas ging zum Fluss und schwieg lange.</p>' },
  });
  seedFiguren(BOOK_ID, [{ id: 'f_jonas', name: 'Jonas', typ: 'hauptfigur' }]);
  // Kein Kandidatensatz → gar kein KI-Call.
  const job = await runJob(BOOK_ID, { force: true });
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(ctx.mockAi.log.length, 0, 'ohne Kandidaten kein KI-Call');
  assert.equal(require('../../db/figure-ages').listFigureAges(BOOK_ID, USER).length, 0);
});

test('Ohne Figuren bricht der Job mit sprechendem Fehler ab', async () => {
  const BOOK_ID = 903;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9310, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9320, book_id: BOOK_ID, chapter_id: 9310, name: 'S 1', updated_at: '' }],
    pageBodies: { 9320: '<p>Irgendwer war zwölf Jahre alt.</p>' },
  });
  const job = await runJob(BOOK_ID, { force: true });
  assert.equal(job.status, 'error');
  assert.match(String(job.error), /figurAlterNoFiguren/);
});

test('Ein mehrdeutiger Kurzname wird nicht geraten', async () => {
  const BOOK_ID = 904;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9410, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9420, book_id: BOOK_ID, chapter_id: 9410, name: 'S 1', updated_at: '' }],
    pageBodies: { 9420: '<p>Anna Berg war zwölf Jahre alt. Anna Meier war vierzig Jahre alt.</p>' },
  });
  // Beide tragen den Kurznamen «Anna» — eine Antwort mit «Anna» ist nicht zuordenbar.
  seedFiguren(BOOK_ID, [
    { id: 'f_ab', name: 'Anna Berg', kurzname: 'Anna', typ: 'hauptfigur' },
    { id: 'f_am', name: 'Anna Meier', kurzname: 'Anna', typ: 'nebenfigur' },
  ]);
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => ({
      funde: [
        { figur: 'Anna', art: 'alter', wert: 12, bezugsjahr: null, unsicher: false, zitat: 'Anna Berg war zwölf Jahre alt', begruendung: '' },
        { figur: 'Anna Meier', art: 'alter', wert: 40, bezugsjahr: null, unsicher: false, zitat: 'Anna Meier war vierzig Jahre alt', begruendung: '' },
      ],
    }),
  );

  const job = await runJob(BOOK_ID, { force: true });
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.verworfen.figur, 1, 'mehrdeutiger Kurzname verworfen');

  const rows = require('../../db/figure-ages').listFigureAges(BOOK_ID, USER);
  assert.equal(rows.length, 1, 'nur die eindeutig benannte Figur');
  assert.equal(rows[0].fig_id, 'f_am');
  assert.equal(rows[0].alter_von, 40);
});
