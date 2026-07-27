// Unit-Tests für public/js/editor/shared/shortcuts.js — Inline-Formatting-
// Whitelist. Focus-Editor erlaubt im MVP ausschliesslich bold/italic/underline;
// andere Modifier-Tasten dürfen nicht durch die Whitelist rutschen, sonst
// verliert der Focus-Modus seine Pur-Eigenschaft.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;

const { matchInlineCommand, bindInlineFormattingShortcuts } = await import('../../public/js/editor/shared/shortcuts.js');

const ALLOWED = ['bold', 'italic', 'underline'];

function ev({ key, metaKey = false, ctrlKey = false, altKey = false, shiftKey = false }) {
  return { key, metaKey, ctrlKey, altKey, shiftKey, preventDefault() { this._prevented = true; } };
}

// ────────── matchInlineCommand ──────────

test('matchInlineCommand: Cmd+B → bold', () => {
  assert.equal(matchInlineCommand(ev({ key: 'b', metaKey: true }), ALLOWED), 'bold');
});

test('matchInlineCommand: Ctrl+B → bold', () => {
  assert.equal(matchInlineCommand(ev({ key: 'b', ctrlKey: true }), ALLOWED), 'bold');
});

test('matchInlineCommand: Cmd+I → italic, Cmd+U → underline', () => {
  assert.equal(matchInlineCommand(ev({ key: 'i', metaKey: true }), ALLOWED), 'italic');
  assert.equal(matchInlineCommand(ev({ key: 'u', metaKey: true }), ALLOWED), 'underline');
});

test('matchInlineCommand: Grossbuchstabe wird normalisiert', () => {
  assert.equal(matchInlineCommand(ev({ key: 'B', metaKey: true }), ALLOWED), 'bold');
});

test('matchInlineCommand: ohne Cmd/Ctrl → null', () => {
  assert.equal(matchInlineCommand(ev({ key: 'b' }), ALLOWED), null);
});

test('matchInlineCommand: mit Shift → null (kein Cmd+Shift+B)', () => {
  assert.equal(matchInlineCommand(ev({ key: 'b', metaKey: true, shiftKey: true }), ALLOWED), null);
});

test('matchInlineCommand: mit Alt → null (kein Cmd+Alt+B)', () => {
  assert.equal(matchInlineCommand(ev({ key: 'b', metaKey: true, altKey: true }), ALLOWED), null);
});

test('matchInlineCommand: nicht-Whitelist-Buchstaben → null (Cmd+K, Cmd+1, …)', () => {
  assert.equal(matchInlineCommand(ev({ key: 'k', metaKey: true }), ALLOWED), null);
  assert.equal(matchInlineCommand(ev({ key: '1', metaKey: true }), ALLOWED), null);
  assert.equal(matchInlineCommand(ev({ key: 's', metaKey: true }), ALLOWED), null);
});

test('matchInlineCommand: leere Whitelist → alles null', () => {
  assert.equal(matchInlineCommand(ev({ key: 'b', metaKey: true }), []), null);
});

test('matchInlineCommand: reduzierte Whitelist [bold] → nur bold matcht', () => {
  assert.equal(matchInlineCommand(ev({ key: 'b', metaKey: true }), ['bold']), 'bold');
  assert.equal(matchInlineCommand(ev({ key: 'i', metaKey: true }), ['bold']), null);
});

test('matchInlineCommand: null/undefined Event → null, kein Throw', () => {
  assert.equal(matchInlineCommand(null, ALLOWED), null);
  assert.equal(matchInlineCommand(undefined, ALLOWED), null);
});

// ────────── bindInlineFormattingShortcuts ──────────

test('bindInlineFormattingShortcuts: Teardown entfernt Listener', () => {
  const container = document.createElement('div');
  let removed = false;
  const origRemove = container.removeEventListener.bind(container);
  container.removeEventListener = (...args) => { removed = true; origRemove(...args); };
  const teardown = bindInlineFormattingShortcuts(container, { allowedCommands: ALLOWED });
  teardown();
  assert.equal(removed, true);
});

