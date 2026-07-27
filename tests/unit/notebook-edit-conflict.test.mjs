// Unit-Tests für Notebook-Editor Pre-Save-Pfade aus
// public/js/editor/notebook/edit.js:
//   - `_checkPageConflict` — Read-Modify-Write-Konflikterkennung. Kritisch ist
//     der `fresh: true`-Read (SW-SWR-Cache würde sonst Cross-User-Edits
//     verschlucken) und dass kein Modal bei fehlendem/gleichem Stand auslöst.
//   - `_filterFindingsAfterSave` — nach jedem Save fliegen Findings raus, deren
//     `original`-Text nicht mehr im HTML steht; Selektion der Überlebenden bleibt.
//
// Setup: linkedom liefert window/document; `contentRepo.loadPage` wird am
// Singleton gemockt (gleiche Modulinstanz wie edit.js). Test-HTML sind statische
// Literale im Source — kein XSS-Risiko.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;

const { contentRepo } = await import('../../public/js/repo/content.js');
const { notebookEditMethods } = await import('../../public/js/editor/notebook/edit.js');

function mockLoadPage(impl) { contentRepo.loadPage = impl; }

// --- _checkPageConflict -----------------------------------------------------

test('_checkPageConflict: kein expectedUpdatedAt → null (kein Read)', async () => {
  let called = false;
  mockLoadPage(async () => { called = true; return {}; });
  const r = await notebookEditMethods._checkPageConflict(1, null);
  assert.equal(r, null);
  assert.equal(called, false);
});

test('_checkPageConflict: liest IMMER fresh (SW-Cache-Bypass-Invariante)', async () => {
  let opts;
  mockLoadPage(async (id, o) => { opts = o; return { updated_at: '2026-01-01T00:00:00Z' }; });
  await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.equal(opts?.fresh, true);
});

test('_checkPageConflict: gleicher Stand → null (kein Konflikt)', async () => {
  mockLoadPage(async () => ({ updated_at: '2026-01-01T00:00:00Z' }));
  const r = await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.equal(r, null);
});

test('_checkPageConflict: abweichender Stand → Konfliktobjekt', async () => {
  mockLoadPage(async () => ({ updated_at: '2026-02-02T10:00:00Z', updated_by_name: 'Bob', html: '<p>remote</p>' }));
  const r = await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.deepEqual(r, {
    remoteUpdatedAt: '2026-02-02T10:00:00Z',
    remoteUserName: 'Bob',
    // Ohne Session-Email im Test-Host kein Self-Match → Fremd-Formulierung.
    remoteIsSelf: false,
    remoteDevice: null,
    remoteHtml: '<p>remote</p>',
  });
});

test('_checkPageConflict: eigenes Zweit-Geraet → remoteIsSelf + Geraetename', async () => {
  window.__app = { $store: { session: { currentUser: { email: 'me@example.com' } } } };
  mockLoadPage(async () => ({
    updated_at: '2026-02-02T10:00:00Z',
    updated_by_name: 'Ich',
    last_editor_email: 'me@example.com',
    last_editor: { device_name: 'MacBook' },
    html: '<p>remote</p>',
  }));
  const r = await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.equal(r.remoteIsSelf, true);
  assert.equal(r.remoteDevice, 'MacBook');
  delete window.__app;
});

test('_checkPageConflict: fehlender updated_by_name/html → null/leer normalisiert', async () => {
  mockLoadPage(async () => ({ updated_at: '2026-02-02T10:00:00Z' }));
  const r = await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.equal(r.remoteUserName, null);
  assert.equal(r.remoteHtml, '');
});

test('_checkPageConflict: Read wirft → null (kein irreführendes Modal)', async () => {
  mockLoadPage(async () => { throw Object.assign(new Error('boom'), { status: 500 }); });
  const r = await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.equal(r, null);
});

test('_checkPageConflict: Remote ohne updated_at → null', async () => {
  mockLoadPage(async () => ({ html: '<p>x</p>' }));
  const r = await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.equal(r, null);
});

// --- _filterFindingsAfterSave -----------------------------------------------

function setApp(extra) {
  const app = {
    lektoratFindings: [],
    selectedFindings: [],
    appliedOriginals: [],
    checkDone: true,
    correctedHtml: '<x>',
    hasErrors: true,
    _recomputeCorrectedHtml() { this._rcCalled = true; },
    ...extra,
  };
  window.__app = app;
  return app;
}

test('_filterFindingsAfterSave: ohne Findings → no-op', () => {
  const app = setApp({ lektoratFindings: [], selectedFindings: [] });
  notebookEditMethods._filterFindingsAfterSave('<p>egal</p>');
  assert.equal(app.lektoratFindings.length, 0);
  assert.notEqual(app._rcCalled, true);
});

test('_filterFindingsAfterSave: behält Finding mit vorhandenem original + Selektion', () => {
  const f1 = { original: 'bleibt', pos: 0 };
  const f2 = { original: 'verschwunden', pos: 1 };
  const app = setApp({
    lektoratFindings: [f1, f2],
    selectedFindings: [true, true],
    appliedOriginals: ['bleibt', 'verschwunden'],
  });
  notebookEditMethods._filterFindingsAfterSave('<p>bleibt drin</p>');
  assert.equal(app.lektoratFindings.length, 1);
  assert.equal(app.lektoratFindings[0], f1);
  assert.deepEqual(app.selectedFindings, [true]);
  assert.deepEqual(app.appliedOriginals, ['bleibt']);
  assert.equal(app._rcCalled, true);
});

