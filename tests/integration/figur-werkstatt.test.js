'use strict';
// Integration test: Figuren-Werkstatt Brainstorm + Consistency-Jobs.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
let werkstatt;
let draftFigDb;
test.before(() => {
  ctx = bootstrap();
  werkstatt = require('../../routes/jobs/figur-werkstatt');
  draftFigDb = require('../../db/draft-figures');
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
});

function sampleMindmap(name = 'Anna') {
  return {
    meta: { name: 'figur-werkstatt', version: '1' },
    format: 'node_tree',
    data: {
      id: 'root', topic: name,
      children: [
        { id: 'steckbrief', topic: 'Steckbrief', children: [
          { id: 'aussehen',    topic: 'Aussehen' },
          { id: 'hintergrund', topic: 'Hintergrund' },
        ]},
        { id: 'stimme', topic: 'Stimme', children: [] },
      ],
    },
  };
}

function brainstormResponse() {
  return {
    vorschlaege: [
      { label: 'Verwitwet, schweigsam',          begruendung: 'verstärkt Konflikt-Achse' },
      { label: 'Adoptiert, sucht Wurzeln',       begruendung: 'gibt Want und Need Spannung' },
      { label: 'Aus Bergdorf, Stadtmüde',        begruendung: 'passt zum 1920er-Setting' },
    ],
  };
}

function consistencyResponse() {
  return {
    konflikte: [
      { feld: 'Beruf',   schwere: 'stark',   problem: 'Beruf passt nicht zur Epoche', vorschlag: 'auf Modistin ändern' },
      { feld: 'Konflikt', schwere: 'mittel', problem: 'doppelt sich mit Boris',        vorschlag: 'differenzieren' },
    ],
    fazit: 'Solider Kern, zwei Stellen klären.',
  };
}

// ── Brainstorm ─────────────────────────────────────────────────────────────

test('Brainstorm: Mindmap-Knoten → Vorschläge ins Job-Result', async () => {
  const BOOK_ID = 6101;
  const userEmail = 'autor@test.dev';
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {} });
  // book row needed (FK)
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'Werkstatt-Buch');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', archetype: 'protagonist', mindmap: sampleMindmap('Anna'),
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('vorschlaege'),
    brainstormResponse(),
  );

  const jobId = ctx.shared.createJob(
    'werkstatt-brainstorm', BOOK_ID, userEmail,
    'job.label.werkstattBrainstorm', { figur: 'Anna' },
    `${draft.id}|hintergrund`,
  );
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runBrainstormJob(jobId, draft.id, 'hintergrund', userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.vorschlaege.length, 3);
  assert.equal(job.result.vorschlaege[0].label, 'Verwitwet, schweigsam');
  assert.equal(job.result.knotenId, 'hintergrund');
  assert.equal(job.result.knotenPfad, 'Anna > Steckbrief > Hintergrund');
});

test('Brainstorm: KI ohne vorschlaege-Array → failJob', async () => {
  const BOOK_ID = 6102;
  const userEmail = 'autor@test.dev';
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap(),
  });

  ctx.mockAi.on(() => true, { fazit: 'falsche Form' });

  const jobId = ctx.shared.createJob('werkstatt-brainstorm', BOOK_ID, userEmail, 'l');
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runBrainstormJob(jobId, draft.id, 'aussehen', userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.werkstatt.vorschlaegeMissing');
});

test('Brainstorm: unbekannter Knoten → failJob mit knotenMissing', async () => {
  const BOOK_ID = 6103;
  const userEmail = 'autor@test.dev';
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap(),
  });

  const jobId = ctx.shared.createJob('werkstatt-brainstorm', BOOK_ID, userEmail, 'l');
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runBrainstormJob(jobId, draft.id, 'unbekannt-xyz', userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.werkstatt.knotenMissing');
  assert.equal(ctx.mockAi.log.length, 0, 'KI sollte nicht angefragt werden');
});

test('Brainstorm: fremde draft → failJob forbidden', async () => {
  const BOOK_ID = 6104;
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, 'owner@test.dev', {
    name: 'Anna', mindmap: sampleMindmap(),
  });

  const jobId = ctx.shared.createJob('werkstatt-brainstorm', BOOK_ID, 'eindringling@test.dev', 'l');
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runBrainstormJob(jobId, draft.id, 'aussehen', 'eindringling@test.dev'),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.forbidden');
});

// ── Consistency ─────────────────────────────────────────────────────────────