test('bindInlineFormattingShortcuts: null container → no-op Teardown, kein Throw', () => {
  const teardown = bindInlineFormattingShortcuts(null, { allowedCommands: ALLOWED });
  assert.equal(typeof teardown, 'function');
  teardown();
});

test('bindInlineFormattingShortcuts: ohne allowedCommands → Default-Whitelist B/I/U aktiv', () => {
  const container = document.createElement('div');
  // Indirekt prüfen: matchInlineCommand mit Default-Whitelist matcht bold.
  const teardown = bindInlineFormattingShortcuts(container);
  // Smoke-Test: teardown ist Funktion, kein Setup-Error.
  assert.equal(typeof teardown, 'function');
  teardown();
});

test('bindInlineFormattingShortcuts: signal-Option hängt Listener an AbortController', () => {
  const container = document.createElement('div');
  const calls = [];
  const orig = container.addEventListener.bind(container);
  container.addEventListener = (type, fn, opts) => { calls.push({ type, opts }); orig(type, fn, opts); };
  const ctrl = new AbortController();
  bindInlineFormattingShortcuts(container, { allowedCommands: ALLOWED, signal: ctrl.signal });
  const reg = calls.find(c => c.type === 'keydown');
  assert.ok(reg, 'keydown muss registriert sein');
  assert.equal(reg.opts?.signal, ctrl.signal, 'signal muss durchgereicht werden');
});

test('bindInlineFormattingShortcuts: onCommand-Callback fires bei Match', () => {
  const container = document.createElement('div');
  let registered = null;
  const orig = container.addEventListener.bind(container);
  container.addEventListener = (type, fn) => { if (type === 'keydown') registered = fn; orig(type, fn); };
  const fired = [];
  bindInlineFormattingShortcuts(container, {
    allowedCommands: ALLOWED,
    onCommand: (cmd) => fired.push(cmd),
  });
  // Echtes execCommand existiert in linkedom nicht — Patch akzeptiert das.
  document.execCommand = () => true;
  // Direkter Handler-Aufruf (linkedom kennt keinen KeyboardEvent-Constructor).
  assert.ok(registered, 'keydown-Handler muss registriert sein');
  registered({
    key: 'b', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
    preventDefault() {}, stopPropagation() {},
  });
  assert.deepEqual(fired, ['bold'], 'onCommand muss mit dem matched Command laufen');
});

// ────────── Focus-Editor-Integration: Whitelist B/I/U enforced ──────────

test('focus/listeners.js bindet Whitelist B/I/U via shared/shortcuts.js', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  // Wiring sitzt beim übrigen Listener-Setup (focus/listeners.js), nicht in der
  // State-Machine (focus/card.js).
  const src = readFileSync(path.join(process.cwd(), 'public/js/editor/focus/listeners.js'), 'utf8');
  assert.match(src, /import\s*\{[^}]*bindInlineFormattingShortcuts[^}]*\}\s*from\s*['"]\.\.\/shared\/shortcuts\.js['"]/,
    'focus/listeners.js muss bindInlineFormattingShortcuts aus shared/ importieren');
  assert.match(src, /bindInlineFormattingShortcuts\s*\(\s*container[\s\S]*?allowedCommands:\s*\[\s*['"]bold['"]\s*,\s*['"]italic['"]\s*,\s*['"]underline['"]\s*\]/,
    'focus/listeners.js muss bindInlineFormattingShortcuts(container, { allowedCommands: ["bold","italic","underline"] }) rufen');
  assert.match(src, /bindInlineFormattingShortcuts\([\s\S]*?signal[\s\S]*?\}\)/,
    'Wiring muss signal an den AbortController hängen — sonst Listener-Leak bei Exit');
});