test('_filterFindingsAfterSave: alle weg → Prüfmodus-Reset', () => {
  const app = setApp({
    lektoratFindings: [{ original: 'weg' }],
    selectedFindings: [true],
    appliedOriginals: ['weg'],
  });
  notebookEditMethods._filterFindingsAfterSave('<p>nichts</p>');
  assert.equal(app.lektoratFindings.length, 0);
  assert.equal(app.checkDone, false);
  assert.equal(app.correctedHtml, null);
  assert.equal(app.hasErrors, false);
});

// --- submitConflictResolution: erneuter 409 → Re-Merge statt Sackgasse -------
// Deckt den Pfad ab, in dem ein DRITTER Schreibvorgang zwischen Konflikt-Anzeige
// und „Auflösung übernehmen" passiert: der finale PUT (expected =
// cr.remoteUpdatedAt) trifft erneut 409. Statt nur saveFailed anzuzeigen, muss
// die aufgelöste Fassung gegen den neuen Remote-Stand neu block-gemergt werden
// (Verhalten analog saveEdit). Der Merge-Motor selbst ist in block-merge.test.mjs
// getestet — hier wird _attemptBlockMerge gestubbt, um die Orchestrierung zu prüfen.

const conflict409 = (extra = {}) => Object.assign(new Error('conflict'), {
  status: 409, code: 'PAGE_CONFLICT', body: { server_editor_name: 'Carol', server_updated_at: '2026-04-04T00:00:00Z', ...extra },
});

function setConflictApp(extra = {}) {
  const app = {
    editSaving: false,
    focusActive: false,
    originalHtml: '<p data-bid="aa">base</p>',
    currentPage: { id: 7, name: 'S', updated_at: '2026-01-01T00:00:00Z' },
    conflictResolution: {
      pageId: 7,
      source: 'main',
      merged: [{ bid: 'aa', html: '<p data-bid="aa">x</p>' }],
      conflicts: [{ bid: 'aa' }],
      decisions: { aa: 'local' },
      remoteUpdatedAt: '2026-02-02T00:00:00Z',
    },
    t: (k) => k,
    setStatus() {},
    _syncPageStatsAfterSave() {},
    refreshPageAges() {},
    updatePageView() {},
    ...extra,
  };
  window.__app = app;
  return app;
}

test('submitConflictResolution: 2. 409 + kollisionsfreier Re-Merge → stille Re-Save', async () => {
  const app = setConflictApp();
  let calls = 0;
  const saved = [];
  contentRepo.savePage = async (id, payload) => {
    calls++;
    saved.push(payload);
    if (calls === 1) throw conflict409();
    return { updated_at: '2026-05-05T00:00:00Z' };
  };
  notebookEditMethods._attemptBlockMerge = async () => ({ merged: true, saveHtml: '<p data-bid="aa">merged</p>', expectedAt: '2026-04-04T00:00:00Z' });

  await notebookEditMethods.submitConflictResolution();

  assert.equal(calls, 2, 'zweiter Save nach Re-Merge');
  assert.equal(saved[1].expected_updated_at, '2026-04-04T00:00:00Z', 'Re-Save nutzt frischen Remote-Stand');
  assert.equal(app.originalHtml, '<p data-bid="aa">merged</p>');
  assert.equal(app.currentPage.updated_at, '2026-05-05T00:00:00Z');
  assert.equal(app.conflictResolution, null, 'Banner geschlossen');
  assert.equal(app.editSaving, false);
});

test('submitConflictResolution: 2. 409 + echte Block-Kollision → neuer Banner, keine Re-Save', async () => {
  const app = setConflictApp();
  let calls = 0;
  contentRepo.savePage = async () => { calls++; throw conflict409(); };
  // _attemptBlockMerge öffnet bei Kollision einen neuen conflictResolution-State.
  const reopened = { pageId: 7, conflicts: [{ bid: 'aa' }], decisions: { aa: 'local' }, remoteUpdatedAt: '2026-04-04T00:00:00Z' };
  notebookEditMethods._attemptBlockMerge = async () => { window.__app.conflictResolution = reopened; return { conflict: true }; };

  await notebookEditMethods.submitConflictResolution();

  assert.equal(calls, 1, 'nur der erste (fehlgeschlagene) Save');
  assert.equal(app.conflictResolution, reopened, 'neuer Konflikt-State offen, keine Sackgasse');
  assert.equal(app.editSaving, false);
});

test('submitConflictResolution: 2. 409 + Merge null → Draft behalten + editConflict-Banner', async () => {
  const app = setConflictApp();
  contentRepo.savePage = async () => { throw conflict409(); };
  notebookEditMethods._attemptBlockMerge = async () => null;

  await notebookEditMethods.submitConflictResolution();

  assert.equal(app.saveOffline, true);
  assert.deepEqual(app.editConflict, {
    remoteUserName: 'Carol', remoteUpdatedAt: '2026-04-04T00:00:00Z',
    // Fremder User (kein server_is_self im 409-Body) → Geraete-Variante aus.
    remoteIsSelf: false, remoteDevice: null,
  });
  assert.ok(app.conflictResolution, 'Auflösungs-State bleibt für erneuten Versuch erhalten');
  assert.equal(app.editSaving, false);
});
