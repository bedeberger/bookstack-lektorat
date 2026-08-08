// Unit-Tests für die Autosave-/Draft-/Online-Retry-Pfade des Notebook-Editors
// (public/js/editor/notebook/edit/autosave.js). Das sind die datenverlust-
// kritischen Timer-/Retry-Mechaniken, die zuvor nur über die Konstanten-
// Ordnung (editor-normal.test) abgedeckt waren, nicht im Verhalten.
//
// Setup: linkedom liefert window/document (Event-Listener für den Online-Retry);
// window.__app ist der Host (editorHost() → window.__app). quickSave wird am
// ctx gestubbt, damit kein Netzwerk läuft. Timer via node:test mock.timers.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, DOMParser } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = DOMParser;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;

const { notebookEditMethods } = await import('../../public/js/editor/notebook/edit.js');
const { AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_MS, AUTOSAVE_KEY, DRAFT_DEBOUNCE_MS } = await import('../../public/js/editor/notebook/edit/_shared.js');

function setApp(extra = {}) {
  const app = {
    editMode: true,
    editDirty: true,
    editSaving: false,
    saveOffline: false,
    currentPage: { id: 5, name: 'S', updated_at: '2026-01-01T00:00:00Z' },
    originalHtml: '<p>a</p>',
    lastDraftSavedAt: null,
    ...extra,
  };
  window.__app = app;
  return app;
}

function ctxWith(overrides = {}) {
  return { ...notebookEditMethods, ...overrides };
}

// ── _fireAutosave-Gating ─────────────────────────────────────────────────────

test('_fireAutosave: ruft quickSave nur bei editMode+editDirty+!editSaving', () => {
  const app = setApp();
  let qs = 0;
  const ctx = ctxWith({ quickSave() { qs++; } });

  ctx._fireAutosave();
  assert.equal(qs, 1, 'sauberer Zustand → quickSave');

  app.editDirty = false; ctx._fireAutosave();
  assert.equal(qs, 1, 'nicht dirty → kein Save');

  app.editDirty = true; app.editSaving = true; ctx._fireAutosave();
  assert.equal(qs, 1, 'während Save → kein zweiter Save');

  app.editSaving = false; app.editMode = false; ctx._fireAutosave();
  assert.equal(qs, 1, 'nicht im Edit-Modus → kein Save');
});

// ── Timer-Scheduling ─────────────────────────────────────────────────────────

test('_scheduleAutosave: Idle-Timer feuert nach AUTOSAVE_IDLE_MS → quickSave', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    setApp();
    let qs = 0;
    const ctx = ctxWith({ quickSave() { qs++; } });
    ctx._scheduleAutosave();
    assert.ok(window.__app._autosaveTimers.pending(AUTOSAVE_KEY), 'Timer gesetzt');
    mock.timers.tick(AUTOSAVE_IDLE_MS);
    assert.equal(qs, 1, 'Idle-Feuer löst quickSave aus');
  } finally {
    mock.timers.reset();
  }
});

test('_scheduleAutosave: erneutes Tippen resettet Idle, Max-Timer bleibt derselbe', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    setApp();
    let qs = 0;
    const ctx = ctxWith({ quickSave() { qs++; } });
    ctx._scheduleAutosave();
    // Kurz vor dem Idle-Fire erneut tippen → Idle-Timer neu, kein Save.
    // Dass der Max-Timer dabei NICHT mitwandert, prüft der Dauer-Tipp-Test
    // darunter im Verhalten (er feuert dort exakt einmal, bei AUTOSAVE_MAX_MS).
    mock.timers.tick(AUTOSAVE_IDLE_MS - 1000);
    ctx._scheduleAutosave();
    mock.timers.tick(AUTOSAVE_IDLE_MS - 1000);
    assert.equal(qs, 0, 'Idle wurde zurückgesetzt → noch kein Save');
    mock.timers.tick(1000);
    assert.equal(qs, 1, 'nach voller Idle-Pause → Save');
  } finally {
    mock.timers.reset();
  }
});

