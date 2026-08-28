'use strict';
// Integration: runMotifConsistencyJob gegen Mock-AI.
//
// Der Test haelt die zwei Dinge fest, an denen dieser Job haengt und die eine
// reine Prompt-Unit nicht zeigt:
//   1. Die deterministischen Messbefunde landen als VORBEFUND im Prompt — in der
//      Buchsprache gerendert, nicht als Code-String.
//   2. Ein leerer Ist-Index wird als UNGEPRUEFT in den Prompt geschrieben, nicht
//      als Abwesenheit — sonst meldet das Modell fuer jedes Motiv „fehlt im Text".
// Dazu die Rueckabbildung des Modell-Outputs: [#id]-Marker aufs eigene Subset
// validiert, Sprungziel deterministisch aus dem Fund-Index.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
let motifsDb;
test.before(() => {
  ctx = bootstrap();
  motifsDb = require('../../db/motifs');
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
});

const USER = 'tester@test.dev';

function seedKatalog(bookId, { withOccurrences = true } = {}) {
  ctx.dbSeed.setBook({
    chapters: [
      { id: 100, book_id: bookId, name: 'Kapitel Eins' },
      { id: 101, book_id: bookId, name: 'Kapitel Zwei' },
    ],
    pages: [
      { id: 200, book_id: bookId, chapter_id: 100, name: 'Seite Eins', updated_at: '2026-01-01' },
      { id: 201, book_id: bookId, chapter_id: 101, name: 'Seite Zwei', updated_at: '2026-01-01' },
    ],
    pageBodies: {
      200: '<p>Das Wasser stand hoch am Ufer.</p>',
      201: '<p>Im Feuer verbrannte der Brief.</p>',
    },
  });

  const wasser = motifsDb.createMotif(bookId, USER, { name: 'Wasser', beschreibung: 'Reinigung', triggerTerms: ['Wasser'] });
  const feuer = motifsDb.createMotif(bookId, USER, { name: 'Feuer', beschreibung: 'Zerstoerung', triggerTerms: ['Feuer'] });
  const spiegel = motifsDb.createMotif(bookId, USER, { name: 'Spiegel' });

  // Wasser kontrastiert Feuer — im Text stehen sie in getrennten Kapiteln
  // (Messbefund: Kontrast ohne Beruehrung). Wasser verstaerkt Spiegel, den es
  // im Text gar nicht gibt (Messbefund: Geist-Nachbar).
  motifsDb.createRelation(wasser.id, feuer.id, 'kontrastiert');
  motifsDb.createRelation(wasser.id, spiegel.id, 'verstaerkt');

  if (withOccurrences) {
    motifsDb.replaceOccurrences(wasser.id, bookId, [
      { kind: 'page', pageId: 200, score: 0.9, snippet: 'Das Wasser stand hoch am Ufer.', source: 'semantic' },
    ]);
    motifsDb.replaceOccurrences(feuer.id, bookId, [
      { kind: 'page', pageId: 201, score: 0.8, snippet: 'Im Feuer verbrannte der Brief.', source: 'semantic' },
    ]);
  }
  return { wasser, feuer, spiegel };
}

function onMotivCheck(response) {
  ctx.mockAi.on(
    (entry) => entry.prompt.includes('MOTIV-KATALOG'),
    response,
  );
}

