// Normal-Editor („Notizbuch") — Source-Level-Smoke-Tests.
//
// Edit-Pipeline lebt als `notebookEditMethods`-Spread in der Sub-Karte
// `editorNotebookCard` (public/js/editor/notebook/edit.js); Root spreaded nur
// die Forwarder aus public/js/editor/notebook/trampoline.js. Diese Tests
// greppen statisch, dass alle Normal-Hauptfeatures aus dem Plan-Inventar im
// Source vorhanden sind und mit den geteilten Hilfen aus `editor/shared/`
// arbeiten. Sie ersetzen keine E2E-Coverage — dort werden Behaviors verifiziert.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
// Submodul-bewusst: liegt neben <name>.js ein <name>/-Verzeichnis (Facade-Split),
// werden dessen .js-Submodule angehängt, damit Source-Invarianten den ganzen
// Modul-Quelltext sehen statt nur die Re-Export-Facade.
const read = (p) => {
  const full = path.join(repo, p);
  let src = fs.readFileSync(full, 'utf8');
  const dir = full.replace(/\.js$/, '');
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
      src += '\n' + fs.readFileSync(path.join(dir, f), 'utf8');
    }
  }
  return src;
};

const editSrc = read('public/js/editor/notebook/edit.js');
const storageSrc = read('public/js/editor/notebook/storage.js');
const toolbarSrc = read('public/js/editor/notebook/toolbar.js');

// ── Methoden-Inventar ────────────────────────────────────────────────────────

test('Edit-Mode öffnen: startEdit existiert', () => {
  assert.match(editSrc, /^\s*startEdit\s*\(\)/m, 'startEdit-Methode fehlt');
});

test('Save: saveEdit existiert + ruft PUT', () => {
  assert.match(editSrc, /async saveEdit\s*\(\)/, 'saveEdit-Methode fehlt');
});

test('Quick-Save (Auto-Save während Edit): quickSave existiert', () => {
  assert.match(editSrc, /async quickSave\s*\(\)/, 'quickSave-Methode fehlt');
});

test('Cancel ohne Save: cancelEdit existiert', () => {
  assert.match(editSrc, /async cancelEdit\s*\(\)/, 'cancelEdit-Methode fehlt');
});

test('Dirty-Check: _markEditDirty existiert', () => {
  assert.match(editSrc, /_markEditDirty\s*\(\)/, '_markEditDirty fehlt');
});

// ── Auto-Save-Konstanten ─────────────────────────────────────────────────────

// Die Werte liegen in editor/shared/autosave.js (geteilt mit dem Bucheditor,
// damit beide Editoren im selben Rhythmus speichern); der Notebook-Editor
// re-exportiert sie nur.
const autosaveSrc = read('public/js/editor/shared/autosave.js');

test('Auto-Save: AUTOSAVE_IDLE_MS + AUTOSAVE_MAX_MS deklariert', () => {
  assert.match(autosaveSrc, /const AUTOSAVE_IDLE_MS\s*=\s*\d+/,
    'AUTOSAVE_IDLE_MS fehlt — Idle-Debounce greift sonst nicht');
  assert.match(autosaveSrc, /const AUTOSAVE_MAX_MS\s*=\s*\d+/,
    'AUTOSAVE_MAX_MS fehlt — Dauer-Tipper hat keinen Save-Cap');
  assert.match(editSrc, /export\s*\{[^}]*AUTOSAVE_IDLE_MS[^}]*\}\s*from\s*['"][^'"]*shared\/autosave\.js['"]/,
    'Notebook-Editor muss die geteilten Konstanten beziehen, nicht eigene definieren');
});

test('Auto-Save: IDLE < MAX (sonst Cap nutzlos)', () => {
  const idle = Number(autosaveSrc.match(/const AUTOSAVE_IDLE_MS\s*=\s*(\d+)/)?.[1]);
  const max  = Number(autosaveSrc.match(/const AUTOSAVE_MAX_MS\s*=\s*(\d+)/)?.[1]);
  assert.ok(idle && max, 'Konstanten nicht gefunden');
  assert.ok(idle < max, `IDLE (${idle}) muss < MAX (${max}) sein`);
});

// ── Shared-Lib-Konsum ────────────────────────────────────────────────────────

test('Shared-Lib: getActiveEditorContainer aus shared/active-editor importiert', () => {
  assert.match(editSrc, /from\s+['"](?:\.\.\/)+shared\/active-editor\.js['"]/,
    'Container-Lookup darf nicht auf hartcodiertem #editor-card-Selektor liegen');
});

test('Shared-Lib: stripLektoratMarks aus shared/html-clean importiert', () => {
  assert.match(editSrc, /stripLektoratMarks[\s\S]*from\s+['"](?:\.\.\/)+shared\/html-clean\.js['"]/,
    'Mark-Stripping muss aus shared/ kommen, nicht inline');
});

test('Shared-Lib: savePage aus shared/page-api importiert (Save geht durch den Wrapper)', () => {
  assert.match(editSrc, /\bsavePage\b[\s\S]*from\s+['"](?:\.\.\/)+shared\/page-api\.js['"]/,
    'Save muss durch den page-api-Wrapper laufen (der intern buildSavePayload nutzt), nicht raw contentRepo.savePage');
});

test('Shared-Lib: isPageConflict aus shared/page-api importiert', () => {
  assert.match(editSrc, /isPageConflict[\s\S]*from\s+['"](?:\.\.\/)+shared\/page-api\.js['"]/,
    'Konflikt-Erkennung muss aus shared/page-api');
});

test('Shared-Lib: installEditCounter aus shared/edit-counter importiert', () => {
  assert.match(editSrc, /installEditCounter[\s\S]*from\s+['"](?:\.\.\/)+shared\/edit-counter\.js['"]/,
    'Counter-Setup muss aus shared/edit-counter');
});

// ── Snapshot-Storage ─────────────────────────────────────────────────────────

test('Normal-Snapshot: storage exportiert write/read/clear', () => {
  assert.match(storageSrc, /export function writeNormalSnapshot/, 'writeNormalSnapshot fehlt');
  assert.match(storageSrc, /export function readNormalSnapshot/,  'readNormalSnapshot fehlt');
  assert.match(storageSrc, /export function clearNormalSnapshot/, 'clearNormalSnapshot fehlt');
});

test('Normal-Snapshot: getrennter sessionStorage-Key (kein Overlap mit focus.snapshot)', () => {
  const m = storageSrc.match(/['"]([^'"]*\.snapshot)['"]/);
  assert.ok(m, 'Snapshot-Key nicht gefunden');
  assert.notEqual(m[1], 'focus.snapshot',
    'Normal-Snapshot darf nicht denselben Key wie der Focus-Snapshot nutzen');
});

// ── Toolbar-Sub ──────────────────────────────────────────────────────────────

test('Toolbar: focusActive-Guard (Tabu im Focus)', () => {
  assert.match(toolbarSrc, /focusActive/,
    'Toolbar-Sub muss focusActive prüfen — Toolbar darf im Focus nicht reagieren');
});
