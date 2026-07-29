'use strict';
// Integration: Quellen-Erkennung (routes/jobs/source-detect.js).
//
// Geprueft wird die Kette zwischen Modell und Vorschlagsliste — genau das, was
// weder der Prompt-Unit-Test noch der Lookup-Unit-Test sieht: Normalisierung
// des Modell-Outputs, Dedup ueber Kapitel hinweg, Rueckwaertssuche der
// Fundstelle, Abgleich gegen die Bibliothek und die Lookup-Obergrenze.
//
// Der Register-Lookup laeuft ueber ein gestubbtes `fetch` — der Job darf in
// Tests keinen Fremd-Dienst anfassen.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });

const USER = 'tester@test.dev';

let _origFetch;
test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
  _origFetch = globalThis.fetch;
  // Default: kein Register erreichbar → alle Funde bleiben unbestaetigt. Tests,
  // die den Registerpfad brauchen, ueberschreiben das selbst.
  globalThis.fetch = async () => { throw new Error('kein Netz im Test'); };
  const { db } = require('../../db/connection');
  db.prepare('DELETE FROM book_source_links').run();
  db.prepare('DELETE FROM sources').run();
});
test.afterEach(() => { globalThis.fetch = _origFetch; });

/** Registriert die KI-Antwort des Erkennungs-Calls. */
function onDetect(respond) {
  ctx.mockAi.on(e => e.schemaKeys.includes('werke'), respond);
}

function runJob(bookId, opts = {}) {
  const jobId = ctx.shared.createJob('source-detect', bookId, USER, 'job.label.sourceDetect', null, bookId);
  const p = ctx.sourceDetect.runSourceDetectJob(jobId, bookId, USER, opts);
  return p.then(() => waitForJob(ctx.shared, jobId));
}

test('Fund wird normalisiert, die Fundstelle rueckwaerts gesucht', async () => {
  const BOOK_ID = 900;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9010, book_id: BOOK_ID, name: 'Einleitung' }],
    pages: [{ id: 9020, book_id: BOOK_ID, chapter_id: 9010, name: 'Erste Seite', updated_at: '' }],
    pageBodies: {
      9020: '<p>Schon Kuhn hat in Die Struktur wissenschaftlicher Revolutionen gezeigt, '
          + 'dass Paradigmen springen. ' + 'Weiterer Text. '.repeat(40) + '</p>',
    },
  });

  onDetect({
    werke: [{
      typ: 'buch',
      titel: '  Die Struktur wissenschaftlicher   Revolutionen ',
      autoren: ['Thomas S. Kuhn'],
      jahr: 'um 1962',                       // Modell schreibt gern Prosa ins Jahresfeld
      container: '',
      erwaehnung: 'Schon Kuhn hat in Die Struktur wissenschaftlicher Revolutionen gezeigt',
    }],
  });

  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done');
  const [v] = job.result.vorschlaege;

  assert.equal(v.title, 'Die Struktur wissenschaftlicher Revolutionen');  // Whitespace normalisiert
  assert.equal(v.year, '1962');                                          // Jahreszahl herausgezogen
  assert.deepEqual(v.authors, [{ family: 'Kuhn', given: 'Thomas S.' }]);
  assert.equal(v.csl_type, 'book');
  assert.equal(v.page_id, 9020);                                         // Fundstelle rueckwaerts gefunden
  assert.equal(v.chapter_name, 'Einleitung');
  assert.equal(v.verified, false);                                       // Register nicht erreichbar
  assert.equal(v.existing_source_id, null);
});

test('das Modell bekommt keine Metadaten-Felder zurueckgeschrieben', async () => {
  const BOOK_ID = 901;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9011, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 9021, book_id: BOOK_ID, chapter_id: 9011, name: 'S', updated_at: '' }],
    pageBodies: { 9021: '<p>' + 'Text. '.repeat(60) + '</p>' },
  });
  // Selbst wenn ein Provider zusaetzliche Felder halluziniert: sie duerfen den
  // Entwurf nicht erreichen — die Metadaten kommen ausschliesslich aus dem
  // Register.
  onDetect({
    werke: [{
      typ: 'buch', titel: 'Erfundenes Werk', autoren: [], jahr: '', container: '',
      erwaehnung: 'x', isbn: '9781111111111', publisher: 'Phantasieverlag', doi: '10.9999/fake',
    }],
  });

  const job = await runJob(BOOK_ID);
  const [v] = job.result.vorschlaege;
  assert.equal(v.isbn, null);
  assert.equal(v.publisher, null);
  assert.equal(v.doi, null);
});

