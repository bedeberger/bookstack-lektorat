'use strict';
// Integration test: runKomplettAnalyseJob single-pass.
// Pipeline (Claude): Phase 1 split → A1 (Figuren-Stammdaten) + B (Orte/Szenen) +
// A2 (Beziehungen) → Phase 2/3 skipped (single-pass) → Phase 6 Zeitstrahl skipped
// (< 5 events) → Phase 8 Kontinuität.
// Expected: 4 AI calls (A1 + B + A2 + P8).

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');
const { buildBookPagesSig } = require('../../routes/jobs/komplett/utils');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
  // Completeness-Gap-Pässe defaultmässig AUS, damit die Single-Pass-Call-Counts
  // deterministisch den Kernpfad (A1+B+C+E+A2) prüfen. Der dedizierte
  // Completeness-Test schaltet sie gezielt ein. Lazy require: app-settings öffnet
  // die DB-Connection beim Laden – darf erst NACH bootstrap() (DB_PATH gesetzt) passieren.
  require('../../lib/app-settings').set('ai.komplett.completeness_passes', 0);
  // Coverage-Self-Audit (F2) und Attribut-Widerspruchs-Detektor (F4) defaultmässig AUS —
  // beide fügen KI-Calls hinzu und würden die Kernpfad-Call-Counts verfälschen. Dedizierte
  // Tests schalten sie gezielt ein.
  require('../../lib/app-settings').set('ai.komplett.coverage_audit_chapters', 0);
  require('../../lib/app-settings').set('ai.komplett.attribute_check', false);
  // Erzählprofil-Phase defaultmässig AUS (fügt pro Lauf/Kapitel KI-Calls hinzu und würde
  // die Kernpfad-Call-Counts verfälschen). Der dedizierte Erzählprofil-Test schaltet sie ein.
  require('../../lib/app-settings').set('ai.komplett.narrative_profile', false);
});

function seedTinyBook(bookId) {
  ctx.dbSeed.setBook({
    chapters: [{ id: 1100, book_id: bookId, name: 'Kapitel Eins' }],
    pages: [{ id: 1200, book_id: bookId, chapter_id: 1100, name: 'Seite Eins', updated_at: '2026-01-01' }],
    pageBodies: { 1200: '<p>' + 'Anna ging in den Wald. Es war kalt. '.repeat(40) + '</p>' },
  });
}

// Claude-Single-Pass A1: nur Figuren-Stammdaten (OHNE Beziehungen, OHNE Lebensereignisse).
// Zwei Figuren, damit der A2-Beziehungs-Pass (>= 2 Figuren) ausgelöst wird.
function figurenStammResponse() {
  return {
    figuren: [
      {
        id: 'fig_1', name: 'Anna', kurzname: 'Anna', typ: 'protagonist',
        beschreibung: 'Hauptfigur', sozialschicht: 'mitte', praesenz: 'zentral',
        kapitel: [{ name: 'Kapitel Eins', haeufigkeit: 1 }],
        eigenschaften: [], schluesselzitate: [],
      },
      {
        id: 'fig_2', name: 'Bert', kurzname: 'Bert', typ: 'nebenfigur',
        beschreibung: 'Begleiter', sozialschicht: 'mitte', praesenz: 'punktuell',
        kapitel: [{ name: 'Kapitel Eins', haeufigkeit: 1 }],
        eigenschaften: [], schluesselzitate: [],
      },
    ],
  };
}

// Claude-Single-Pass E: nur Lebensereignisse pro Figur (eigener Call).
function eventsPassResponse() {
  return { assignments: [{ figur_name: 'Anna', lebensereignisse: [] }] };
}

// Claude-Single-Pass B: Orte + Songs + Szenen (Fakten laufen über Call C).
function ortePassResponse() {
  return {
    orte: [{
      id: 'ort_1', name: 'Wald', typ: 'natur', beschreibung: 'kalt',
      kapitel: [{ name: 'Kapitel Eins', haeufigkeit: 1 }], figuren_namen: ['Anna'],
    }],
    songs: [],
    szenen: [{
      seite: 'Seite Eins', kapitel: 'Kapitel Eins', titel: 'Anna im Wald',
      wertung: 'mittel', kommentar: 'kurze Szene',
      figuren_namen: ['Anna'], orte_namen: ['Wald'],
    }],
  };
}

// Claude-Single-Pass C: nur Fakten (eigener Call).
function faktenPassResponse() {
  return {
    fakten: [{ kategorie: 'wetter', subjekt: 'Wald', fakt: 'kalt', seite: 'Seite Eins' }],
  };
}

// Claude-Single-Pass A2: flache Beziehungen (von/zu).
function beziehungenResponse() {
  return {
    beziehungen: [
      { von: 'fig_1', zu: 'fig_2', typ: 'freund', machtverhaltnis: 0, beschreibung: 'reisen zusammen', belege: [] },
    ],
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

  // A1: Figuren-Stammdaten (nur figuren, KEINE assignments, KEIN orte).
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'),
    figurenStammResponse(),
  );
  // B: Orte/Szenen (orte + szenen, KEINE figuren).
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'),
    ortePassResponse(),
  );
  // C: Fakten (nur fakten).
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'),
    faktenPassResponse(),
  );
  // E: Lebensereignisse (nur assignments).
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'),
    eventsPassResponse(),
  );
  // A2: Beziehungen.
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'),
    beziehungenResponse(),
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
  assert.equal(job.result.figCount, 2);
  assert.equal(job.result.orteCount, 1);
  assert.equal(job.result.szenenCount, 1);
  assert.equal(job.passMode, 'single');

  // Exactly 6 AI calls: A1 + B + C + E + A2 + P8 (Completeness aus, siehe beforeEach).
  assert.equal(ctx.mockAi.log.length, 6, `expected 6 AI calls, got ${ctx.mockAi.log.length}`);

  // Figures saved (Anna + Bert).
  const figRows = ctx.dbSchema.db.prepare(
    'SELECT name, typ FROM figures WHERE book_id = ? AND user_email = ? ORDER BY name'
  ).all(BOOK_ID, 'tester@test.dev');
  assert.equal(figRows.length, 2);
  assert.equal(figRows[0].name, 'Anna');

  // Relationship from A2 pass persisted (Anna → Bert).
  const relRows = ctx.dbSchema.db.prepare(
    'SELECT COUNT(*) AS n FROM figure_relations WHERE book_id = ?'
  ).get(BOOK_ID);
  assert.equal(relRows.n, 1, `expected 1 relation from A2 pass, got ${relRows.n}`);

  // Locations saved.
  const ortRows = ctx.dbSchema.db.prepare(
    'SELECT name FROM locations WHERE book_id = ? AND user_email = ?'
  ).all(BOOK_ID, 'tester@test.dev');
  assert.equal(ortRows.length, 1);
  assert.equal(ortRows[0].name, 'Wald');

  // World-Fakten persisted. Single-Pass-Fakt unter 'Gesamtbuch' matcht kein Kapitel,
  // bekommt aber über seinen eindeutigen Seitennamen ('Seite Eins' → page 1200 →
  // chapter 1100) eine Chapter-Bridge (saveFaktenToDb-Seiten-Fallback).
  const faktRows = ctx.dbSchema.db.prepare(
    'SELECT id, kategorie, subjekt, fakt FROM world_facts WHERE book_id = ? AND user_email = ?'
  ).all(BOOK_ID, 'tester@test.dev');
  assert.equal(faktRows.length, 1);
  assert.equal(faktRows[0].fakt, 'kalt');
  const wfcRows = ctx.dbSchema.db.prepare(
    'SELECT chapter_id FROM world_fact_chapters wfc JOIN world_facts wf ON wf.id = wfc.fact_id WHERE wf.book_id = ?'
  ).all(BOOK_ID);
  assert.equal(wfcRows.length, 1, 'Seiten-Fallback verbrückt den Gesamtbuch-Fakt aufs Kapitel');
  assert.equal(wfcRows[0].chapter_id, 1100);

  // Continuity check stored.
  const cont = ctx.dbSchema.getLatestContinuityCheck(BOOK_ID, 'tester@test.dev');
  assert.ok(cont);
  assert.equal(cont.summary, 'Stimmig.');
});

