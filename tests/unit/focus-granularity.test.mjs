// Tests für Granularitäts-Helpers in editor/focus.js: setNearBlocks,
// findSentenceRanges. Sentence-Highlight-Range-Bau braucht echtes DOM und
// wird in den E2E-Tests verifiziert.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  setNearBlocks,
  findSentenceRanges,
} = await import('../../public/js/editor/focus.js');

// --- setNearBlocks ----------------------------------------------------------

function mkClassList() {
  const set = new Set();
  return {
    _set: set,
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    get length() { return set.size; },
  };
}

function mkBlock(matchesSel = true) {
  const attrs = new Map();
  return {
    nodeType: 1,
    classList: mkClassList(),
    matches: () => matchesSel,
    previousElementSibling: null,
    nextElementSibling: null,
    removeAttribute: (k) => attrs.delete(k),
  };
}

function mkContainer(allBlocks) {
  return {
    querySelectorAll: () => allBlocks.filter(b => b.classList.contains('focus-paragraph-near')),
  };
}

test('setNearBlocks: markiert direktes prev + next Geschwister', () => {
  const prev = mkBlock();
  const active = mkBlock();
  const next = mkBlock();
  active.previousElementSibling = prev;
  active.nextElementSibling = next;
  const container = mkContainer([prev, active, next]);

  setNearBlocks(container, active);
  assert.equal(prev.classList.contains('focus-paragraph-near'), true);
  assert.equal(next.classList.contains('focus-paragraph-near'), true);
  assert.equal(active.classList.contains('focus-paragraph-near'), false,
    'aktiver Block wird nicht zusätzlich als near markiert');
});

test('setNearBlocks: räumt vorherige near-Klassen ab', () => {
  const old = mkBlock();
  old.classList.add('focus-paragraph-near');
  const active = mkBlock();
  const container = mkContainer([old, active]);

  setNearBlocks(container, active);
  assert.equal(old.classList.contains('focus-paragraph-near'), false,
    'verwaiste near-Klassen müssen weg, sonst Geister-Highlights');
});

test('setNearBlocks: block=null → alle near-Klassen weg', () => {
  const a = mkBlock();
  a.classList.add('focus-paragraph-near');
  const container = mkContainer([a]);

  setNearBlocks(container, null);
  assert.equal(a.classList.contains('focus-paragraph-near'), false);
});

test('setNearBlocks: überspringt Nicht-Block-Geschwister', () => {
  // BookStack-HTML kann Nicht-Block-Knoten zwischen Absätzen einstreuen
  // (Whitespace-Text, Inline-Tags). matches() liefert dann false → weiter
  // suchen, sonst würde der „aktive Absatz" keine markierten Nachbarn haben.
  const prev = mkBlock();
  const skipPrev = mkBlock(false);
  skipPrev.previousElementSibling = prev;
  const active = mkBlock();
  active.previousElementSibling = skipPrev;
  const container = mkContainer([prev, skipPrev, active]);

  setNearBlocks(container, active);
  assert.equal(prev.classList.contains('focus-paragraph-near'), true);
  assert.equal(skipPrev.classList.contains('focus-paragraph-near'), false);
});

test('setNearBlocks: null-container → no-op', () => {
  setNearBlocks(null, null);
  setNearBlocks(null, mkBlock());
});

// --- marks-Zustandsspeicher (Vollscan-Ersparnis ausserhalb von window-3) -----

function mkCountingContainer(allBlocks) {
  const c = {
    scans: 0,
    querySelectorAll: () => {
      c.scans++;
      return allBlocks.filter(b => b.classList.contains('focus-paragraph-near'));
    },
  };
  return c;
}

test('setNearBlocks: marks spiegelt, ob near-Marks gesetzt sind', () => {
  const prev = mkBlock();
  const next = mkBlock();
  const active = mkBlock();
  active.previousElementSibling = prev;
  active.nextElementSibling = next;
  const container = mkContainer([prev, next, active]);
  const marks = { near: false };

  assert.equal(setNearBlocks(container, active, marks), true);
  assert.equal(marks.near, true);

  assert.equal(setNearBlocks(container, null, marks), false);
  assert.equal(marks.near, false);
});