test('ohne Titel und ohne Person kein Vorschlag', async () => {
  const BOOK_ID = 902;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9012, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 9022, book_id: BOOK_ID, chapter_id: 9012, name: 'S', updated_at: '' }],
    pageBodies: { 9022: '<p>' + 'Text. '.repeat(60) + '</p>' },
  });
  onDetect({ werke: [
    { typ: 'buch', titel: '   ', autoren: [], jahr: '1900', container: '', erwaehnung: 'x' },
    { typ: 'buch', titel: '', autoren: ['Michel Foucault'], jahr: '', container: '', erwaehnung: 'y' },
  ] });

  const job = await runJob(BOOK_ID);
  assert.equal(job.result.vorschlaege.length, 1);
  assert.equal(job.result.vorschlaege[0].title, null);
  assert.equal(job.result.vorschlaege[0].authors[0].family, 'Foucault');
});

test('bereits erfasste Quelle wird markiert, nicht geschluckt', async () => {
  const BOOK_ID = 903;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9013, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 9023, book_id: BOOK_ID, chapter_id: 9013, name: 'S', updated_at: '' }],
    pageBodies: { 9023: '<p>' + 'Text. '.repeat(60) + '</p>' },
  });
  const { createSource } = require('../../db/sources');
  const existing = createSource(USER, { csl_type: 'book', title: 'Der Prozess', authors: [{ family: 'Kafka' }] });

  onDetect({ werke: [
    { typ: 'buch', titel: 'der prozess', autoren: ['Franz Kafka'], jahr: '', container: '', erwaehnung: 'x' },
  ] });

  const job = await runJob(BOOK_ID);
  const [v] = job.result.vorschlaege;
  assert.equal(v.existing_source_id, existing.id);
  // Im Pool, aber diesem Buch nicht zugeordnet → die Karte bietet „zuordnen" an.
  assert.equal(v.existing_linked, false);
});

test('dasselbe Werk in zwei Kapiteln erscheint einmal', async () => {
  const BOOK_ID = 904;
  // Enges Token-Budget im Test-Bootstrap → zwei Kapitel laufen als zwei Chunks.
  const filler = 'Ein langer Satz mit vielen Woertern zum Fuellen des Kontingents. '.repeat(200);
  ctx.dbSeed.setBook({
    chapters: [
      { id: 9014, book_id: BOOK_ID, name: 'Kap 1', priority: 1 },
      { id: 9015, book_id: BOOK_ID, name: 'Kap 2', priority: 2 },
    ],
    pages: [
      { id: 9024, book_id: BOOK_ID, chapter_id: 9014, name: 'S1', priority: 1, updated_at: '' },
      { id: 9025, book_id: BOOK_ID, chapter_id: 9015, name: 'S2', priority: 2, updated_at: '' },
    ],
    pageBodies: { 9024: `<p>${filler}</p>`, 9025: `<p>${filler}</p>` },
  });
  onDetect({ werke: [
    { typ: 'buch', titel: 'Das Kapital', autoren: ['Karl Marx'], jahr: '1867', container: '', erwaehnung: 'x' },
  ] });

  const job = await runJob(BOOK_ID);
  assert.ok(ctx.mockAi.log.length >= 2, 'Multi-Pass erwartet');
  assert.equal(job.result.vorschlaege.length, 1);
});

test('Registertreffer fuellt die Metadaten und setzt verified', async () => {
  const BOOK_ID = 905;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9016, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 9026, book_id: BOOK_ID, chapter_id: 9016, name: 'S', updated_at: '' }],
    pageBodies: { 9026: '<p>' + 'Text. '.repeat(60) + '</p>' },
  });
  onDetect({ werke: [
    { typ: 'buch', titel: 'Der Prozess', autoren: ['Franz Kafka'], jahr: '1925', container: '', erwaehnung: 'x' },
  ] });

  globalThis.fetch = async (url) => new Response(JSON.stringify({
    docs: [{
      title: 'Der Prozess', subtitle: 'Roman', author_name: ['Franz Kafka'],
      first_publish_year: 1925, publisher: ['Die Schmiede'], isbn: ['9783150094440'],
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const job = await runJob(BOOK_ID);
  const [v] = job.result.vorschlaege;
  assert.equal(v.verified, true);
  assert.equal(v.register, 'openlibrary');
  assert.equal(v.publisher, 'Die Schmiede');
  assert.equal(v.isbn, '9783150094440');
  assert.equal(job.result.verified, 1);
});

test('unerreichbares Register ist nicht fatal', async () => {
  const BOOK_ID = 906;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9017, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 9027, book_id: BOOK_ID, chapter_id: 9017, name: 'S', updated_at: '' }],
    pageBodies: { 9027: '<p>' + 'Text. '.repeat(60) + '</p>' },
  });
  onDetect({ werke: [
    { typ: 'buch', titel: 'Der Prozess', autoren: ['Franz Kafka'], jahr: '', container: '', erwaehnung: 'x' },
  ] });

  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done');
  assert.equal(job.result.vorschlaege[0].verified, false);
});

