// Unit-Tests für public/js/editor/shared/ — Save-Pipeline und HTML-Cleaner.
// Beide Editoren rufen diese Pure-Funktionen; bricht hier etwas, brechen
// Dirty-Check und Save-Vergleich für Normal- wie Focus-Editor.
//
// Setup: linkedom liefert ein Browser-kompatibles DOM (createElement,
// DOMParser, querySelectorAll, innerHTML-Get). Globals werden vor dem
// dynamischen Import gesetzt, damit das Modul beim Parsing den DOM kennt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

// Browser-Globals via linkedom installieren. matchMedia/addEventListener-Stubs
// brauchen wir, weil utils.js beim Modulladen window-APIs touch'en kann.
const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
if (!window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
}

// linkedom's DOMParser ist für 'text/html'-Fragmente nicht spec-konform
// (siehe https://github.com/WebReflection/linkedom — DOMParser wickelt das
// Fragment nicht korrekt in <body> wie Browser-DOMParser). Stub: parseHTML
// neu pro Aufruf, body wird mit dem Input befüllt.
class StubDOMParser {
  parseFromString(html, _type) {
    const wrapped = `<!doctype html><html><body>${html}</body></html>`;
    return parseHTML(wrapped).document;
  }
}
globalThis.DOMParser = StubDOMParser;

const {
  stripLektoratMarks,
  normalizeForCompare,
  normalizeEditorBlocks,
} = await import('../../public/js/editor/shared/html-clean.js');
const { buildSavePayload, isNoChange } = await import('../../public/js/editor/shared/save-pipeline.js');
const { ensureTrailingParagraph, removeAutoAddedParagraph } = await import('../../public/js/editor/shared/auto-slot.js');

// ────────── stripLektoratMarks ──────────

test('stripLektoratMarks: unwrappt .lektorat-mark, behält Originaltext', () => {
  const html = '<p><span class="lektorat-mark">Hallo</span> Welt</p>';
  const out = stripLektoratMarks(html);
  assert.equal(out.indexOf('lektorat-mark'), -1);
  assert.ok(out.indexOf('Hallo') !== -1);
  assert.ok(out.indexOf('Welt') !== -1);
});

test('stripLektoratMarks: entfernt .lektorat-ins komplett (Vorschlagstext weg)', () => {
  const html = '<p>Original<span class="lektorat-ins">VORSCHLAG</span></p>';
  const out = stripLektoratMarks(html);
  assert.equal(out.indexOf('lektorat-ins'), -1);
  assert.equal(out.indexOf('VORSCHLAG'), -1);
  assert.ok(out.indexOf('Original') !== -1);
});

test('stripLektoratMarks: unwrappt .chat-mark und entfernt .chat-mark-ins', () => {
  const html = '<p><span class="chat-mark">A</span><span class="chat-mark-ins">B</span>C</p>';
  const out = stripLektoratMarks(html);
  assert.equal(out.indexOf('chat-mark'), -1);
  assert.equal(out.indexOf('B'), -1);
  assert.ok(out.indexOf('A') !== -1);
  assert.ok(out.indexOf('C') !== -1);
});

test('stripLektoratMarks: keine Marks → trotzdem Cleaner-Pipeline (Empty-Trailing weg)', () => {
  const html = '<p>Text</p><p></p>';
  const out = stripLektoratMarks(html);
  assert.ok(out.indexOf('<p>Text</p>') !== -1);
});

test('stripLektoratMarks: leerer String → leerer String, kein Throw', () => {
  assert.equal(stripLektoratMarks(''), '');
});