test('Consistency: Konflikte mit Severity-Skala + Fazit', async () => {
  const BOOK_ID = 6201;
  const userEmail = 'autor@test.dev';
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', archetype: 'protagonist', mindmap: sampleMindmap(),
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('konflikte') && e.schemaKeys.includes('fazit'),
    consistencyResponse(),
  );

  const jobId = ctx.shared.createJob('werkstatt-consistency', BOOK_ID, userEmail, 'l', null, draft.id);
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runConsistencyJob(jobId, draft.id, userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.konflikte.length, 2);
  assert.equal(job.result.konflikte[0].schwere, 'stark');
  assert.equal(job.result.konflikte[1].schwere, 'mittel');
  assert.match(job.result.fazit, /Solider Kern/);
});

test('Consistency: ungültige Severity → fallback "mittel"', async () => {
  const BOOK_ID = 6202;
  const userEmail = 'autor@test.dev';
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap(),
  });

  ctx.mockAi.on(() => true, {
    konflikte: [{ feld: 'X', schwere: 'megakritisch', problem: 'p', vorschlag: 'v' }],
    fazit: 'ok',
  });

  const jobId = ctx.shared.createJob('werkstatt-consistency', BOOK_ID, userEmail, 'l', null, draft.id);
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runConsistencyJob(jobId, draft.id, userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.konflikte[0].schwere, 'mittel');
});

test('Consistency: leeres konflikte-Array + Fazit ist gültig', async () => {
  const BOOK_ID = 6203;
  const userEmail = 'autor@test.dev';
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap(),
  });

  ctx.mockAi.on(() => true, { konflikte: [], fazit: 'Stimmig.' });

  const jobId = ctx.shared.createJob('werkstatt-consistency', BOOK_ID, userEmail, 'l', null, draft.id);
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runConsistencyJob(jobId, draft.id, userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.konflikte.length, 0);
  assert.equal(job.result.fazit, 'Stimmig.');
});

test('Consistency: KI ohne fazit → failJob', async () => {
  const BOOK_ID = 6204;
  const userEmail = 'autor@test.dev';
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap(),
  });

  ctx.mockAi.on(() => true, { konflikte: [] });

  const jobId = ctx.shared.createJob('werkstatt-consistency', BOOK_ID, userEmail, 'l', null, draft.id);
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runConsistencyJob(jobId, draft.id, userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.werkstatt.fazitMissing');
});

// ── Buch-Kontext: Ausschluss der Werkstatt-Figur selbst ────────────────────
// Die Figur darf nicht in ihrem eigenen Abgrenzungs-Kontext stehen: sonst lehnt
// die KI ihre eigenen Eigenschaften als „Doppelung mit Buchfigur" ab und der
// Consistency-Check meldet jeden importierten Aspekt als Namenskonflikt.
// Zwei Filter, weil ein frei angelegter Draft keine source_figure_id hat und
// der User den Werkstatt-Namen jederzeit aendern darf. Beide sitzen im Loader
// (_loadBookFiguren) — vorher standen sie in jedem Job-Runner einzeln.