test('fehlendes werke-Feld ist ein Fehler, leeres Array nicht', async () => {
  const BOOK_ID = 907;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9018, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 9028, book_id: BOOK_ID, chapter_id: 9018, name: 'S', updated_at: '' }],
    pageBodies: { 9028: '<p>' + 'Text. '.repeat(60) + '</p>' },
  });

  onDetect({ irgendwas: [] });
  const bad = await runJob(BOOK_ID);
  assert.equal(bad.status, 'error');

  ctx.mockAi.reset();
  onDetect({ werke: [] });
  const ok = await runJob(BOOK_ID);
  assert.equal(ok.status, 'done');
  assert.deepEqual(ok.result.vorschlaege, []);
});

// ── Lauf-Historie ────────────────────────────────────────────────────────────

test('ein Lauf mit Funden wird historisiert, ein leerer nicht', async () => {
  const BOOK_ID = 909;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9040, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 9041, book_id: BOOK_ID, chapter_id: 9040, name: 'S', updated_at: '' }],
    pageBodies: { 9041: '<p>' + 'Text. '.repeat(60) + '</p>' },
  });
  const { listDetectRuns, getDetectRun } = require('../../db/sources');

  onDetect({ werke: [
    { typ: 'buch', titel: 'Das Kapital', autoren: ['Karl Marx'], jahr: '1867', container: '', erwaehnung: 'x' },
  ] });
  const job = await runJob(BOOK_ID);
  assert.ok(job.result.runId, 'runId im Job-Payload erwartet');

  const runs = listDetectRuns(BOOK_ID, USER);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].found_count, 1);
  assert.equal(runs[0].scope, 'book');
  assert.equal(runs[0].scope_chapter_id, null);
  // Die Liste traegt bewusst kein result_json (grosse Laeufe, Kopfzeilen reichen).
  assert.ok(!('result_json' in runs[0]));

  const detail = getDetectRun(runs[0].id);
  assert.equal(detail.result.vorschlaege[0].title, 'Das Kapital');
  // Bibliotheks-Status wird NICHT mitgespeichert — er altert.
  assert.ok(!('existing_source_id' in detail.result.vorschlaege[0]));

  ctx.mockAi.reset();
  onDetect({ werke: [] });
  const leer = await runJob(BOOK_ID);
  assert.equal(leer.result.runId, null);
  assert.equal(listDetectRuns(BOOK_ID, USER).length, 1, 'leerer Lauf legt keine Zeile an');
});

test('Kapitel-Lauf haelt seinen Scope, ein geloeschtes Kapitel macht ihn nicht zum Buch-Lauf', async () => {
  const BOOK_ID = 910;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9050, book_id: BOOK_ID, name: 'Kap X' }],
    pages: [{ id: 9051, book_id: BOOK_ID, chapter_id: 9050, name: 'S', updated_at: '' }],
    pageBodies: { 9051: '<p>' + 'Text. '.repeat(60) + '</p>' },
  });
  const { listDetectRuns, getDetectRun } = require('../../db/sources');
  const { db } = require('../../db/connection');

  onDetect({ werke: [
    { typ: 'buch', titel: 'Das Kapital', autoren: ['Karl Marx'], jahr: '', container: '', erwaehnung: 'x' },
  ] });
  const job = await runJob(BOOK_ID, { chapterId: 9050 });
  const run = getDetectRun(job.result.runId);
  assert.equal(run.scope, 'chapter');
  assert.equal(run.scope_chapter_id, 9050);
  assert.equal(run.scope_chapter_name, 'Kap X');   // Name kommt per JOIN, nicht als Snapshot

  db.prepare('DELETE FROM chapters WHERE chapter_id = ?').run(9050);
  const [after] = listDetectRuns(BOOK_ID, USER);
  assert.equal(after.scope, 'chapter', 'Scope bleibt — sonst laese sich der Lauf als Buch-Lauf');
  assert.equal(after.scope_chapter_id, null);
  assert.equal(after.scope_chapter_name, null);
});

test('Historie wird auf DETECT_RUN_KEEP begrenzt', () => {
  const BOOK_ID = 911;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9060, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 9061, book_id: BOOK_ID, chapter_id: 9060, name: 'S', updated_at: '' }],
    pageBodies: { 9061: '<p>kurz</p>' },
  });
  const { insertDetectRun, listDetectRuns, DETECT_RUN_KEEP } = require('../../db/sources');
  for (let i = 0; i < DETECT_RUN_KEEP + 4; i++) {
    insertDetectRun({ bookId: BOOK_ID, userEmail: USER, foundCount: i, result: { vorschlaege: [] } });
  }
  const runs = listDetectRuns(BOOK_ID, USER);
  assert.equal(runs.length, DETECT_RUN_KEEP);
  // Die neuesten bleiben: der aelteste Fund-Zaehler ist weg.
  assert.ok(runs.every(r => r.found_count >= 4));
});

