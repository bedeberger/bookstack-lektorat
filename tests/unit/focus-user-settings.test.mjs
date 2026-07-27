// User-Settings ↔ Focus-Granularität — Load/Save/Spiegelung.
//
// Granularität ist das einzige Focus-spezifische Settings-Feld, das nicht
// am Card-Lifecycle hängt: User schaltet sie im Profil um, Live-Watch in
// editor-focus-card.js#init wendet sie sofort an. Tests greppen statisch
// am Source, damit Refactors der Settings-Pipeline drift-sicher bleiben.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

const settingsSrc    = read('public/js/user-settings.js');
const settingsCardSrc = read('public/js/cards/user-settings-card.js');
const focusCardSrc   = read('public/js/cards/editor-focus-card.js');
const focusModuleSrc = read('public/js/editor/focus/card.js');
const stateSrc       = read('public/js/app/app-state.js');

// ── Load: Server-Antwort → userSettingsFocusGranularity ─────────────────────

test('loadUserSettings liest focus_granularity aus /me/settings', () => {
  assert.match(settingsSrc, /userSettingsFocusGranularity\s*=\s*data\.focus_granularity/,
    'Load-Pfad muss data.focus_granularity in userSettingsFocusGranularity übernehmen');
});

test('loadUserSettings fällt bei fehlendem Wert auf "paragraph" zurück', () => {
  assert.match(settingsSrc, /data\.focus_granularity\s*\|\|\s*['"]paragraph['"]/,
    'Default-Granularität (paragraph) muss als Fallback gesetzt sein');
});

// ── Save: PATCH /me/settings inkl. focus_granularity ────────────────────────

test('saveUserSettings sendet focus_granularity im PATCH-Body', () => {
  assert.match(settingsSrc, /focus_granularity:\s*this\.userSettingsFocusGranularity/,
    'PATCH-Body muss focus_granularity enthalten — sonst wird das Setting nie persistiert');
});

test('saveUserSettings spiegelt focus_granularity in window.__app.focusGranularity', () => {
  assert.match(settingsSrc, /window\.__app\.focusGranularity\s*=\s*this\.userSettingsFocusGranularity/,
    'Save muss focusGranularity im Root spiegeln — ohne diese Zeile greift der Live-Watch nicht');
});

// ── Optionen-Liste: alle vier Granularitäten ────────────────────────────────

test('userSettingsFocusOptions liefert alle vier Granularitäten', () => {
  const m = settingsSrc.match(/userSettingsFocusOptions\s*\(\)\s*\{[\s\S]*?return\s*\[([\s\S]*?)\];/);
  assert.ok(m, 'userSettingsFocusOptions nicht gefunden');
  const body = m[1];
  for (const v of ['paragraph', 'sentence', 'window-3', 'typewriter-only']) {
    assert.match(body, new RegExp(`value:\\s*['"]${v.replace(/-/g, '\\-')}['"]`),
      `Granularitäts-Wert "${v}" fehlt in Optionen — Plan-Inventar bricht`);
  }
});

// ── State-Slice ─────────────────────────────────────────────────────────────

test('shellState führt focusGranularity (Root-SSoT)', () => {
  assert.match(stateSrc, /focusGranularity:\s*['"]paragraph['"]/,
    'shellState muss focusGranularity mit Default "paragraph" deklarieren');
});

test('userSettingsCard initialisiert userSettingsFocusGranularity', () => {
  assert.match(settingsCardSrc, /userSettingsFocusGranularity:\s*['"]paragraph['"]/,
    'Card-State muss initialen Wert "paragraph" haben');
});

// ── Live-Effekt: $watch in editor-focus-card.js + Klassen-Switch ────────────

test('editor-focus-card.js wacht $watch focusGranularity und delegiert an die SSoT', () => {
  assert.match(focusCardSrc, /\$watch\s*\(\s*\(\)\s*=>\s*window\.__app\?\.focusGranularity/,
    '$watch auf focusGranularity fehlt — Settings-Wechsel wirkt sonst nicht live');
  assert.match(focusCardSrc, /applyFocusGranularity/,
    'Karte muss die Umschaltung an applyFocusGranularity abgeben, nicht selbst Klassen setzen');
});

// ── Granularitäts-Klassenliste: genau EINE Definition im Produktivcode ──────

test('Klassenliste focus-mode--* lebt ausschliesslich in focus/chrome.js', () => {
  // Drei Aufrufer schalten die Granularität um (Eintritt, SPA-$watch,
  // standalone.js#setGranularity). Buchstabiert einer die Klassen selbst, muss
  // ein neuer Modus an mehreren Stellen nachgezogen werden — genau die Drift,
  // die die Erweitern-Checkliste in docs/focus-editor.md nicht auffängt.
  const chromeSrc = read('public/js/editor/focus/chrome.js');
  assert.match(chromeSrc, /GRANULARITIES\s*=\s*\[\s*'paragraph',\s*'sentence',\s*'window-3',\s*'typewriter-only'\s*\]/,
    'chrome.js muss GRANULARITIES als einzige Modus-Liste führen');
  assert.match(chromeSrc, /GRANULARITY_CLASSES\s*=\s*GRANULARITIES\.map/,
    'Klassenliste muss aus GRANULARITIES abgeleitet sein, nicht parallel gepflegt');

  const others = [
    'public/js/editor/focus/card.js',
    'public/js/editor/focus/standalone.js',
    'public/js/cards/editor-focus-card.js',
  ];
  for (const f of others) {
    assert.doesNotMatch(read(f), /focus-mode--(paragraph|sentence|window-3|typewriter-only)/,
      `${f} darf die Granularitäts-Klassen nicht selbst buchstabieren (SSoT ist focus/chrome.js)`);
  }
});

test('applyGranularity setzt die Klasse am Focus-Cardroot, nicht am body', () => {
  const chromeSrc = read('public/js/editor/focus/chrome.js');
  const fn = chromeSrc.match(/export function applyGranularity[\s\S]*?\n\}/);
  assert.ok(fn, 'applyGranularity nicht gefunden');
  assert.match(fn[0], /querySelector\?\.\(\s*['"]\.focus-editor['"]/,
    'Granularität gehört auf .focus-editor — der Dim-Selektor scoped darüber');
  assert.doesNotMatch(fn[0], /document\.body/,
    'Body-Class focus-mode--* ist Legacy; Granularität gehört auf .focus-editor');
});

// ── enterFocusMode setzt Initial-Granularität auf Cardroot ───────────────────

test('Eintritt hängt focus-mode--<granularity> initial an .focus-editor', () => {
  // Chrome-Setup (body-/Host-Klassen, Granularität, --focus-anchor) liegt in
  // focus/chrome.js; enterFocusMode ruft markFocusChrome mit der Host-Granularität.
  const chromeSrc = read('public/js/editor/focus/chrome.js');
  const mark = chromeSrc.match(/export function markFocusChrome\s*\([\s\S]*?\n\}/);
  assert.ok(mark, 'markFocusChrome nicht gefunden');
  assert.match(mark[0], /applyGranularity\s*\(\s*granularity\s*\)/,
    'markFocusChrome muss die Granularität über applyGranularity setzen');
  assert.match(focusModuleSrc, /markFocusChrome\s*\(\s*app\.focusGranularity\s*,\s*app\.typewriterAnchor\s*\)/,
    'enterFocusMode muss markFocusChrome(app.focusGranularity, app.typewriterAnchor) rufen');
});