test('Messbefunde stehen als Vorbefund im Prompt; Modell-Output wird zurueckgebunden', async () => {
  const BOOK_ID = 71;
  const { wasser } = seedKatalog(BOOK_ID);

  onMotivCheck({
    konflikte: [
      { motiv: 'Wasser', motiv_id: wasser.id, schwere: 'stark', problem: 'Traegt nur im ersten Kapitel.', vorschlag: 'Spaeter wieder aufnehmen.' },
      { motiv: '—', motiv_id: null, schwere: 'mittel', problem: 'Kein Thema gruppiert die Motive.', vorschlag: 'Themen anlegen.' },
      { motiv: 'Feuer', motiv_id: 999999, schwere: 'schwach', problem: 'Fremde ID im Marker.', vorschlag: 'Egal.' },
    ],
    fazit: 'Der Katalog steht, die Verteilung nicht.',
  });

  const jobId = ctx.shared.createJob('motif-consistency', BOOK_ID, USER, 'job.label.motivConsistency');
  ctx.shared.enqueueJob(jobId, () => ctx.motifConsistency.runMotifConsistencyJob(jobId, BOOK_ID, USER));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  // 1) Der Prompt trug die Messung — als gerenderten Satz, nicht als Code.
  const prompt = ctx.mockAi.log.find(e => e.prompt.includes('MOTIV-KATALOG')).prompt;
  assert.match(prompt, /VORBEFUNDE AUS DER MESSUNG/);
  assert.match(prompt, /wiederhole sie NICHT/);
  assert.match(prompt, /keine einzige Fundstelle im Text/, 'Geist-Nachbar-Befund gerendert');
  assert.match(prompt, /kommen in keinem gemeinsamen Kapitel vor/, 'Kontrast-Befund gerendert');
  assert.ok(!prompt.includes('geistNachbar'), 'kein roher Code im Prompt');
  assert.match(prompt, new RegExp(`\\[#${wasser.id}\\] «Wasser»`), 'Katalog traegt den ID-Marker');
  assert.match(prompt, /«Wasser» kontrastiert mit → «Feuer»/, 'Kanten-Typ als lesbare Phrase');

  // 2) Rueckabbildung: Marker-ID gilt, Fremd-ID faellt auf den Namen zurueck,
  //    „—" bleibt uebergreifend.
  const k = job.result.konflikte;
  assert.equal(k.length, 3);
  assert.equal(k[0].motiv_id, wasser.id);
  assert.equal(k[0].quelle, 'ki');
  assert.equal(k[1].motiv_id, null, 'uebergreifender Befund ohne Motiv');
  assert.ok(k[2].motiv_id !== 999999, 'fremde ID wird nicht uebernommen');

  // 3) Sprungziel kommt aus dem Fund-Index, nicht aus dem Modelltext.
  assert.equal(k[0].fundstelle.page_id, 200);
  assert.equal(k[0].fundstelle.page_name, 'Seite Eins');
  assert.equal(k[1].fundstelle, null);

  // 4) Lauf ist historisiert.
  const runs = motifsDb.listConsistencyRuns(BOOK_ID, USER);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].konflikt_count, 3);
  assert.equal(job.result.runId, runs[0].id);
  const detail = motifsDb.getConsistencyRun(runs[0].id);
  assert.equal(detail.result.fazit, 'Der Katalog steht, die Verteilung nicht.');
  assert.equal(detail.result.scanned, true);
});

test('ohne Ist-Index: Prompt sagt UNGEPRUEFT statt Abwesenheit', async () => {
  const BOOK_ID = 72;
  seedKatalog(BOOK_ID, { withOccurrences: false });

  onMotivCheck({ konflikte: [], fazit: 'Ohne Fundstellen nur der Katalog beurteilbar.' });

  const jobId = ctx.shared.createJob('motif-consistency', BOOK_ID, USER, 'job.label.motivConsistency');
  ctx.shared.enqueueJob(jobId, () => ctx.motifConsistency.runMotifConsistencyJob(jobId, BOOK_ID, USER));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  const prompt = ctx.mockAi.log.find(e => e.prompt.includes('MOTIV-KATALOG')).prompt;
  assert.match(prompt, /Motiverkennung ist für dieses Buch noch nicht gelaufen/);
  assert.match(prompt, /UNGEPRÜFT, nicht/);
  assert.ok(!prompt.includes('VORBEFUNDE AUS DER MESSUNG'),
    'ungescannt ⇒ keine Messbefunde (sie waeren alle falsch)');
  assert.equal(job.result.scanned, false);
});

test('leerer Katalog failt den Job, statt die KI ins Leere zu fragen', async () => {
  const BOOK_ID = 73;
  ctx.dbSeed.setBook({
    chapters: [{ id: 110, book_id: BOOK_ID, name: 'Kapitel Eins' }],
    pages: [{ id: 210, book_id: BOOK_ID, chapter_id: 110, name: 'Seite Eins', updated_at: '2026-01-01' }],
    pageBodies: { 210: '<p>Text ohne Katalog.</p>' },
  });

  const jobId = ctx.shared.createJob('motif-consistency', BOOK_ID, USER, 'job.label.motivConsistency');
  ctx.shared.enqueueJob(jobId, () => ctx.motifConsistency.runMotifConsistencyJob(jobId, BOOK_ID, USER));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
  assert.match(String(job.error), /motivKatalogLeer/);
  assert.equal(ctx.mockAi.log.length, 0, 'kein KI-Call ohne Motive');
});