test('_scheduleAutosave: Max-Timer greift bei Dauer-Tippen (Idle wird nie erreicht)', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    setApp();
    let qs = 0;
    const ctx = ctxWith({ quickSave() { qs++; } });
    // Alle 5s "tippen" → Idle feuert nie, aber Max muss nach AUTOSAVE_MAX_MS zuschlagen.
    let elapsed = 0;
    while (elapsed < AUTOSAVE_MAX_MS) {
      ctx._scheduleAutosave();
      mock.timers.tick(5000);
      elapsed += 5000;
    }
    assert.equal(qs, 1, 'Max-Cap löst spätestens nach AUTOSAVE_MAX_MS aus');
  } finally {
    mock.timers.reset();
  }
});

test('_clearAutosaveTimers: raeumt beide Timer — kein Save mehr, auch nicht nach dem Max-Cap', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    setApp();
    let qs = 0;
    const ctx = ctxWith({ quickSave() { qs++; } });
    ctx._scheduleAutosave();
    ctx._clearAutosaveTimers();
    assert.equal(window.__app._autosaveTimers.pending(AUTOSAVE_KEY), false, 'kein Timer mehr registriert');
    // Ueber BEIDE Deadlines hinweg ticken: ein vergessener Max-Timer feuerte
    // sonst 60 s nach dem Idle-Fenster nach.
    mock.timers.tick(AUTOSAVE_MAX_MS + 1000);
    assert.equal(qs, 0, 'weder Idle noch Max feuern nach dem Clear');
  } finally {
    mock.timers.reset();
  }
});

// ── Online-Retry-Gating ──────────────────────────────────────────────────────

test('_installOnlineRetry: retry ruft quickSave nur bei editMode+editDirty+saveOffline+!editSaving', () => {
  const app = setApp({ saveOffline: true });
  let qs = 0;
  const ctx = ctxWith({ quickSave() { qs++; } });
  ctx._installOnlineRetry();
  const retry = app._onlineHandler;
  assert.equal(typeof retry, 'function', 'Retry-Handler installiert');

  retry();
  assert.equal(qs, 1, 'offline+dirty+edit → Retry feuert');

  app.saveOffline = false; retry();
  assert.equal(qs, 1, 'ohne saveOffline kein Retry (nichts hängt)');

  app.saveOffline = true; app.editSaving = true; retry();
  assert.equal(qs, 1, 'während laufendem Save kein doppelter Retry');

  ctx._uninstallOnlineRetry();
  assert.equal(app._onlineHandler, null, 'Teardown nullt den Handler');
  assert.equal(app._onlineVisHandler, null, 'Teardown nullt den Visibility-Handler');
});

test('_installOnlineRetry: doppelter Install registriert nicht doppelt', () => {
  const app = setApp({ saveOffline: true });
  const ctx = ctxWith({ quickSave() {} });
  ctx._installOnlineRetry();
  const first = app._onlineHandler;
  ctx._installOnlineRetry();
  assert.equal(app._onlineHandler, first, 'zweiter Install ist No-op (Guard auf _onlineHandler)');
  ctx._uninstallOnlineRetry();
});

// ── _flushDraftSaveNow ───────────────────────────────────────────────────────

test('_flushDraftSaveNow: kein Change → Draft wird gelöscht, lastDraftSavedAt genullt', () => {
  const cleared = [];
  const written = [];
  globalThis.localStorage = {
    getItem: () => null,
    setItem: (k, v) => written.push([k, v]),
    removeItem: (k) => cleared.push(k),
  };
  const app = setApp({ lastDraftSavedAt: 123, originalHtml: '<p>gleich</p>' });
  const el = document.createElement('div');
  el.className = 'page-content-view page-content-view--editing';
  el.innerHTML = '<p>gleich</p>';
  const host = document.createElement('div');
  host.id = 'editor-card';
  host.appendChild(el);
  document.body.appendChild(host);
  const ctx = ctxWith({});
  ctx._flushDraftSaveNow();
  assert.ok(cleared.some(k => k.includes('5')), 'Draft der Seite 5 gelöscht');
  assert.equal(app.lastDraftSavedAt, null);
  assert.equal(written.length, 0, 'kein Draft geschrieben bei No-Change');
  document.body.removeChild(host);
});