test('Buch loeschen raeumt seine Laeufe mit weg (CASCADE)', () => {
  const BOOK_ID = 912;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9070, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 9071, book_id: BOOK_ID, chapter_id: 9070, name: 'S', updated_at: '' }],
    pageBodies: { 9071: '<p>kurz</p>' },
  });
  const { insertDetectRun, listDetectRuns } = require('../../db/sources');
  const { db } = require('../../db/connection');
  insertDetectRun({ bookId: BOOK_ID, userEmail: USER, foundCount: 1, result: { vorschlaege: [] } });
  assert.equal(listDetectRuns(BOOK_ID, USER).length, 1);
  db.prepare('DELETE FROM books WHERE book_id = ?').run(BOOK_ID);
  assert.equal(listDetectRuns(BOOK_ID, USER).length, 0);
});

test('Buch-Lauf mit Kapitel-ID ist per CHECK ausgeschlossen', () => {
  const BOOK_ID = 913;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9080, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 9081, book_id: BOOK_ID, chapter_id: 9080, name: 'S', updated_at: '' }],
    pageBodies: { 9081: '<p>kurz</p>' },
  });
  const { db } = require('../../db/connection');
  assert.throws(() => db.prepare(`
    INSERT INTO source_detect_runs (book_id, user_email, scope, scope_chapter_id, result_json)
    VALUES (?, ?, 'book', ?, '{}')
  `).run(BOOK_ID, USER, 9080), /CHECK/i);
});

test('annotateExisting rechnet den Bibliotheks-Status frisch', () => {
  const BOOK_ID = 914;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9090, book_id: BOOK_ID, name: 'K' }],
    pages: [{ id: 9091, book_id: BOOK_ID, chapter_id: 9090, name: 'S', updated_at: '' }],
    pageBodies: { 9091: '<p>kurz</p>' },
  });
  const { annotateExisting } = ctx.sourceDetect;
  const { createSource, linkSource } = require('../../db/sources');
  const items = [{ title: 'Der Prozess' }, { title: 'Nie gehoertes Werk' }];

  // Vorher: nichts in der Bibliothek.
  let out = annotateExisting(items, USER, BOOK_ID);
  assert.equal(out[0].existing_source_id, null);
  assert.equal(out[0].existing_linked, false);

  // Erfasst, aber einem anderen Buch zugeordnet → bekannt, nicht verknuepft.
  const s = createSource(USER, { csl_type: 'book', title: 'Der Prozess' });
  out = annotateExisting(items, USER, BOOK_ID);
  assert.equal(out[0].existing_source_id, s.id);
  assert.equal(out[0].existing_linked, false);

  // Zugeordnet → verknuepft.
  linkSource(BOOK_ID, s.id, USER);
  out = annotateExisting(items, USER, BOOK_ID);
  assert.equal(out[0].existing_linked, true);
  assert.equal(out[1].existing_source_id, null, 'unbekanntes Werk bleibt unbekannt');
});

test('Kapitel-Scope durchsucht nur dieses Kapitel', async () => {
  const BOOK_ID = 908;
  ctx.dbSeed.setBook({
    chapters: [
      { id: 9019, book_id: BOOK_ID, name: 'Kap A', priority: 1 },
      { id: 9029, book_id: BOOK_ID, name: 'Kap B', priority: 2 },
    ],
    pages: [
      { id: 9030, book_id: BOOK_ID, chapter_id: 9019, name: 'A1', priority: 1, updated_at: '' },
      { id: 9031, book_id: BOOK_ID, chapter_id: 9029, name: 'B1', priority: 2, updated_at: '' },
    ],
    pageBodies: {
      9030: '<p>Nur in Kapitel A steht etwas. ' + 'Fuelltext. '.repeat(40) + '</p>',
      9031: '<p>Nur in Kapitel B steht etwas. ' + 'Fuelltext. '.repeat(40) + '</p>',
    },
  });
  onDetect({ werke: [] });

  const job = await runJob(BOOK_ID, { chapterId: 9019 });
  assert.equal(job.status, 'done');
  assert.equal(job.result.scopeName, 'Kap A');
  const prompt = ctx.mockAi.log.at(-1).prompt;
  assert.ok(prompt.includes('Nur in Kapitel A'));
  assert.ok(!prompt.includes('Nur in Kapitel B'));
});