test('Komplettanalyse Single-Pass: Erzählprofil-Phase persistiert POV/Intensität/Themen pro Kapitel', async () => {
  const BOOK_ID = 51;
  seedTinyBook(BOOK_ID);
  require('../../lib/app-settings').set('ai.komplett.narrative_profile', true);

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'),
    figurenStammResponse());
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'),
    ortePassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'), faktenPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'), eventsPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'), beziehungenResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'), kontinuitaetResponse());
  // Erzählprofil Single-Pass: schemaKeys === ['kapitel'].
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('kapitel'),
    {
      kapitel: [{
        kapitel: 'Kapitel Eins', perspektive: 'ich', erzaehlzeit: 'praeteritum',
        erzaehler_figur: 'Anna', pov_konfidenz: 0.9, pov_beleg: 'Ich ging in den Wald',
        intensitaet: 4, intensitaet_begruendung: 'Zuspitzung', zusammenfassung: 'Anna entdeckt etwas.',
        themen: [{ thema: 'Kälte', typ: 'motiv', beleg: 'Es war kalt' }],
      }],
    });

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Testbuch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  const profile = ctx.dbSchema.getChapterNarrativeProfile(BOOK_ID, 'tester@test.dev');
  assert.equal(profile.chapters.length, 1, 'ein Kapitel-Profil gespeichert');
  const ch = profile.chapters[0];
  assert.equal(ch.perspektive, 'ich');
  assert.equal(ch.erzaehlzeit, 'praeteritum');
  assert.equal(ch.intensitaet, 4);
  assert.equal(ch.chapter_id, 1100, 'Kapitelname → chapter_id aufgelöst');
  assert.ok(ch.erzaehler_figur_id != null, 'Erzähler «Anna» → figure_id aufgelöst (kein Snapshot)');
  assert.equal(ch.erzaehler_figur, 'Anna', 'Erzähler-Name via JOIN auf figures');
  assert.equal(ch.themen.length, 1);
  assert.equal(ch.themen[0].thema, 'Kälte');
  assert.equal(ch.themen[0].typ, 'motiv');
});

test('Komplettanalyse Single-Pass: Completeness-Pass ergänzt übersehene Figuren/Orte additiv', async () => {
  const BOOK_ID = 51;
  seedTinyBook(BOOK_ID);

  // Gap-Matcher ZUERST registrieren (Dispatcher = first-match): über den Prompt-Marker
  // `bereits_erfasste_*` von der Erst-Extraktion unterschieden. Liefert je eine NEUE
  // Entität, die der Erstdurchgang ausgelassen hat.
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && e.prompt.includes('bereits_erfasste_figuren'),
    { figuren: [{ id: 'fig_1', name: 'Clara', kurzname: 'Clara', typ: 'nebenfigur', beschreibung: 'übersehen',
      kapitel: [{ name: 'Kapitel Eins', haeufigkeit: 1 }], eigenschaften: [], schluesselzitate: [] }] },
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('orte') && e.prompt.includes('bereits_erfasste_schauplaetze'),
    { orte: [{ id: 'ort_1', name: 'Hütte', typ: 'gebaeude', beschreibung: 'übersehen',
      kapitel: [{ name: 'Kapitel Eins', haeufigkeit: 1 }], figuren_namen: [] }], songs: [], szenen: [] },
  );
  // Erst-Extraktion (A1 + B + C + E + A2) + P8 wie im Basis-Test.
  ctx.mockAi.on((e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'), figurenStammResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'), ortePassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'), faktenPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'), eventsPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'), beziehungenResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'), kontinuitaetResponse());

  const appSettings = require('../../lib/app-settings');
  appSettings.set('ai.komplett.completeness_passes', 1);
  try {
    const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
    ctx.shared.enqueueJob(jobId, () =>
      ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Testbuch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
    );
    const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
    assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
    // Anna + Bert (A1) + Clara (Figuren-Gap) = 3; Wald (B) + Hütte (Orte-Gap) = 2.
    assert.equal(job.result.figCount, 3, 'Completeness-Pass ergänzt die übersehene Figur Clara');
    assert.equal(job.result.orteCount, 2, 'Completeness-Pass ergänzt den übersehenen Ort Hütte');

    const figNames = ctx.dbSchema.db.prepare(
      'SELECT name FROM figures WHERE book_id = ? AND user_email = ? ORDER BY name'
    ).all(BOOK_ID, 'tester@test.dev').map(r => r.name);
    assert.deepEqual(figNames, ['Anna', 'Bert', 'Clara']);

    // 10 Calls: A1 + B + C + Figuren-Gap + Orte-Gap + Fakten-Gap + Szenen-Gap + E + A2 + P8.
    assert.equal(ctx.mockAi.log.length, 10, `expected 10 AI calls, got ${ctx.mockAi.log.length}`);
  } finally {
    appSettings.set('ai.komplett.completeness_passes', 0);
  }
});

test('Komplettanalyse Single-Pass: Fakten-Pass (C) scheitert → Job ok, Warnung, KEIN Cache', async () => {
  const BOOK_ID = 56;
  seedTinyBook(BOOK_ID);

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'),
    figurenStammResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'),
    ortePassResponse(),
  );
  // C (Fakten) wirft einen deterministischen Fehler → faktenFailed-Pfad.
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'),
    () => { throw new Error('fakten-pass kaputt'); },
  );
  // E: Lebensereignisse (nur assignments).
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'),
    eventsPassResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'),
    beziehungenResponse(),
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
  // Job bleibt erfolgreich – ein gescheiterter Fakten-Call verwirft nicht die teure
  // Figuren-/Orte-Extraktion.
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.figCount, 2);
  // Degradierung user-sichtbar als Warnung.
  assert.ok((job.result.warnings || []).some(w => w.key === 'job.warn.faktenFailed'),
    `expected faktenFailed warning, got ${JSON.stringify(job.result.warnings)}`);
  // Keine Fakten gespeichert (C ist gescheitert).
  const faktRows = ctx.dbSchema.db.prepare(
    'SELECT COUNT(*) AS n FROM world_facts WHERE book_id = ?'
  ).get(BOOK_ID);
  assert.equal(faktRows.n, 0);
  // KRITISCH: der '__singlepass__'-Cache (book_extract_cache) darf NICHT eingefroren
  // werden – sonst Phantom-leere-Fakten bei jedem Folgelauf bis zur Seitenedition.
  const cacheRows = ctx.dbSchema.db.prepare(
    'SELECT COUNT(*) AS n FROM book_extract_cache WHERE book_id = ?'
  ).get(BOOK_ID);
  assert.equal(cacheRows.n, 0, 'Single-Pass-Cache muss bei faktenFailed übersprungen werden');
  // KRITISCH (Phantom-Erfolg über Resume): ebenso darf KEIN Checkpoint eingefroren werden,
  // sonst lädt ein Resume nach Crash den fakten-losen Teilstand und überspringt Phase 1 ganz.
  const cp = ctx.dbSchema.loadCheckpoint('komplett-analyse', BOOK_ID, 'tester@test.dev');
  assert.equal(cp, null, 'Checkpoint muss bei faktenFailed übersprungen werden (partialFailure-Gate)');
});

test('Komplettanalyse: leeres Buch → result.empty, kein AI-Call', async () => {
  const BOOK_ID = 51;
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {}, books: [{ id: BOOK_ID, name: 'Leer' }] });

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
    // ~40K chars body each → 120K total → Multi-Pass (> SINGLE_PASS_LIMIT=113400),
    // jedes Kapitel ein eigener Chunk (< PER_CHUNK_LIMIT=56700). Grenzen skalieren aus
    // dem Test-Token-Budget in _helpers/setup.js — beide Seiten zusammen ändern.
    bodies[pid] = '<p>' + 'Anna ging weiter durch das Land. '.repeat(1215) + '</p>';
  }
  ctx.dbSeed.setBook({ chapters: cs, pages: ps, pageBodies: bodies });
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
      kapitel: [{ name: chapterName, haeufigkeit: 1 }], figuren_namen: ['Anna'],
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
        kapitel: [{ name: 'Kapitel 1', haeufigkeit: 3 }], figuren_namen: ['Anna'],
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
    { orte: [{ id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: '', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren_namen: ['Anna'] }] },
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
  const cur = ctx.dbSeed;
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
    3000: '<p>' + 'Anna ging weiter durch das Land. '.repeat(1215) + '</p>',
    3001: '<p>' + 'Anna ging weiter durch das Land. '.repeat(1215) + '</p>',
    3002: '<p>' + 'Anna ging weiter durch das Land. '.repeat(1215) + '</p>',
  };
  ctx.dbSeed.setBook({ chapters, pages, pageBodies: bodies });

  // Dieser Test isoliert die DELTA-CACHE-Granularität der Extraktion (nur der berührte Chunk
  // re-extrahiert). Der Mock liefert pro Kapitel deterministisch dieselbe Extraktion → der
  // re-extrahierte Katalog ist byte-identisch → der F5-Konsolidierungs-Checkpoint würde P2–P8
  // korrekt überspringen. Da hier NICHT F5, sondern die Extraktions-Granularität gemessen wird,
  // den Marker vor Run 2 löschen (entspricht dem realen Fall, dass sich Inhalt geändert hätte).
  ctx.dbSchema.deleteCheckpoint('komplett-consolidation', BOOK_ID, 'tester@test.dev');

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