// LanguageTool-UI lebt als Kind im contenteditable — bei offenem Popover
// gespeichert landete sie sonst als Inhalt in der Revision.
test('stripLektoratMarks: entfernt .lt-popover komplett (Buttons + Text weg)', () => {
  const html = '<p>Der Jungen ging</p>'
    + '<div class="lt-popover" role="dialog" contenteditable="false">'
    + '<div class="lt-popover__header"><span class="lt-popover__badge">Typo</span>'
    + '<button class="lt-popover__close" aria-label="Schliessen">×</button></div>'
    + '<div class="lt-popover__replacements"><button class="lt-popover__replacement">Junge</button></div>'
    + '</div>';
  const out = stripLektoratMarks(html);
  assert.equal(out.indexOf('lt-popover'), -1);
  assert.equal(out.indexOf('<button'), -1);
  assert.equal(out.indexOf('Junge<'), -1, 'Vorschlagstext darf nicht als Inhalt bleiben');
  assert.ok(out.indexOf('Der Jungen ging') !== -1);
});

test('stripLektoratMarks: entfernt .lt-badge komplett', () => {
  const html = '<p>Text</p><div class="lt-badge" data-state="matches"><span class="lt-badge__label">3</span></div>';
  const out = stripLektoratMarks(html);
  assert.equal(out.indexOf('lt-badge'), -1);
  assert.equal(out.indexOf('>3<'), -1);
  assert.ok(out.indexOf('<p>Text</p>') !== -1);
});

// Regression: Ohne lt-Trigger in der hasMark/hasIns-Bedingung greift der
// Early-Return und der Filter läuft nie.
test('stripLektoratMarks: lt-Markup ohne Lektorat-Marks wird trotzdem gefiltert', () => {
  const out = stripLektoratMarks('<p>A</p><div class="lt-popover">X</div>');
  assert.equal(out.indexOf('lt-popover'), -1);
});

test('normalizeForCompare: lt-Popover kippt den Dirty-Vergleich nicht', () => {
  const clean = '<p>Der Jungen ging</p>';
  const withUi = '<p>Der Jungen ging</p><div class="lt-popover"><button class="lt-popover__close">×</button></div>';
  assert.equal(normalizeForCompare(withUi), normalizeForCompare(clean));
});

// ────────── normalizeEditorBlocks ──────────

test('normalizeEditorBlocks: orphan Text-Node wird in <p> gewrapt', () => {
  const div = document.createElement('div');
  // linkedom: innerHTML-Setter ist erlaubt im Test-Setup (kein Live-DOM)
  div.append('Bare Text', document.createElement('p'));
  div.children[0]?.append?.('Para');
  normalizeEditorBlocks(div);
  // Erstes Kind muss jetzt ein <p> sein (gewrapter Text)
  assert.equal(div.firstElementChild.tagName, 'P');
});

test('normalizeEditorBlocks: idempotent (zweiter Lauf macht nichts)', () => {
  const div = document.createElement('div');
  const p = document.createElement('p');
  p.textContent = 'A';
  div.appendChild(p);
  normalizeEditorBlocks(div);
  const after = div.innerHTML;
  normalizeEditorBlocks(div);
  assert.equal(div.innerHTML, after);
});

// ────────── normalizeForCompare ──────────

test('normalizeForCompare: identische HTML-Form bleibt stabil', () => {
  const a = '<p>Hallo</p>';
  assert.equal(normalizeForCompare(a), normalizeForCompare(a));
});

test('normalizeForCompare: leerer Input → leerer String', () => {
  assert.equal(normalizeForCompare(''), '');
  assert.equal(normalizeForCompare(null), '');
});

test('normalizeForCompare: orphan Text wird normalisiert (verpackt in <p>)', () => {
  const raw = 'Bare<p>Para</p>';
  const out = normalizeForCompare(raw);
  assert.ok(out.indexOf('<p>') === 0);
});

// ────────── buildSavePayload ──────────

test('buildSavePayload: liefert Pflichtfelder + erwartete Form', () => {
  const p = buildSavePayload({
    html: '<p>x</p>',
    pageName: 'Page 1',
    source: 'main',
    expectedUpdatedAt: '2026-05-20T10:00:00.000Z',
  });
  assert.deepEqual(p, {
    html: '<p>x</p>',
    name: 'Page 1',
    source: 'main',
    expected_updated_at: '2026-05-20T10:00:00.000Z',
  });
});

