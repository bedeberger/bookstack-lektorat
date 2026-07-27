// Unit-Tests für den Session-Abbau des Notebook-Editors und die beiden
// Konflikt-Invarianten, die dabei hängen:
//
//   T1  `_teardownEditSession` räumt ALLES, was `startEdit` aufgebaut hat —
//       inklusive Edit-Lock und Presence-Heartbeat. Fehlten die, würde eine
//       verlassene Seite bei anderen Usern dauerhaft als „wird bearbeitet"
//       stehen (Lock-Heartbeat erneuert sich alle 5 min von selbst).
//   T2  `keepDraft` entscheidet über den localStorage-Entwurf: cancelEdit
//       verwirft (User hat bestätigt), der Seitenwechsel behält (der Draft ist
//       dort die einzige Kopie ungespeicherter Arbeit).
//   T3  Konflikt-State (`editConflict`/`conflictResolution`) ist session-
//       gebunden. Der Banner hängt im Template nicht an `editMode` und würde
//       sonst im Lesemodus stehen bleiben — mit einem Button, der `saveEdit()`
//       auf dem noch im DOM hängenden contenteditable auslöst.
//   T4  Bewusstes Überschreiben („trotzdem speichern") muss den FRISCHEN
//       Remote-Stempel mitschicken. Der OCC-Guard im Backend prüft
//       `WHERE updated_at = expected_updated_at` — mit dem stale Editor-Stempel
//       liefe der PUT erneut in 409 und die User-Entscheidung wäre wirkungslos.
//   T5  `_applySaveSuccess` schliesst den Autosave-Zyklus (Max-Timer-Baseline).
//
// Setup wie notebook-autosave.test.mjs: linkedom als DOM, window.__app als Host.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML, DOMParser } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = DOMParser;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;

// localStorage-Stub: draft-storage.js schreibt/liest direkt darauf.
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');

const { notebookEditMethods } = await import('../../public/js/editor/notebook/edit.js');
const { writeDraft, readDraft } = await import('../../public/js/editor/draft-storage.js');

function setApp(extra = {}) {
  const app = {
    editMode: true,
    editDirty: true,
    editSaving: false,
    saveOffline: false,
    draftPersistFailed: false,
    focusActive: false,
    pendingDraft: { savedAt: 1 },
    editConflict: { remoteUserName: 'Bob', remoteUpdatedAt: '2026-02-02T00:00:00Z' },
    conflictResolution: { pageId: 5, conflicts: [], decisions: {} },
    pageEditorFullscreen: true,
    pageEditorFitWidth: true,
    currentPage: { id: 5, name: 'S', updated_at: '2026-01-01T00:00:00Z' },
    originalHtml: '<p>a</p>',
    lastDraftSavedAt: 123,
    lastAutosaveAt: null,
    t: (k) => k,
    setStatus() {},
    formatDate: (v) => String(v),
    ...extra,
  };
  window.__app = app;
  return app;
}

// Teardown-Ziele, die aus der Card bzw. dem Root kommen, als Zähler mitschreiben.
function ctxWith(app, overrides = {}) {
  const calls = [];
  app._stopPresenceHeartbeat = () => calls.push('presence');
  app._releaseEditLock = (id) => calls.push('lock:' + id);
  app._editCounterCtx = { teardown: () => calls.push('counter') };
  app.closeSynonymMenu = () => calls.push('synonymMenu');
  app.closeSynonymPicker = () => calls.push('synonymPicker');
  app.closeFigurLookup = () => calls.push('figurLookup');
  const ctx = {
    ...notebookEditMethods,
    _stopAutosave() { calls.push('autosave'); },
    _clearAutosaveTimers() { calls.push('clearTimers'); },
    _uninstallOnlineRetry() { calls.push('onlineRetry'); },
    _uninstallFormatMarks() { calls.push('formatMarks'); },
    _historyClear() { calls.push('history'); },
    ...overrides,
  };
  return { ctx, calls };
}

// ── T1: vollständiger Abbau ─────────────────────────────────────────────────