test('Komplettanalyse Delta-Cache: Kapitel umbenannt → nur dessen Chunk re-extrahiert (Rename-Invalidation)', async () => {
  const BOOK_ID = 67;
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
    { orte: [{ id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: '', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren_namen: ['Anna'] }] },
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    kontinuitaetResponse(),
  );

  // Run 1: füllt den chapter_extract_cache für alle 3 Chunks.
  const jobId1 = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId1, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  await waitForJob(ctx.shared, jobId1, { timeoutMs: 10000 });
  const run1Calls = ctx.mockAi.log.length;
  assert.equal(run1Calls, 6, `run 1: expected 6 AI calls, got ${run1Calls}`);

  // Kapitel 2 UMBENENNEN — Seiten + updated_at unverändert. Einzige Änderung: chapter_name.
  const chapters = [
    { id: 2000, book_id: BOOK_ID, name: 'Kapitel 1' },
    { id: 2001, book_id: BOOK_ID, name: 'Kapitel 2 NEU' }, // renamed
    { id: 2002, book_id: BOOK_ID, name: 'Kapitel 3' },
  ];
  const pages = [
    { id: 3000, book_id: BOOK_ID, chapter_id: 2000, name: 'Seite 1', updated_at: '2026-01-01' },
    { id: 3001, book_id: BOOK_ID, chapter_id: 2001, name: 'Seite 2', updated_at: '2026-01-01' },
    { id: 3002, book_id: BOOK_ID, chapter_id: 2002, name: 'Seite 3', updated_at: '2026-01-01' },
  ];
  const body = '<p>' + 'Anna ging weiter durch das Land. '.repeat(1215) + '</p>';
  ctx.dbSeed.setBook({ chapters, pages, pageBodies: { 3000: body, 3001: body, 3002: body } });

  // Run 2: nur der Chunk des umbenannten Kapitels darf re-extrahieren (Kapitelname
  // im Chunk-pages_sig → MISS), die anderen zwei kommen aus dem Cache.
  const jobId2 = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId2, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  await waitForJob(ctx.shared, jobId2, { timeoutMs: 10000 });
  const run2Calls = ctx.mockAi.log.length - run1Calls;
  // 1 Chunk re-extract + P2 + P3 + P8 = 4 (ohne Rename-Invalidation wären es nur 3).
  assert.equal(run2Calls, 4, `rename-invalidation run: expected 4 AI calls, got ${run2Calls}`);
});