test('setNearBlocks: kein Block gewünscht + nichts gesetzt → kein Vollscan', () => {
  const container = mkCountingContainer([]);
  const marks = { near: false };
  setNearBlocks(container, null, marks);
  setNearBlocks(container, null, marks);
  assert.equal(container.scans, 0, 'darf den Baum gar nicht erst absuchen');
});

test('setNearBlocks: ohne marks bleibt der Vollscan (Abräum-Garantie)', () => {
  const container = mkCountingContainer([]);
  setNearBlocks(container, null);
  assert.equal(container.scans, 1);
});

test('setNearBlocks: nach window-3 → einmal noch scannen, dann ruhig', () => {
  const prev = mkBlock();
  const active = mkBlock();
  active.previousElementSibling = prev;
  const all = [prev, active];
  const container = mkCountingContainer(all);
  const marks = { near: false };

  setNearBlocks(container, active, marks);          // window-3: markiert prev
  assert.equal(prev.classList.contains('focus-paragraph-near'), true);

  const afterMark = container.scans;
  setNearBlocks(container, null, marks);            // Wechsel auf paragraph
  assert.equal(prev.classList.contains('focus-paragraph-near'), false);
  assert.equal(container.scans, afterMark + 1, 'ein Abräum-Scan');

  setNearBlocks(container, null, marks);            // weitere Ticks
  setNearBlocks(container, null, marks);
  assert.equal(container.scans, afterMark + 1, 'danach kein Scan mehr');
});

// --- findSentenceRanges -----------------------------------------------------

test('findSentenceRanges: leerer Text → leeres Array', () => {
  assert.deepEqual(findSentenceRanges(''), []);
});

test('findSentenceRanges: einzelner Satz', () => {
  const r = findSentenceRanges('Hallo Welt.');
  assert.equal(r.length, 1);
  assert.equal(r[0][0], 0);
  assert.equal(r[0][1], 11);
});

test('findSentenceRanges: drei Sätze, korrekte Offsets', () => {
  const txt = 'Erster Satz. Zweiter Satz! Dritter Satz?';
  const r = findSentenceRanges(txt);
  assert.equal(r.length, 3, 'drei Sätze erwartet, got=' + r.length);
  // Slice-Test: Range deckt Originaltext-Stück ab.
  assert.match(txt.slice(r[0][0], r[0][1]), /Erster Satz/);
  assert.match(txt.slice(r[1][0], r[1][1]), /Zweiter Satz/);
  assert.match(txt.slice(r[2][0], r[2][1]), /Dritter Satz/);
});

test('findSentenceRanges: Ranges decken den Originaltext lückenlos ab', () => {
  // ICU-Segmenter spaltet manche Abkürzungen, manche nicht — wichtig ist, dass
  // die zurückgegebenen Ranges dem Originaltext entsprechen, damit später ein
  // gültiger Caret-Hit-Test funktioniert.
  const txt = 'Erster Satz. Zweiter Satz. Dritter Satz.';
  const r = findSentenceRanges(txt);
  assert.ok(r.length >= 1);
  for (const [s, e] of r) {
    assert.ok(s >= 0 && e <= txt.length && s < e);
  }
  // Concat aller Slices = Original (modulo Whitespace-Trimming am Rand).
  const joined = r.map(([s, e]) => txt.slice(s, e)).join('');
  assert.equal(joined.trim(), txt.trim());
});

test('findSentenceRanges: ohne Endpunkt → Text als ein Segment', () => {
  const r = findSentenceRanges('Kein Punkt am Ende');
  assert.equal(r.length, 1);
  assert.equal(r[0][0], 0);
  assert.equal(r[0][1], 'Kein Punkt am Ende'.length);
});