test('T1: _teardownEditSession stoppt Presence-Heartbeat UND gibt den Edit-Lock frei', () => {
  const app = setApp();
  const { ctx, calls } = ctxWith(app);
  ctx._teardownEditSession();
  assert.ok(calls.includes('presence'), 'Presence-Heartbeat muss stoppen');
  assert.ok(calls.includes('lock:5'), 'Edit-Lock muss für die Seite freigegeben werden');
  assert.ok(calls.includes('counter'), 'Edit-Counter muss abgebaut werden');
  assert.ok(calls.includes('formatMarks'), 'Steuerzeichen-Overlay muss abgebaut werden');
  assert.ok(calls.includes('history'), 'Undo-Stack muss geleert werden');
  assert.equal(app.editMode, false);
  assert.equal(app.editDirty, false);
  assert.equal(app.editSaving, false);
});

test('T1: Teardown-Reihenfolge — Listener/Locks VOR editMode=false', () => {
  // Frühes editMode=false liesse die Teardowns auf bereits genullten Refs
  // laufen (Pflicht-Invariante #11). Als Source-Check, weil die Reihenfolge
  // sonst nur bei echtem Leak auffällt.
  const src = fs.readFileSync(path.join(repo, 'public/js/editor/notebook/edit/lifecycle.js'), 'utf8');
  const body = src.match(/_teardownEditSession\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/)[0];
  const idx = (re) => body.search(re);
  assert.ok(idx(/_stopAutosave/) < idx(/app\.editMode\s*=\s*false/), 'Autosave vor editMode=false');
  assert.ok(idx(/_releaseEditLock/) < idx(/app\.editMode\s*=\s*false/), 'Lock-Release vor editMode=false');
  assert.ok(idx(/_stopPresenceHeartbeat/) < idx(/app\.editMode\s*=\s*false/), 'Presence vor editMode=false');
  assert.ok(idx(/_historyClear/) < idx(/app\.editMode\s*=\s*false/), 'History vor editMode=false');
});

// ── T2: Draft-Semantik ──────────────────────────────────────────────────────

test('T2: Default verwirft den Draft (cancelEdit-Pfad)', () => {
  const app = setApp();
  writeDraft(5, '<p>unsaved</p>', '<p>a</p>', app.currentPage.updated_at);
  const { ctx } = ctxWith(app);
  ctx._teardownEditSession();
  assert.equal(readDraft(5), null, 'Draft muss weg sein');
  assert.equal(app.pendingDraft, null);
});

test('T2: keepDraft behält den Draft (Seitenwechsel-Pfad)', () => {
  const app = setApp();
  writeDraft(5, '<p>unsaved</p>', '<p>a</p>', app.currentPage.updated_at);
  const { ctx } = ctxWith(app);
  ctx._teardownEditSession({ keepDraft: true });
  assert.equal(readDraft(5)?.html, '<p>unsaved</p>', 'Draft ist die einzige Kopie — muss bleiben');
});

test('T2: resetPage delegiert an den Teardown-Helper mit keepDraft', () => {
  const src = fs.readFileSync(path.join(repo, 'public/js/app/app-view/page.js'), 'utf8');
  const body = src.match(/resetPage\s*\(\)\s*\{[\s\S]*?\n  \}/)[0];
  assert.match(body, /_teardownEditSession\?\.\(\s*\{\s*keepDraft:\s*true\s*\}\s*\)/,
    'resetPage muss die Session über die SSoT abbauen (sonst leaken Lock + Presence)');
});

// ── T3: Konflikt-State ist session-gebunden ─────────────────────────────────

test('T3: Teardown räumt editConflict + conflictResolution', () => {
  const app = setApp();
  const { ctx } = ctxWith(app);
  ctx._teardownEditSession();
  assert.equal(app.editConflict, null, 'Banner darf nicht in den Lesemodus überleben');
  assert.equal(app.conflictResolution, null);
});

test('T3: saveEdit bricht ohne offene Edit-Session ab', async () => {
  // Das contenteditable hängt nach dem Teardown weiter im DOM (display:none)
  // und trägt noch den verworfenen Text. Ein Aufruf von aussen darf ihn nicht
  // zurückschreiben.
  const app = setApp({ editMode: false });
  let saved = 0;
  const { ctx } = ctxWith(app, {
    _getEditEl: () => ({ innerHTML: '<p>verworfen</p>' }),
    canEdit: () => true,
  });
  app.canEdit = () => true;
  ctx._resolveConflictBeforeSave = async () => { saved++; return { proceed: false }; };
  await ctx.saveEdit();
  assert.equal(saved, 0, 'kein Save-Versuch ohne editMode');
});