test('Komplettanalyse Checkpoint-Recovery: p1_full_done → überspringt Phase 1', async () => {
  const BOOK_ID = 62;
  seedMultiChapterBook(BOOK_ID, 3);

  // Pre-seed checkpoint as if Phase 1 ran successfully but job died before P2.
  // bookPagesSig MUSS dem entsprechen, was der Job aus dem aktuellen Seitenstand
  // berechnet — sonst verwirft die Staleness-Gate den Checkpoint und P1 läuft neu.
  const prompts = await ctx.shared.getPrompts();
  // cacheVersion-Format spiegelt job.js exakt:
  //   model:PROMPTS_VERSION:cp<completeness_passes>:esp<cap>:cf<coverageFeedback>:cac<auditChapters>:sb<sceneBackfill>:sbm<minChars>
  // (Der :esp…-Suffix nur für Claude.) beforeEach setzt completeness_passes=0 und
  // coverage_audit_chapters=0 → cf0/cac0; extract_single_pass_cap unset → esp0; scene_backfill
  // Default true → sb1, scene_backfill_min_chars Default 3000 → sbm3000.
  const _s = require('../../lib/app-settings');
  const completenessPasses = Math.max(0, Math.min(3, parseInt(_s.get('ai.komplett.completeness_passes'), 10) || 0));
  const extractCapChars = Math.max(0, parseInt(_s.get('ai.komplett.extract_single_pass_cap'), 10) || 0);
  const coverageAuditChapters = Math.max(0, Math.min(20, parseInt(_s.get('ai.komplett.coverage_audit_chapters'), 10) || 0));
  const coverageFeedbackEnabled = coverageAuditChapters > 0 && _s.get('ai.komplett.coverage_feedback') !== false;
  const sceneBackfillEnabled = _s.get('ai.komplett.scene_backfill') !== false;
  const sceneBackfillMinChars = Math.max(500, parseInt(_s.get('ai.komplett.scene_backfill_min_chars'), 10) || 3000);
  const singlePassAug = `:esp${extractCapChars}:cf${coverageFeedbackEnabled ? 1 : 0}:cac${coverageAuditChapters}:sb${sceneBackfillEnabled ? 1 : 0}:sbm${sceneBackfillMinChars}`;
  const cacheVersion = `${ctx.shared._modelName('claude')}:${prompts.PROMPTS_VERSION || ''}:cp${completenessPasses}${singlePassAug}`;
  const pageMeta = [
    { id: 3000, updated_at: '2026-01-01', chapter_id: 2000, chapter: 'Kapitel 1' },
    { id: 3001, updated_at: '2026-01-01', chapter_id: 2001, chapter: 'Kapitel 2' },
    { id: 3002, updated_at: '2026-01-01', chapter_id: 2002, chapter: 'Kapitel 3' },
  ];
  const bookPagesSig = buildBookPagesSig(pageMeta, ctx.dbSchema.getBookSettings(BOOK_ID, 'tester@test.dev'), cacheVersion);
  ctx.dbSchema.saveCheckpoint('komplett-analyse', BOOK_ID, 'tester@test.dev', {
    phase: 'p1_full_done',
    bookPagesSig,
    chapterFiguren: [
      { kapitel: 'Kapitel 1', figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] }] },
      { kapitel: 'Kapitel 2', figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', kapitel: [{ name: 'Kapitel 2', haeufigkeit: 1 }], beziehungen: [] }] },
      { kapitel: 'Kapitel 3', figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', kapitel: [{ name: 'Kapitel 3', haeufigkeit: 1 }], beziehungen: [] }] },
    ],
    chapterOrte: [
      { kapitel: 'Kapitel 1', orte: [{ id: 'ort_land', name: 'Land', typ: 'natur', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren_namen: ['Anna'] }] },
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
    { orte: [{ id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: '', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren_namen: ['Anna'] }] },
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
    { orte: [{ id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: '', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren_namen: ['Anna'] }] },
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
    (e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'),
    figurenStammResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'),
    ortePassResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'),
    faktenPassResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'),
    eventsPassResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'),
    beziehungenResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    kontinuitaetResponse(),
  );

  // Run 1: populates cache (A1 + B + C + E + A2 + P8 = 6 calls; Completeness aus).
  const jobId1 = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId1, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  await waitForJob(ctx.shared, jobId1, { timeoutMs: 8000 });
  assert.equal(ctx.mockAi.log.length, 6, 'run 1: 6 AI calls (A1+B+C+E+A2+P8)');

  // Run 2: same book. Phase-1-Delta-Cache HIT → identischer Katalog → identische
  // Konsolidierungs-Sig → F5-Konsolidierungs-Checkpoint HIT → P2–P8 (inkl. P8) komplett
  // übersprungen. Erwartung daher 0 KI-Calls (unter dem Vor-F5-Design war es 1 = nur P8).
  const callsBeforeRun2 = ctx.mockAi.log.length;
  const jobId2 = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId2, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job2 = await waitForJob(ctx.shared, jobId2, { timeoutMs: 8000 });
  assert.equal(job2.status, 'done');
  assert.equal(job2.result?.consolidationSkipped, true, 'run 2 should short-circuit via consolidation checkpoint');
  const run2Calls = ctx.mockAi.log.length - callsBeforeRun2;
  assert.equal(run2Calls, 0, `cache-hit + consolidation-checkpoint run: expected 0 AI calls, got ${run2Calls}`);
});

// ── Konsolidierungs-Phasen (Multi-Pass): P2 Soziogramm, P3 Orte, P6 Zeitstrahl ──
// Diese Phasen liefen in den Pass-Mode-Tests oben nur mit, ohne Assertion auf ihren
// spezifischen Output. Hier wird gezielt der jeweilige Konsolidierungs-Call ausgelöst
// und geprüft, dass dessen Resultat (nicht der rohe P1-Extrakt) persistiert wird.

// Matcher-Helpers (schemaKeys aus dem jeweiligen Konsolidierungs-Schema).
const isP1Extract  = (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('orte') && e.schemaKeys.includes('assignments');
const isFigKonsol  = (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('figuren');
const isSoziogramm = (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('beziehungen');
const isOrteKonsol = (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('orte');
const isSongsKonsol = (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('songs');
const isBeziehung  = (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen');
const isZeitstrahl = (e) => e.schemaKeys.includes('ereignisse');
const isKontinuitaet = (e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme');

function figKonsolResponse(figuren) {
  return { figuren };
}

test('Komplettanalyse Phase 2 Soziogramm: >=4 Figuren → Refine-Call überschreibt sozialschicht + machtverhaltnis', async () => {
  const BOOK_ID = 70;
  seedMultiChapterBook(BOOK_ID, 3); // 3 Chunks → Multi-Pass → Soziogramm-Refine aktiv

  ctx.mockAi.on(isP1Extract, ({ prompt }) => {
    const m = prompt.match(/Kapitel \d+/);
    return extraktionResponseFor(m ? m[0] : 'Kapitel');
  });

  // Phase 2 Konsolidierung: 4 Figuren (>=4 triggert Soziogramm-Block).
  // fig_1 → fig_2 mit preliminary machtverhaltnis=1 (truthy → in prelimPairs).
  ctx.mockAi.on(isSoziogramm, {
    // Refine: sozialschicht-Override für fig_1 + verfeinerte Machtbeziehung fig_1→fig_2.
    figuren: [{ id: 'fig_1', sozialschicht: 'oben' }],
    beziehungen: [{ from_fig_id: 'fig_1', to_fig_id: 'fig_2', machtverhaltnis: 5 }],
  });
  ctx.mockAi.on(isFigKonsol, figKonsolResponse([
    {
      id: 'fig_1', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral',
      sozialschicht: 'mitte', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }],
      beziehungen: [{ figur_id: 'fig_2', typ: 'freund', machtverhaltnis: 1, beschreibung: 'reisen', belege: [] }],
    },
    { id: 'fig_2', name: 'Bert', kurzname: 'Bert', typ: 'nebenfigur', praesenz: 'regelmaessig', sozialschicht: 'mitte', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] },
    { id: 'fig_3', name: 'Cara', kurzname: 'Cara', typ: 'nebenfigur', praesenz: 'punktuell', sozialschicht: 'unten', kapitel: [{ name: 'Kapitel 2', haeufigkeit: 1 }], beziehungen: [] },
    { id: 'fig_4', name: 'Dora', kurzname: 'Dora', typ: 'nebenfigur', praesenz: 'punktuell', sozialschicht: 'unten', kapitel: [{ name: 'Kapitel 3', haeufigkeit: 1 }], beziehungen: [] },
  ]));
  ctx.mockAi.on(isOrteKonsol, { orte: [{ id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: 'weit', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 3 }], figuren_namen: ['Anna'] }] });
  ctx.mockAi.on(isBeziehung, { beziehungen: [] }); // Phase 3b: keine kapitelübergreifenden
  ctx.mockAi.on(isKontinuitaet, kontinuitaetResponse());

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.passMode, 'multi');
  assert.equal(job.result.figCount, 4);

  // Soziogramm-Refine-Call ist gelaufen.
  assert.equal(ctx.mockAi.log.filter(isSoziogramm).length, 1, 'expected exactly 1 Soziogramm-Refine call');

  // sozialschicht von fig_1 stammt aus dem Refine-Call ('oben'), nicht aus P2 ('mitte').
  const f1 = ctx.dbSchema.db.prepare(
    `SELECT sozialschicht FROM figures WHERE book_id = ? AND fig_id = 'fig_1' AND user_email = ?`
  ).get(BOOK_ID, 'tester@test.dev');
  assert.equal(f1.sozialschicht, 'oben', 'fig_1 sozialschicht should be refined value');

  // machtverhaltnis der Beziehung fig_1→fig_2 stammt aus dem Refine-Call (5), nicht aus P2 (1).
  const rel = ctx.dbSchema.db.prepare(
    `SELECT r.machtverhaltnis FROM figure_relations r
       JOIN figures ff ON ff.id = r.from_fig_id
       JOIN figures ft ON ft.id = r.to_fig_id
      WHERE r.book_id = ? AND ff.fig_id = 'fig_1' AND ft.fig_id = 'fig_2'`
  ).get(BOOK_ID);
  assert.ok(rel, 'relation fig_1→fig_2 should exist');
  assert.equal(rel.machtverhaltnis, 5, 'machtverhaltnis should be refined value');
});

test('Komplettanalyse Phase 3 Orte-Konsolidierung: Konsol-Output dedupliziert die Kapitel-Orte', async () => {
  const BOOK_ID = 71;
  seedMultiChapterBook(BOOK_ID, 3); // Multi-Pass → echter Orte-Konsol-Call

  // P1 liefert pro Chunk denselben Ort-Namen «Land» + zusätzlich «Berg» – also
  // chapterübergreifende Duplikate, die die Konsolidierung zusammenführen muss.
  ctx.mockAi.on(isP1Extract, ({ prompt }) => {
    const m = prompt.match(/Kapitel \d+/);
    const chap = m ? m[0] : 'Kapitel';
    return {
      figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: chap, haeufigkeit: 1 }], beziehungen: [] }],
      orte: [
        { id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: 'weit', kapitel: [{ name: chap, haeufigkeit: 1 }], figuren_namen: ['Anna'] },
        { id: 'ort_berg', name: 'Berg', typ: 'natur', beschreibung: 'hoch', kapitel: [{ name: chap, haeufigkeit: 1 }], figuren_namen: [] },
      ],
      fakten: [], songs: [],
      szenen: [{ seite: 'Seite', kapitel: chap, titel: 'Anna unterwegs', wertung: 'mittel', kommentar: 'k', figuren_namen: ['Anna'], orte_namen: ['Land'] }],
      assignments: [{ figur_name: 'Anna', lebensereignisse: [] }],
    };
  });
  ctx.mockAi.on(isFigKonsol, figKonsolResponse([
    { id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] },
  ]));
  // Konsolidierung führt die 6 Kapitel-Vorkommen (3×Land + 3×Berg) auf 2 Orte zusammen.
  ctx.mockAi.on(isOrteKonsol, {
    orte: [
      { id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: 'weit', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 3 }], figuren_namen: ['Anna'] },
      { id: 'ort_berg', name: 'Berg', typ: 'natur', beschreibung: 'hoch', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 3 }], figuren_namen: ['Anna'] },
    ],
  });
  ctx.mockAi.on(isBeziehung, { beziehungen: [] });
  ctx.mockAi.on(isKontinuitaet, kontinuitaetResponse());

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  // Genau 1 Orte-Konsol-Call.
  assert.equal(ctx.mockAi.log.filter(isOrteKonsol).length, 1, 'expected exactly 1 Orte-Konsol call');

  // DB hält die konsolidierten 2 Orte (Konsol-Output), nicht die 6 rohen Kapitel-Vorkommen.
  const orte = ctx.dbSchema.db.prepare(
    'SELECT name FROM locations WHERE book_id = ? AND user_email = ? ORDER BY name'
  ).all(BOOK_ID, 'tester@test.dev');
  assert.deepEqual(orte.map(o => o.name), ['Berg', 'Land']);
  assert.equal(job.result.orteCount, 2);
});