test('buildSavePayload: source=focus akzeptiert', () => {
  const p = buildSavePayload({ html: '', pageName: 'P', source: 'focus' });
  assert.equal(p.source, 'focus');
  assert.equal(p.expected_updated_at, null);
});

test('buildSavePayload: wirft bei fehlendem html', () => {
  assert.throws(() => buildSavePayload({ pageName: 'P', source: 'main' }), /html required/);
});

test('buildSavePayload: wirft bei fehlendem pageName', () => {
  assert.throws(() => buildSavePayload({ html: '', source: 'main' }), /pageName required/);
});

test('buildSavePayload: wirft bei ungültigem source', () => {
  assert.throws(() => buildSavePayload({ html: '', pageName: 'P', source: 'both' }), /invalid source/);
  assert.throws(() => buildSavePayload({ html: '', pageName: 'P' }), /invalid source/);
});

// ────────── isNoChange ──────────

test('isNoChange: identische Strings → true (Fast-Path)', () => {
  assert.equal(isNoChange('<p>a</p>', '<p>a</p>'), true);
});

test('isNoChange: leere Originalfassung + leerer current → true', () => {
  assert.equal(isNoChange('', ''), true);
});

test('isNoChange: semantisch identisch via normalizeForCompare → true', () => {
  // current (Browser) hat normalisierte Form, original (Server) hat orphan Text
  const original = 'Bare<p>X</p>';
  const current = normalizeForCompare(original);
  assert.equal(isNoChange(current, original), true);
});

test('isNoChange: wirklich anderer Text → false', () => {
  assert.equal(isNoChange('<p>a</p>', '<p>b</p>'), false);
});

// ────────── ensureTrailingParagraph / removeAutoAddedParagraph ──────────

test('ensureTrailingParagraph: leerer <p> wird mit <br> recycled (kein Add)', () => {
  const div = document.createElement('div');
  const p = document.createElement('p');
  div.appendChild(p);
  const added = ensureTrailingParagraph(div);
  assert.equal(added, null);
  assert.equal(div.lastElementChild.firstElementChild.tagName, 'BR');
});

test('ensureTrailingParagraph: nicht-leerer Block → neuer <p><br></p> angehängt', () => {
  const div = document.createElement('div');
  const p = document.createElement('p');
  p.textContent = 'Inhalt';
  div.appendChild(p);
  const added = ensureTrailingParagraph(div);
  assert.ok(added);
  assert.equal(added.tagName, 'P');
  assert.equal(div.lastElementChild, added);
  assert.equal(added.firstElementChild.tagName, 'BR');
});

test('ensureTrailingParagraph: leerer Container → neuer <p><br></p>', () => {
  const div = document.createElement('div');
  const added = ensureTrailingParagraph(div);
  assert.ok(added);
  assert.equal(div.children.length, 1);
});

test('removeAutoAddedParagraph: leerer Slot wird entfernt', () => {
  const div = document.createElement('div');
  const added = ensureTrailingParagraph(div);
  removeAutoAddedParagraph(added);
  assert.equal(div.children.length, 0);
});

test('removeAutoAddedParagraph: befüllter Slot bleibt stehen', () => {
  const div = document.createElement('div');
  const p1 = document.createElement('p'); p1.textContent = 'A';
  div.appendChild(p1);
  const added = ensureTrailingParagraph(div);
  added.textContent = 'User hat reingeschrieben';
  removeAutoAddedParagraph(added);
  assert.equal(div.children.length, 2);
});

test('removeAutoAddedParagraph: nbsp-only Slot gilt als leer → entfernt', () => {
  const div = document.createElement('div');
  const added = ensureTrailingParagraph(div);
  added.textContent = ' ';
  removeAutoAddedParagraph(added);
  assert.equal(div.children.length, 0);
});

test('removeAutoAddedParagraph: null/undefined → kein Throw', () => {
  removeAutoAddedParagraph(null);
  removeAutoAddedParagraph(undefined);
});