function _seedFigur(bookId, userEmail, figId, name, sortOrder) {
  const now = new Date().toISOString();
  return ctx.dbSchema.db.prepare(`
    INSERT INTO figures (book_id, fig_id, name, typ, beschreibung, sort_order, user_email, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(bookId, figId, name, 'Nebenfigur', 'Beschreibung', sortOrder, userEmail, now).lastInsertRowid;
}

// Der Figuren-Block des Prompts ist der einzige Ort, an dem Namen als
// Abgrenzungs-Liste auftauchen; der Rest des Prompts nennt die Werkstatt-Figur
// natuerlich sehr wohl (als FIGUR: und in der Mindmap).
function _figurenBlock(prompt) {
  const m = /BESTEHENDE FIGUREN IM BUCH[^\n]*:\n([\s\S]*?)\n\n/.exec(prompt);
  return m ? m[1] : '';
}

test('Brainstorm: importierte Quell-Figur fehlt im Abgrenzungs-Kontext', async () => {
  const BOOK_ID = 6301;
  const userEmail = 'autor@test.dev';
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'Ausschluss-Buch');

  const annaId = _seedFigur(BOOK_ID, userEmail, 'fig_anna', 'Anna', 0);
  _seedFigur(BOOK_ID, userEmail, 'fig_boris', 'Boris', 1);

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', archetype: 'protagonist', mindmap: sampleMindmap('Anna'),
    sourceFigureId: annaId,
  });

  ctx.mockAi.on((e) => e.schemaKeys.includes('vorschlaege'), brainstormResponse());
  const jobId = ctx.shared.createJob('werkstatt-brainstorm', BOOK_ID, userEmail,
    'job.label.werkstattBrainstorm', { figur: 'Anna' }, `${draft.id}|hintergrund`);
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runBrainstormJob(jobId, draft.id, 'hintergrund', userEmail));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', job.error || '');

  const block = _figurenBlock(ctx.mockAi.log.at(-1).prompt);
  assert.ok(block.includes('Boris'), 'fremde Buchfigur muss im Abgrenzungs-Kontext stehen');
  assert.ok(!block.includes('Anna'), 'die Werkstatt-Figur selbst darf nicht darin stehen');
});

test('Consistency: gleichnamige Buchfigur ohne Import-Referenz faellt ebenfalls raus', async () => {
  const BOOK_ID = 6302;
  const userEmail = 'autor@test.dev';
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'Namensfilter-Buch');

  _seedFigur(BOOK_ID, userEmail, 'fig_clara', 'Clara', 0);
  _seedFigur(BOOK_ID, userEmail, 'fig_dora',  'Dora',  1);

  // Frei angelegt: keine source_figure_id, nur der Name deckt sich.
  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: '  clara ', mindmap: sampleMindmap('Clara'),
  });

  ctx.mockAi.on((e) => e.schemaKeys.includes('konflikte'), consistencyResponse());
  const jobId = ctx.shared.createJob('werkstatt-consistency', BOOK_ID, userEmail,
    'job.label.werkstattConsistency', { figur: 'Clara' }, draft.id);
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runConsistencyJob(jobId, draft.id, userEmail));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', job.error || '');

  const block = _figurenBlock(ctx.mockAi.log.at(-1).prompt);
  assert.ok(block.includes('Dora'), 'fremde Buchfigur muss im Kontext stehen');
  assert.ok(!block.includes('Clara'), 'Namensgleichheit (getrimmt, case-insensitiv) muss ausschliessen');
});

// ── Lauf-Historie: aufgezeichnetes Modell ──────────────────────────────────
// `werkstatt_runs.model` beantwortet spaeter „womit ist dieser Lauf entstanden".
// Der Name muss vom EFFEKTIVEN Provider kommen; ein Aufruf ohne Provider faellt
// im _modelName-Zweig auf Claude zurueck und schreibt bei jedem lokalen Modell
// einen falschen Namen in die Historie.
test('Brainstorm-Lauf haelt das Modell des effektiven Providers fest', async () => {
  const BOOK_ID = 6303;
  const userEmail = 'autor@test.dev';
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'Modell-Buch');

  const appSettings = require('../../lib/app-settings');
  const prevProvider = appSettings.get('ai.provider');
  const prevModel = appSettings.get('ai.ollama.model');
  appSettings.set('ai.provider', 'ollama');
  appSettings.set('ai.ollama.model', 'mistral-small3.2');
  try {
    const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
      name: 'Emil', mindmap: sampleMindmap('Emil'),
    });
    ctx.mockAi.on((e) => e.schemaKeys.includes('vorschlaege'), brainstormResponse());
    const jobId = ctx.shared.createJob('werkstatt-brainstorm', BOOK_ID, userEmail,
      'job.label.werkstattBrainstorm', { figur: 'Emil' }, `${draft.id}|hintergrund`);
    ctx.shared.enqueueJob(jobId, () =>
      werkstatt.runBrainstormJob(jobId, draft.id, 'hintergrund', userEmail));
    const job = await waitForJob(ctx.shared, jobId);
    assert.equal(job.status, 'done', job.error || '');

    const run = draftFigDb.getWerkstattRun(job.result.runId);
    assert.equal(run.model, 'mistral-small3.2');
  } finally {
    appSettings.set('ai.provider', prevProvider);
    appSettings.set('ai.ollama.model', prevModel);
  }
});

// ── _findKnotenPfad ─────────────────────────────────────────────────────────

test('_findKnotenPfad: liefert "Wurzel > … > Knoten"-Pfad', () => {
  const tree = sampleMindmap('Anna').data;
  assert.equal(werkstatt._findKnotenPfad(tree, 'root'),       'Anna');
  assert.equal(werkstatt._findKnotenPfad(tree, 'steckbrief'), 'Anna > Steckbrief');
  assert.equal(werkstatt._findKnotenPfad(tree, 'aussehen'),   'Anna > Steckbrief > Aussehen');
  assert.equal(werkstatt._findKnotenPfad(tree, 'stimme'),     'Anna > Stimme');
  assert.equal(werkstatt._findKnotenPfad(tree, 'unbekannt'),  null);
});