test('Komplettanalyse Phase 3 Orte-Konsolidierung trunkiert → Job ok, Warnung, Fallback auf Kapitel-Orte', async () => {
  const BOOK_ID = 711;
  seedMultiChapterBook(BOOK_ID, 3); // Multi-Pass → echter Orte-Konsol-Call

  ctx.mockAi.on(isP1Extract, ({ prompt }) => {
    const m = prompt.match(/Kapitel \d+/);
    const chap = m ? m[0] : 'Kapitel';
    return {
      figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: chap, haeufigkeit: 1 }], beziehungen: [] }],
      orte: [
        { id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: 'weit', kapitel: [{ name: chap, haeufigkeit: 1 }], figuren_namen: ['Anna'] },
        { id: 'ort_berg', name: 'Berg', typ: 'natur', beschreibung: 'hoch', kapitel: [{ name: chap, haeufigkeit: 1 }], figuren_namen: [] },
      ],
      fakten: [], songs: [],
      szenen: [{ seite: 'Seite', kapitel: chap, titel: 'Anna unterwegs', wertung: 'mittel', kommentar: 'k', figuren_namen: ['Anna'], orte_namen: ['Land'] }],
      assignments: [{ figur_name: 'Anna', lebensereignisse: [] }],
    };
  });
  ctx.mockAi.on(isFigKonsol, figKonsolResponse([
    { id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] },
  ]));
  // Orte-Konsolidierung dreht durch (lokales Modell, Wiederholungsschleife) → truncated.
  // Der Job darf NICHT scheitern: Figuren/Fakten sind längst gespeichert, die Orte sind
  // kapitelweise extrahiert → regelbasierter Fallback-Merge.
  ctx.mockAi.on(isOrteKonsol, { truncated: true, text: '{"orte":[' });
  ctx.mockAi.on(isBeziehung, { beziehungen: [] });
  ctx.mockAi.on(isKontinuitaet, kontinuitaetResponse());

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done (graceful fallback), got ${job.status}: ${job.error || ''}`);

  assert.ok((job.result.warnings || []).some(w => w.key === 'job.warn.orteKonsolidierungDegraded'),
    `expected orteKonsolidierungDegraded warning, got ${JSON.stringify(job.result.warnings)}`);

  // Fallback dedupliziert die Kapitel-Orte (3×Land + 3×Berg) regelbasiert auf 2.
  const orte = ctx.dbSchema.db.prepare(
    'SELECT name FROM locations WHERE book_id = ? AND user_email = ? ORDER BY name'
  ).all(BOOK_ID, 'tester@test.dev');
  assert.deepEqual(orte.map(o => o.name), ['Berg', 'Land']);
  assert.equal(job.result.orteCount, 2);
});

test('Komplettanalyse Phase 3 Orte-Fallback: kapitelweise wiederverwendete loc_ids kollidieren nicht (UNIQUE)', async () => {
  const BOOK_ID = 712;
  seedMultiChapterBook(BOOK_ID, 3); // Multi-Pass → echter Orte-Konsol-Call

  // Jedes Kapitel vergibt seine loc_ids pro Kapitel NEU (ort_1, ort_2) — aber für
  // verschiedene Namen. Nach dem Flatten im Fallback tragen also verschiedene Orte
  // dieselbe loc_id. Vor dem Fix → UNIQUE(book_id, loc_id, user_email)-Crash.
  const perChapterOrte = {
    1: [{ id: 'ort_1', name: 'Berg' }, { id: 'ort_2', name: 'Wald' }],
    2: [{ id: 'ort_1', name: 'See' }, { id: 'ort_2', name: 'Fluss' }],
    3: [{ id: 'ort_1', name: 'Stadt' }, { id: 'ort_2', name: 'Dorf' }],
  };
  ctx.mockAi.on(isP1Extract, ({ prompt }) => {
    const m = prompt.match(/Kapitel (\d+)/);
    const num = m ? Number(m[1]) : 1;
    const chap = m ? m[0] : 'Kapitel';
    return {
      figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: chap, haeufigkeit: 1 }], beziehungen: [] }],
      orte: (perChapterOrte[num] || []).map(o => ({ ...o, typ: 'natur', beschreibung: 'x', kapitel: [{ name: chap, haeufigkeit: 1 }], figuren_namen: [] })),
      fakten: [], songs: [],
      szenen: [], assignments: [{ figur_name: 'Anna', lebensereignisse: [] }],
    };
  });
  ctx.mockAi.on(isFigKonsol, figKonsolResponse([
    { id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] },
  ]));
  ctx.mockAi.on(isOrteKonsol, { truncated: true, text: '{"orte":[' }); // erzwingt Fallback
  ctx.mockAi.on(isBeziehung, { beziehungen: [] });
  ctx.mockAi.on(isKontinuitaet, kontinuitaetResponse());

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done (kein UNIQUE-Crash), got ${job.status}: ${job.error || ''}`);

  const orte = ctx.dbSchema.db.prepare(
    'SELECT name, loc_id FROM locations WHERE book_id = ? AND user_email = ? ORDER BY name'
  ).all(BOOK_ID, 'tester@test.dev');
  assert.deepEqual(orte.map(o => o.name), ['Berg', 'Dorf', 'Fluss', 'See', 'Stadt', 'Wald']);
  // loc_ids müssen über alle Orte eindeutig sein.
  assert.equal(new Set(orte.map(o => o.loc_id)).size, orte.length, 'loc_ids nicht eindeutig');
});