// ── T4: Overwrite-Stempel ───────────────────────────────────────────────────

test('T4: "trotzdem speichern" nutzt den frischen Remote-Stempel, nicht den stale', async () => {
  const app = setApp({
    appConfirm: async () => true,
    editConflict: null,
  });
  const conflict = {
    remoteUpdatedAt: '2026-03-03T00:00:00Z',
    remoteUserName: 'Bob',
    remoteIsSelf: false,
    remoteDevice: null,
    remoteHtml: '<p>remote</p>',
  };
  const { ctx } = ctxWith(app, {
    _checkPageConflict: async () => conflict,
    _attemptBlockMerge: async () => null, // kein Merge → klassischer Overwrite-Pfad
  });

  const r = await ctx._resolveConflictBeforeSave({ localHtml: '<p>mine</p>', source: 'main', silent: false });

  assert.equal(r.proceed, true, 'User hat Overwrite bestätigt');
  assert.equal(r.expectedAt, '2026-03-03T00:00:00Z',
    'expectedUpdatedAt muss der frische Remote-Stand sein — sonst 409 statt Overwrite');
  assert.notEqual(r.expectedAt, app.currentPage.updated_at);
});

test('T4: silent-Pfad (quickSave) zeigt niemals ein Modal', async () => {
  let confirms = 0;
  const app = setApp({ appConfirm: async () => { confirms++; return true; } });
  const { ctx } = ctxWith(app, {
    _checkPageConflict: async () => ({
      remoteUpdatedAt: '2026-03-03T00:00:00Z', remoteUserName: 'Bob',
      remoteIsSelf: false, remoteDevice: null, remoteHtml: '<p>remote</p>',
    }),
    _attemptBlockMerge: async () => null,
  });

  const r = await ctx._resolveConflictBeforeSave({ localHtml: '<p>mine</p>', source: 'main', silent: true });

  assert.equal(confirms, 0, 'Hintergrund-Save darf nicht nachfragen (Invariante #9)');
  assert.equal(r.proceed, false);
  assert.equal(app.saveOffline, true, 'stattdessen Banner + Offline-Flag');
  assert.ok(app.editConflict, 'Konflikt-Banner gesetzt');
});

// ── T5: Save schliesst den Autosave-Zyklus ──────────────────────────────────

test('T5: _applySaveSuccess räumt die Autosave-Timer (Max-Cap-Baseline)', () => {
  const app = setApp({ _syncPageStatsAfterSave() {}, refreshPageAges() {}, updatePageView() {} });
  const { ctx, calls } = ctxWith(app, { _filterFindingsAfterSave() {} });
  ctx._applySaveSuccess({ updated_at: '2026-09-09T00:00:00Z' }, '<p>neu</p>');
  assert.ok(calls.includes('clearTimers'),
    'ohne Reset messe der 120-s-Max-Cap der nächsten Tipp-Serie von der alten Baseline');
  assert.equal(app.editDirty, false);
  assert.equal(app.editConflict, null);
  assert.equal(app.currentPage.updated_at, '2026-09-09T00:00:00Z');
});

// ── C: editSaving vor dem ersten await (Race gegen den Autosave-Tick) ───────

test('C: saveEdit setzt editSaving VOR dem ersten await (Invariante #6)', () => {
  const src = fs.readFileSync(path.join(repo, 'public/js/editor/notebook/edit/lifecycle.js'), 'utf8');
  const body = src.match(/async saveEdit\s*\(\)\s*\{[\s\S]*?\n  \}/)[0];
  // Der No-Change-Zweig darf awaiten (dort wird nichts geschrieben) — gemessen
  // wird ab dem Punkt, an dem der Save wirklich beginnt.
  const from = body.indexOf('const newText');
  const rest = body.slice(from);
  const flagAt = rest.indexOf('app.editSaving = true');
  const awaitAt = rest.search(/await\s+(app\.appConfirm|this\._resolveConflictBeforeSave|savePage)/);
  assert.ok(flagAt !== -1, 'saveEdit setzt editSaving');
  assert.ok(awaitAt !== -1, 'saveEdit hat einen Save-Await');
  assert.ok(flagAt < awaitAt,
    'editSaving muss vor Kürzungs-Dialog/Conflict-Read stehen — sonst feuert der Autosave-Tick parallel');
});
