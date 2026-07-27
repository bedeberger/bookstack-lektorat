// Tests für editor/focus/chrome.js (Granularitäts-SSoT) und den geteilten
// Hotkey-Chord aus editor/focus/constants.js.
//
// Beide sind die Stellen, an denen zuvor identische Logik mehrfach im Baum lag:
// die `focus-mode--*`-Klassenliste in card.js + Karte + standalone.js, der
// Cmd/Ctrl+Shift+E-Chord in trampoline.js + listeners.js. Die Tests halten die
// Bündelung fest, damit ein neuer Modus bzw. eine geänderte Taste nicht wieder
// auseinanderläuft.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { GRANULARITIES, normGranularity, applyGranularity } =
  await import('../../public/js/editor/focus/chrome.js');
const { isFocusToggleChord } =
  await import('../../public/js/editor/focus/constants.js');

// --- normGranularity --------------------------------------------------------

test('GRANULARITIES deckt genau die vier dokumentierten Modi ab', () => {
  assert.deepEqual(GRANULARITIES,
    ['paragraph', 'sentence', 'window-3', 'typewriter-only']);
});

test('normGranularity: bekannte Modi bleiben unverändert', () => {
  for (const g of GRANULARITIES) assert.equal(normGranularity(g), g);
});

test('normGranularity: unbekannt/leer → paragraph', () => {
  // Ein klassenloser Cardroot wäre optisch wirkungslos (kein Dimming, kein
  // Spotlight) — deshalb ist der Fallback Pflicht, kein Durchreichen.
  assert.equal(normGranularity('quatsch'), 'paragraph');
  assert.equal(normGranularity(undefined), 'paragraph');
  assert.equal(normGranularity(null), 'paragraph');
  assert.equal(normGranularity(''), 'paragraph');
});

// --- applyGranularity -------------------------------------------------------

function mkFocusEl() {
  const set = new Set();
  return {
    _set: set,
    classList: {
      add: (...cs) => cs.forEach(c => set.add(c)),
      remove: (...cs) => cs.forEach(c => set.delete(c)),
      contains: (c) => set.has(c),
    },
  };
}

function mkRoot(focusEl) {
  return { querySelector: (sel) => (sel === '.focus-editor' ? focusEl : null) };
}

test('applyGranularity: setzt genau eine focus-mode--Klasse', () => {
  const el = mkFocusEl();
  applyGranularity('window-3', mkRoot(el));
  const modeClasses = [...el._set].filter(c => c.startsWith('focus-mode--'));
  assert.deepEqual(modeClasses, ['focus-mode--window-3']);
});

test('applyGranularity: tauscht die alte Klasse aus, statt zu stapeln', () => {
  const el = mkFocusEl();
  const root = mkRoot(el);
  applyGranularity('sentence', root);
  applyGranularity('typewriter-only', root);
  const modeClasses = [...el._set].filter(c => c.startsWith('focus-mode--'));
  assert.deepEqual(modeClasses, ['focus-mode--typewriter-only']);
});

test('applyGranularity: fremde Klassen am Cardroot bleiben stehen', () => {
  const el = mkFocusEl();
  el.classList.add('focus-editor', 'is-active');
  applyGranularity('paragraph', mkRoot(el));
  assert.equal(el.classList.contains('is-active'), true);
  assert.equal(el.classList.contains('focus-editor'), true);
});

test('applyGranularity: liefert den normalisierten Modus zurück', () => {
  assert.equal(applyGranularity('bloedsinn', mkRoot(mkFocusEl())), 'paragraph');
  assert.equal(applyGranularity('sentence', mkRoot(mkFocusEl())), 'sentence');
});

test('applyGranularity: fehlender Cardroot → kein Wurf', () => {
  assert.doesNotThrow(() => applyGranularity('sentence', mkRoot(null)));
  assert.doesNotThrow(() => applyGranularity('sentence', null));
});

// --- isFocusToggleChord -----------------------------------------------------

const chord = (over = {}) => ({
  ctrlKey: false, metaKey: false, shiftKey: true, altKey: false,
  code: 'KeyE', ...over,
});

test('isFocusToggleChord: Ctrl+Shift+E und Cmd+Shift+E', () => {
  assert.equal(isFocusToggleChord(chord({ ctrlKey: true })), true);
  assert.equal(isFocusToggleChord(chord({ metaKey: true })), true);
});

test('isFocusToggleChord: ohne Modifier / ohne Shift / mit Alt → nein', () => {
  assert.equal(isFocusToggleChord(chord()), false);
  assert.equal(isFocusToggleChord(chord({ ctrlKey: true, shiftKey: false })), false);
  assert.equal(isFocusToggleChord(chord({ ctrlKey: true, altKey: true })), false);
});

test('isFocusToggleChord: andere Taste → nein', () => {
  assert.equal(isFocusToggleChord(chord({ ctrlKey: true, code: 'KeyF' })), false);
});

test('isFocusToggleChord: kein Event → nein', () => {
  assert.equal(isFocusToggleChord(null), false);
  assert.equal(isFocusToggleChord(undefined), false);
});