test('Komplettanalyse Phase 3 Songs-Konsolidierung trunkiert → Job ok, Fallback, song_uid kollidiert nicht', async () => {
  const BOOK_ID = 713;
  seedMultiChapterBook(BOOK_ID, 3);

  // Jedes Kapitel vergibt seine song-uids pro Kapitel neu (song_1, song_2) für
  // verschiedene Titel → nach Flatten im Fallback Kollisionsgefahr auf UNIQUE(song_uid).
  const perChapterSongs = {
    1: [{ id: 'song_1', titel: 'Lied A' }, { id: 'song_2', titel: 'Lied B' }],
    2: [{ id: 'song_1', titel: 'Lied C' }, { id: 'song_2', titel: 'Lied D' }],
    3: [{ id: 'song_1', titel: 'Lied E' }],
  };
  ctx.mockAi.on(isP1Extract, ({ prompt }) => {
    const m = prompt.match(/Kapitel (\d+)/);
    const num = m ? Number(m[1]) : 1;
    const chap = m ? m[0] : 'Kapitel';
    return {
      figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: chap, haeufigkeit: 1 }], beziehungen: [] }],
      orte: [{ id: 'ort_1', name: 'Berg', typ: 'natur', beschreibung: 'x', kapitel: [{ name: chap, haeufigkeit: 1 }], figuren_namen: [] }],
      songs: (perChapterSongs[num] || []).map(s => ({ ...s, interpret: 'X', beschreibung: 'b', kapitel: [{ name: chap, haeufigkeit: 1 }], figuren_namen: [] })),
      fakten: [], szenen: [], assignments: [{ figur_name: 'Anna', lebensereignisse: [] }],
    };
  });
  ctx.mockAi.on(isFigKonsol, figKonsolResponse([
    { id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] },
  ]));
  ctx.mockAi.on(isOrteKonsol, { orte: [{ id: 'ort_1', name: 'Berg', typ: 'natur', figuren_namen: [] }] });
  ctx.mockAi.on(isSongsKonsol, { truncated: true, text: '{"songs":[' }); // erzwingt Fallback
  ctx.mockAi.on(isBeziehung, { beziehungen: [] });
  ctx.mockAi.on(isKontinuitaet, kontinuitaetResponse());

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done (graceful fallback, kein UNIQUE-Crash), got ${job.status}: ${job.error || ''}`);
  assert.ok((job.result.warnings || []).some(w => w.key === 'job.warn.songsKonsolidierungDegraded'),
    `expected songsKonsolidierungDegraded warning, got ${JSON.stringify(job.result.warnings)}`);

  const songs = ctx.dbSchema.db.prepare(
    'SELECT titel, song_uid FROM songs WHERE book_id = ? AND user_email = ? ORDER BY titel'
  ).all(BOOK_ID, 'tester@test.dev');
  assert.deepEqual(songs.map(s => s.titel), ['Lied A', 'Lied B', 'Lied C', 'Lied D', 'Lied E']);
  assert.equal(new Set(songs.map(s => s.song_uid)).size, songs.length, 'song_uids nicht eindeutig');
});

test('Komplettanalyse Songs: figuren_namen wird gegen kanonische Figur aufgelöst, unbekannter Name verworfen', async () => {
  const BOOK_ID = 714;
  seedMultiChapterBook(BOOK_ID, 3);

  ctx.mockAi.on(isP1Extract, ({ prompt }) => {
    const m = prompt.match(/Kapitel (\d+)/);
    const chap = m ? m[0] : 'Kapitel';
    return {
      figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: chap, haeufigkeit: 1 }], beziehungen: [] }],
      orte: [],
      // Song referenziert Figuren über Klarnamen (nicht fig_id). Der Extraktions-Pass
      // kennt A1s ID-Namespace nicht → Namen sind die einzige robuste Referenz.
      songs: [{ id: 'song_1', titel: 'Bambule', interpret: 'Absolute Beginner', genre: 'Hip-Hop', kontext_typ: 'hört', beschreibung: 'b', kapitel: [{ name: chap, haeufigkeit: 1 }], figuren_namen: ['Anna', 'Unbekannt Xyz'] }],
      fakten: [], szenen: [], assignments: [{ figur_name: 'Anna', lebensereignisse: [] }],
    };
  });
  ctx.mockAi.on(isFigKonsol, figKonsolResponse([
    { id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] },
  ]));
  ctx.mockAi.on(isOrteKonsol, { orte: [] });
  // Konsolidierung gibt den Song mit Klarnamen zurück (inkl. eines nicht auflösbaren Namens).
  ctx.mockAi.on(isSongsKonsol, { songs: [{ id: 'song_1', titel: 'Bambule', interpret: 'Absolute Beginner', genre: 'Hip-Hop', kontext_typ: 'hört', beschreibung: 'b', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren_namen: ['anna', 'Unbekannt Xyz'] }] });
  ctx.mockAi.on(isBeziehung, { beziehungen: [] });
  ctx.mockAi.on(isKontinuitaet, kontinuitaetResponse());

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  // Der Song ist über die song_figures-Bridge mit der KANONISCHEN Figur Anna verknüpft
  // (Auflösung über den Namen, lowercase-Fallback greift bei 'anna'); der unbekannte
  // Name 'Unbekannt Xyz' wird verworfen statt als Phantom-Link gespeichert.
  const linkedFiguren = ctx.dbSchema.db.prepare(`
    SELECT f.name FROM song_figures sf
    JOIN songs s ON s.id = sf.song_id
    JOIN figures f ON f.id = sf.figure_id
    WHERE s.book_id = ? AND s.user_email = ?
    ORDER BY f.name
  `).all(BOOK_ID, 'tester@test.dev');
  assert.deepEqual(linkedFiguren.map(r => r.name), ['Anna'],
    `Song sollte genau mit Anna verknüpft sein, got ${JSON.stringify(linkedFiguren)}`);
});

test('Komplettanalyse Orte: figuren_namen wird gegen kanonische Figur aufgelöst, unbekannter Name verworfen', async () => {
  const BOOK_ID = 715;
  seedMultiChapterBook(BOOK_ID, 3);

  ctx.mockAi.on(isP1Extract, ({ prompt }) => {
    const m = prompt.match(/Kapitel (\d+)/);
    const chap = m ? m[0] : 'Kapitel';
    return {
      figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: chap, haeufigkeit: 1 }], beziehungen: [] }],
      // Ort referenziert Figuren über Klarnamen (nicht fig_id) – wie Songs/Szenen.
      orte: [{ id: 'ort_1', name: 'Berg', typ: 'natur', beschreibung: 'hoch', kapitel: [{ name: chap, haeufigkeit: 1 }], figuren_namen: ['Anna', 'Unbekannt Xyz'] }],
      songs: [], fakten: [], szenen: [], assignments: [{ figur_name: 'Anna', lebensereignisse: [] }],
    };
  });
  ctx.mockAi.on(isFigKonsol, figKonsolResponse([
    { id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] },
  ]));
  // Orte-Konsolidierung gibt den Ort mit Klarnamen zurück (inkl. eines nicht auflösbaren Namens).
  ctx.mockAi.on(isOrteKonsol, { orte: [{ id: 'ort_1', name: 'Berg', typ: 'natur', beschreibung: 'hoch', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren_namen: ['anna', 'Unbekannt Xyz'] }] });
  ctx.mockAi.on(isBeziehung, { beziehungen: [] });
  ctx.mockAi.on(isKontinuitaet, kontinuitaetResponse());

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  // Ort ist über location_figures mit der kanonischen Figur Anna verknüpft (Name-Auflösung
  // inkl. lowercase-Fallback bei 'anna'); der unbekannte Name wird verworfen.
  const linkedFiguren = ctx.dbSchema.db.prepare(`
    SELECT f.name FROM location_figures lf
    JOIN locations l ON l.id = lf.location_id
    JOIN figures f ON f.id = lf.figure_id
    WHERE l.book_id = ? AND l.user_email = ?
    ORDER BY f.name
  `).all(BOOK_ID, 'tester@test.dev');
  assert.deepEqual(linkedFiguren.map(r => r.name), ['Anna'],
    `Ort sollte genau mit Anna verknüpft sein, got ${JSON.stringify(linkedFiguren)}`);
});

// Baut N Lebensereignisse für eine Figur (distinct datum+ereignis → N Gruppen in P6).
function lebensereignisse(n) {
  return Array.from({ length: n }, (_, i) => ({
    datum: String(2020 + i), datum_label: String(2020 + i), datum_year: 2020 + i,
    subtyp: 'wendepunkt', ereignis: `Ereignis ${i + 1}`, typ: 'persoenlich',
    bedeutung: 'wichtig', kapitel: 'Kapitel 1', seite: 'Seite 1',
  }));
}

function zeitstrahlSeedHandlers(eventCount) {
  // Nur Chunk «Kapitel 1» liefert Events; übrige Chunks leer → keine Doppelung.
  ctx.mockAi.on(isP1Extract, ({ prompt }) => {
    const m = prompt.match(/Kapitel \d+/);
    const chap = m ? m[0] : 'Kapitel';
    return {
      figuren: [{ id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: chap, haeufigkeit: 1 }], beziehungen: [] }],
      orte: [{ id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: 'weit', kapitel: [{ name: chap, haeufigkeit: 1 }], figuren_namen: ['Anna'] }],
      fakten: [], songs: [],
      szenen: [{ seite: 'Seite', kapitel: chap, titel: 'Anna unterwegs', wertung: 'mittel', kommentar: 'k', figuren_namen: ['Anna'], orte_namen: ['Land'] }],
      assignments: [{ figur_name: 'Anna', lebensereignisse: chap === 'Kapitel 1' ? lebensereignisse(eventCount) : [] }],
    };
  });
  ctx.mockAi.on(isFigKonsol, figKonsolResponse([
    { id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', praesenz: 'zentral', sozialschicht: 'mitte', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], beziehungen: [] },
  ]));
  ctx.mockAi.on(isOrteKonsol, { orte: [{ id: 'ort_land', name: 'Land', typ: 'natur', beschreibung: 'weit', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 3 }], figuren_namen: ['Anna'] }] });
  ctx.mockAi.on(isBeziehung, { beziehungen: [] });
  ctx.mockAi.on(isKontinuitaet, kontinuitaetResponse());
}

test('Komplettanalyse Phase 6 Zeitstrahl >=5 Events: Konsol-Call läuft, persistiert dessen Output', async () => {
  const BOOK_ID = 72;
  seedMultiChapterBook(BOOK_ID, 3);
  zeitstrahlSeedHandlers(6); // 6 distinct Events → >=5 → KI-Konsolidierung

  // Konsolidierung fasst die 6 Events auf 3 kanonische zusammen.
  ctx.mockAi.on(isZeitstrahl, {
    ereignisse: [
      { datum: '2020', datum_label: '2020', datum_year: 2020, subtyp: 'wendepunkt', ereignis: 'A', typ: 'persoenlich', bedeutung: '', kapitel: ['Kapitel 1'], seiten: [], figuren: [{ id: 'fig_anna', name: 'Anna', typ: 'protagonist' }] },
      { datum: '2022', datum_label: '2022', datum_year: 2022, subtyp: 'wendepunkt', ereignis: 'B', typ: 'persoenlich', bedeutung: '', kapitel: ['Kapitel 1'], seiten: [], figuren: [{ id: 'fig_anna', name: 'Anna', typ: 'protagonist' }] },
      { datum: '2024', datum_label: '2024', datum_year: 2024, subtyp: 'wendepunkt', ereignis: 'C', typ: 'persoenlich', bedeutung: '', kapitel: ['Kapitel 1'], seiten: [], figuren: [{ id: 'fig_anna', name: 'Anna', typ: 'protagonist' }] },
    ],
  });

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  // Zeitstrahl-Konsolidierung lief (>=5 Events).
  assert.equal(ctx.mockAi.log.filter(isZeitstrahl).length, 1, 'expected exactly 1 Zeitstrahl-Konsol call');

  // DB hält die 3 konsolidierten Events (Konsol-Output), nicht die 6 rohen.
  const rows = ctx.dbSchema.db.prepare(
    'SELECT COUNT(*) AS n FROM zeitstrahl_events WHERE book_id = ? AND user_email = ?'
  ).get(BOOK_ID, 'tester@test.dev');
  assert.equal(rows.n, 3, 'expected 3 consolidated timeline events');
});

test('Komplettanalyse Phase 6 Zeitstrahl <5 Events: Direkt-Speichern ohne KI-Call', async () => {
  const BOOK_ID = 73;
  seedMultiChapterBook(BOOK_ID, 3);
  zeitstrahlSeedHandlers(3); // 3 Events → unter Schwelle → kein Konsol-Call

  // Bewusst KEIN isZeitstrahl-Handler: ein Call würde mit "no handler matched" werfen.
  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  // Kein Zeitstrahl-Konsol-Call.
  assert.equal(ctx.mockAi.log.filter(isZeitstrahl).length, 0, 'expected no Zeitstrahl-Konsol call under threshold');

  // Die 3 Events wurden direkt (aus figure_events gegroupt) gespeichert.
  const rows = ctx.dbSchema.db.prepare(
    'SELECT COUNT(*) AS n FROM zeitstrahl_events WHERE book_id = ? AND user_email = ?'
  ).get(BOOK_ID, 'tester@test.dev');
  assert.equal(rows.n, 3, 'expected 3 directly-saved timeline events');
});

// ── F2: Coverage-Self-Audit ──────────────────────────────────────────────────
test('Komplettanalyse F2: Coverage-Self-Audit schreibt Score + fehlende Namen ins Job-Result', async () => {
  const BOOK_ID = 90;
  seedTinyBook(BOOK_ID);
  const appSettings = require('../../lib/app-settings');
  appSettings.set('ai.komplett.coverage_audit_chapters', 1); // beforeEach setzt 0 → hier gezielt an

  ctx.mockAi.on((e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'), figurenStammResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'), ortePassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'), faktenPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'), eventsPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'), beziehungenResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'), kontinuitaetResponse());
  // Coverage-Audit-Call (SCHEMA_COVERAGE_AUDIT).
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('erkannte_figuren') && e.schemaKeys.includes('fehlende_figuren'),
    { erkannte_figuren: 3, fehlende_figuren: ['Uebersehene Figur'], erkannte_orte: 1, fehlende_orte: [] },
  );

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
  assert.equal(job.status, 'done');
  assert.ok(job.result.coverage, 'coverage im Job-Result');
  // Score = erkannt/(erkannt+fehlend) = 4/5 = 0.8.
  assert.equal(job.result.coverage.score, 0.8);
  assert.deepEqual(job.result.coverage.missingFiguren, ['Uebersehene Figur']);
  assert.equal(job.result.coverage.sampledChapters, 1);
});

// ── F4: Attribut-Widerspruchs-Detektor (deterministische Kandidaten aus figure_events) ──
// Lässt einen echten Single-Pass-Job zwei widersprüchliche Geburts-Events für Anna persistieren
// (valide FK-Kette via Pipeline), dann prüft der Detektor den Jahres-Konflikt.
test('Komplettanalyse F4: buildAttributeContradictions findet Jahres-Konflikt eines singulären Events', async () => {
  const BOOK_ID = 91;
  const email = 'tester@test.dev';
  seedTinyBook(BOOK_ID);

  ctx.mockAi.on((e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'), figurenStammResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'), ortePassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'), faktenPassResponse());
  // E: zwei widersprüchliche Geburts-Events (verschiedene Jahre) für Anna.
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'), {
    assignments: [{ figur_name: 'Anna', lebensereignisse: [
      { subtyp: 'geburt', datum: '1970', datum_year: 1970, datum_unsicher: false, typ: 'persoenlich', ereignis: 'Anna wird 1970 geboren', kapitel: 'Kapitel Eins' },
      { subtyp: 'geburt', datum: '1975', datum_year: 1975, datum_unsicher: false, typ: 'persoenlich', ereignis: 'Rueckblick: Annas Geburt 1975', kapitel: 'Kapitel Eins' },
    ] }],
  });
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'), beziehungenResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'), kontinuitaetResponse());

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, email, 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', email, { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
  assert.equal(job.status, 'done');

  const { buildAttributeContradictions } = require('../../routes/jobs/komplett/job-shared.js');
  const cands = buildAttributeContradictions(BOOK_ID, email);
  const geburt = cands.find(c => c.entity === 'Anna' && c.attribut === 'Geburtsjahr');
  assert.ok(geburt, 'Geburtsjahr-Konflikt als Kandidat erkannt');
  assert.equal(geburt.typ, 'zeitlinie');
  assert.deepEqual([geburt.wertA.wert, geburt.wertB.wert].sort(), ['1970', '1975']);
});

// ── #4: E/A2-Batching ─────────────────────────────────────────────────────────
// figure_batch_size=1 zwingt Anna + Bert in getrennte E- und A2-Batches. Erwartet:
// A1 + B + C + 2×E + 2×A2 + P8 = 8 Calls; Katalog unverändert (Beziehung dedupliziert).
test('Komplettanalyse #4: figure_batch_size=1 → E + A2 batchen, Katalog korrekt', async () => {
  const BOOK_ID = 120;
  seedTinyBook(BOOK_ID);
  const appSettings = require('../../lib/app-settings');
  appSettings.set('ai.komplett.figure_batch_size', 1);

  ctx.mockAi.on((e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'), figurenStammResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'), ortePassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'), faktenPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'), eventsPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'), beziehungenResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'), kontinuitaetResponse());

  try {
    const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
    ctx.shared.enqueueJob(jobId, () =>
      ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'));
    const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
    assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
    assert.equal(job.result.figCount, 2);
    // A1 + B + C + E(Anna) + E(Bert) + A2(Anna-Scope) + A2(Bert-Scope) + P8 = 8.
    assert.equal(ctx.mockAi.log.length, 8, `expected 8 AI calls (batched E+A2), got ${ctx.mockAi.log.length}`);
    // Beziehung trotz doppelter Emission (beide A2-Batches) via Paar-Dedup nur EINMAL.
    const relRows = ctx.dbSchema.db.prepare('SELECT COUNT(*) AS n FROM figure_relations WHERE book_id = ?').get(BOOK_ID);
    assert.equal(relRows.n, 1, `expected 1 deduped relation, got ${relRows.n}`);
  } finally {
    appSettings.set('ai.komplett.figure_batch_size', 20);
  }
});

// ── #8: Remap-Rescue ──────────────────────────────────────────────────────────
// Eine Szene referenziert «Annie» (Spitzname, nicht im Katalog). Ohne Rescue würde die
// Figuren-Verknüpfung gedroppt; der Namensauflösungs-Call mappt «Annie» → «Anna».
test('Komplettanalyse #8: Remap-Rescue ordnet unauflösbaren Szenen-Namen dem Katalog zu', async () => {
  const BOOK_ID = 121;
  const email = 'tester@test.dev';
  seedTinyBook(BOOK_ID);

  ctx.mockAi.on((e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'), figurenStammResponse());
  // B liefert eine Szene, deren figuren_namen den unauflösbaren Spitznamen «Annie» trägt.
  ctx.mockAi.on((e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'), {
    orte: [{ id: 'ort_1', name: 'Wald', typ: 'natur', beschreibung: 'kalt', kapitel: [{ name: 'Kapitel Eins', haeufigkeit: 1 }], figuren_namen: [] }],
    songs: [],
    szenen: [{ seite: 'Seite Eins', kapitel: 'Kapitel Eins', titel: 'Annie im Wald', wertung: 'mittel', kommentar: 'k', figuren_namen: ['Annie'], orte_namen: ['Wald'] }],
  });
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'), faktenPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'), eventsPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'), beziehungenResponse());
  // Namensauflösung: «Annie» → «Anna».
  ctx.mockAi.on((e) => e.schemaKeys.includes('zuordnungen'), { zuordnungen: [{ name: 'Annie', treffer: 'Anna' }] });
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'), kontinuitaetResponse());

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, email, 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', email, { id: 'tok', pw: 'pw' }, 'claude'));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  // Die Szene ist mit Anna verknüpft (via gerettetem «Annie» → «Anna»), nicht leer.
  const link = ctx.dbSchema.db.prepare(`
    SELECT f.name AS fig FROM scene_figures sf
      JOIN figure_scenes s ON s.id = sf.scene_id
      JOIN figures f ON f.id = sf.figure_id
     WHERE s.book_id = ?
  `).all(BOOK_ID);
  assert.ok(link.some(r => r.fig === 'Anna'), `Szene sollte mit Anna verknüpft sein (Rescue), got ${JSON.stringify(link)}`);
});

// ── #3: Szenen-Backfill ───────────────────────────────────────────────────────
// Ein Kapitel mit substanziellem Text, für das die Extraktion 0 Szenen lieferte, bekommt
// einen gezielten Szenen-Nachzieh-Call.
test('Komplettanalyse #3: Szenen-Backfill ergänzt Szenen für ein szenenloses Kapitel', async () => {
  const BOOK_ID = 122;
  const email = 'tester@test.dev';
  // ~6000 Zeichen (> scene_backfill_min_chars=3000), Single-Pass (< SINGLE_PASS_LIMIT).
  ctx.dbSeed.setBook({
    chapters: [{ id: 1300, book_id: BOOK_ID, name: 'Kapitel Eins' }],
    pages: [{ id: 1400, book_id: BOOK_ID, chapter_id: 1300, name: 'Seite Eins', updated_at: '2026-01-01' }],
    pageBodies: { 1400: '<p>' + 'Anna ging durch den weiten dunklen Wald. '.repeat(150) + '</p>' },
  });

  // Ziel-Szenen-Call ZUERST (first-match): erkennbar am Prompt-Marker + szenen-Schema.
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('szenen') && e.prompt.includes('kapitel_ohne_szenen'),
    { orte: [], songs: [], szenen: [{ seite: 'Seite Eins', kapitel: 'Kapitel Eins', titel: 'Nachgezogene Szene', wertung: 'mittel', kommentar: 'k', figuren_namen: ['Anna'], orte_namen: [] }] },
  );
  ctx.mockAi.on((e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'), figurenStammResponse());
  // B liefert KEINE Szene (szenen leer) → Backfill greift.
  ctx.mockAi.on((e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'), {
    orte: [{ id: 'ort_1', name: 'Wald', typ: 'natur', beschreibung: 'kalt', kapitel: [{ name: 'Kapitel Eins', haeufigkeit: 1 }], figuren_namen: ['Anna'] }],
    songs: [], szenen: [],
  });
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'), faktenPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'), eventsPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'), beziehungenResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'), kontinuitaetResponse());

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, email, 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', email, { id: 'tok', pw: 'pw' }, 'claude'));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.szenenCount, 1, 'Backfill ergänzt die fehlende Szene');
});

// ── #2: Coverage-Feedback ─────────────────────────────────────────────────────
// Der Vollständigkeits-Audit meldet eine fehlende Figur → gezielter Nachzieh-Pass ergänzt sie
// additiv (vor E/A2), sodass figCount steigt.
test('Komplettanalyse #2: Coverage-Feedback zieht eine vom Audit gemeldete fehlende Figur nach', async () => {
  const BOOK_ID = 123;
  const email = 'tester@test.dev';
  seedTinyBook(BOOK_ID);
  const appSettings = require('../../lib/app-settings');
  appSettings.set('ai.komplett.coverage_audit_chapters', 1);

  // Gezielter Figuren-Nachzieh-Call ZUERST (Prompt-Marker «fehlende_figuren» + figuren-Schema).
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && e.prompt.includes('fehlende_figuren'),
    { figuren: [{ id: 'fig_1', name: 'Clara', kurzname: 'Clara', typ: 'nebenfigur', beschreibung: 'vom Audit gefunden', sozialschicht: 'mitte', praesenz: 'punktuell', kapitel: [{ name: 'Kapitel Eins', haeufigkeit: 1 }], eigenschaften: [], schluesselzitate: [] }] },
  );
  // Audit-Call (forward + end) meldet Clara als fehlend.
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('erkannte_figuren') && e.schemaKeys.includes('fehlende_figuren'),
    { erkannte_figuren: 2, fehlende_figuren: ['Clara'], erkannte_orte: 1, fehlende_orte: [] },
  );
  ctx.mockAi.on((e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'), figurenStammResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'), ortePassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'), faktenPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'), eventsPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'), beziehungenResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'), kontinuitaetResponse());

  try {
    const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, email, 'job.label.komplett');
    ctx.shared.enqueueJob(jobId, () =>
      ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', email, { id: 'tok', pw: 'pw' }, 'claude'));
    const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
    assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
    assert.equal(job.result.figCount, 3, 'Coverage-Feedback ergänzt die fehlende Figur Clara');
    const names = ctx.dbSchema.db.prepare('SELECT name FROM figures WHERE book_id = ? ORDER BY name').all(BOOK_ID).map(r => r.name);
    assert.deepEqual(names, ['Anna', 'Bert', 'Clara']);
  } finally {
    appSettings.set('ai.komplett.coverage_audit_chapters', 0);
  }
});

// ── Teil-Lauf: read-only Endphasen abwählbar ─────────────────────────────────
// Kontinuitätsprüfung (P8) und Erzählprofil sitzen am ENDE der seriellen Kette. Wer
// nach einer Kapitel-Änderung nur den Katalog auffrischt, spart durch das Abwählen
// Wartezeit und Geld, ohne an der Extraktionsqualität zu drehen.
test('Komplettanalyse Teil-Lauf: skipContinuity überspringt P8 und friert den Konsolidierungs-Checkpoint NICHT ein', async () => {
  const BOOK_ID = 131;
  const email = 'tester@test.dev';
  seedTinyBook(BOOK_ID);

  ctx.mockAi.on((e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'), figurenStammResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'), ortePassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'), faktenPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'), eventsPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'), beziehungenResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'), kontinuitaetResponse());

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, email, 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', email, { id: 'tok', pw: 'pw' }, 'claude',
      { skipContinuity: true }));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });

  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.progress, 100, 'die Bar muss trotz übersprungener Phase auf 100 kommen');
  // Der Katalog ist vollständig — nur das Urteil fehlt.
  assert.ok(job.result.figCount >= 2, `Katalog trotz Teil-Lauf gefüllt (fig=${job.result.figCount})`);

  // KEIN Kontinuitäts-Call gelaufen.
  const kontCalls = ctx.mockAi.log.filter(e => e.schemaKeys?.includes('probleme')).length;
  assert.equal(kontCalls, 0, 'P8 darf bei skipContinuity gar nicht aufrufen');
  // Und kein Check persistiert (das vorherige Ergebnis bleibt, hier: keins).
  const checks = ctx.dbSchema.db.prepare('SELECT COUNT(*) n FROM continuity_checks WHERE book_id = ?').get(BOOK_ID);
  assert.equal(checks.n, 0, 'skipContinuity darf keinen Kontinuitäts-Check schreiben');

  // DIE zentrale Invariante: der Konsolidierungs-Marker behauptet „P2–P8 erledigt".
  // Nach einem Teil-Lauf stimmt das nicht — sonst bliebe der nächste Voll-Lauf am
  // Short-Circuit hängen und würde P8 nie nachholen.
  const marker = ctx.dbSchema.loadCheckpoint('komplett-consolidation', BOOK_ID, email);
  assert.equal(marker, null, 'Teil-Lauf darf keinen Konsolidierungs-Checkpoint schreiben');
});

test('Komplettanalyse Voll-Lauf schreibt den Konsolidierungs-Checkpoint (Gegenprobe)', async () => {
  const BOOK_ID = 132;
  const email = 'tester@test.dev';
  seedTinyBook(BOOK_ID);

  ctx.mockAi.on((e) => e.schemaKeys.includes('figuren') && !e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'), figurenStammResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'), ortePassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'), faktenPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('assignments'), eventsPassResponse());
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('beziehungen'), beziehungenResponse());
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'), kontinuitaetResponse());

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, email, 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', email, { id: 'tok', pw: 'pw' }, 'claude'));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });

  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  const kontCalls = ctx.mockAi.log.filter(e => e.schemaKeys?.includes('probleme')).length;
  assert.equal(kontCalls, 1, 'Voll-Lauf ruft P8 auf');
  const marker = ctx.dbSchema.loadCheckpoint('komplett-consolidation', BOOK_ID, email);
  assert.ok(marker && marker.sig, 'Voll-Lauf schreibt den Konsolidierungs-Checkpoint');
});
