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

test('editor-focus-card.js wacht $watch focusGranularity und schaltet Cardroot-Klasse', () => {
  assert.match(focusCardSrc, /\$watch\s*\(\s*\(\)\s*=>\s*window\.__app\?\.focusGranularity/,
    '$watch auf focusGranularity fehlt — Settings-Wechsel wirkt sonst nicht live');
  assert.match(focusCardSrc, /focus-mode--paragraph[\s\S]*focus-mode--sentence[\s\S]*focus-mode--window-3[\s\S]*focus-mode--typewriter-only/,
    'Live-Switch muss alle vier Granularitäts-Klassen abräumen vor dem Set');
});

test('Klasse hängt am Focus-Cardroot, nicht am body (Schritt 1+ Architektur)', () => {
  const watchBlock = focusCardSrc.match(/\$watch\s*\(\s*\(\)\s*=>\s*window\.__app\?\.focusGranularity[\s\S]*?\}\s*\)\s*;/);
  assert.ok(watchBlock, '$watch-Block nicht gefunden');
  assert.match(watchBlock[0], /querySelector\s*\(\s*['"]\.focus-editor['"]/,
    'Granularität muss auf .focus-editor gesetzt werden, nicht auf body — sonst greift Scope-Refactor nicht');
  assert.doesNotMatch(watchBlock[0], /document\.body\.classList\.add\s*\(\s*['"]focus-mode--/,
    'Body-Class focus-mode--* ist Legacy; Granularität gehört auf .focus-editor');
});

// ── enterFocusMode setzt Initial-Granularität auf Cardroot ───────────────────

test('Eintritt hängt focus-mode--<granularity> initial an .focus-editor', () => {
  // Chrome-Setup (body-/Host-Klassen, Granularität, --focus-anchor) liegt im
  // Helper markFocusChrome; enterFocusMode ruft ihn mit der Host-Granularität.
  const mark = focusModuleSrc.match(/function markFocusChrome\s*\([\s\S]*?\n\}/);
  assert.ok(mark, 'markFocusChrome nicht gefunden');
  assert.match(mark[0], /querySelector\s*\(\s*['"]\.focus-editor['"]/,
    'markFocusChrome muss die Granularitäts-Klasse am .focus-editor setzen');
  assert.match(mark[0], /focus-mode--['"]\s*\+\s*\(\s*granularity/,
    'Granularitäts-Klasse muss aus der übergebenen Granularität gebaut werden');
  assert.match(focusModuleSrc, /markFocusChrome\s*\(\s*app\.focusGranularity\s*,\s*app\.typewriterAnchor\s*\)/,
    'enterFocusMode muss markFocusChrome(app.focusGranularity, app.typewriterAnchor) rufen');
});
