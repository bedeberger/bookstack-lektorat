// Unit-Tests für Pure-Helpers aus public/js/editor-focus.js.
// ESM-File, weil das Quellmodul ESM ist; node --test lädt .mjs nativ.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  findBlockFromNode,
  pickCenterBlock,
  findBlockAtViewportCenter,
  computeTypewriterDelta,
  getCaretRect,
  setActiveBlock,
  dynamicTypewriterThreshold,
} = await import('../../public/js/editor-focus.js');

// --- findBlockFromNode ------------------------------------------------------

// Minimales Fake-DOM: { nodeType, tagName, parentNode }. 3=Text, 1=Element.
function mkEl(tagName, parentNode = null) {
  return { nodeType: 1, tagName, parentNode };
}
function mkText(parentNode) {
  return { nodeType: 3, parentNode };
}

test('findBlockFromNode: text-node → nächstliegender Block', () => {
  const root = mkEl('DIV');
  const p = mkEl('P', root);
  const span = mkEl('SPAN', p);
  const text = mkText(span);
  assert.equal(findBlockFromNode(text, root), p);
});

test('findBlockFromNode: Element selbst ist Block', () => {
  const root = mkEl('DIV');
  const h2 = mkEl('H2', root);
  assert.equal(findBlockFromNode(h2, root), h2);
});

test('findBlockFromNode: kein Block bis root → null', () => {
  const root = mkEl('DIV');
  const span = mkEl('SPAN', root);
  const em = mkEl('EM', span);
  assert.equal(findBlockFromNode(em, root), null);
});

test('findBlockFromNode: null-input → null', () => {
  const root = mkEl('DIV');
  assert.equal(findBlockFromNode(null, root), null);
  assert.equal(findBlockFromNode(undefined, root), null);
});

test('findBlockFromNode: node === root (keine Aufstieg-Iteration)', () => {
  const root = mkEl('DIV');
  assert.equal(findBlockFromNode(root, root), null);
});

test('findBlockFromNode: alle Block-Tags erkannt (inkl. Tabellen/Figure)', () => {
  const root = mkEl('DIV');
  const tags = [
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'LI', 'PRE',
    'TD', 'TH', 'FIGURE', 'FIGCAPTION',
  ];
  for (const tag of tags) {
    const el = mkEl(tag, root);
    assert.equal(findBlockFromNode(el, root), el, tag);
  }
});

test('findBlockFromNode: TD-Zelle in Tabelle → Zelle als Block (nicht TR)', () => {
  // Regression: ohne TD in BLOCK_TAGS fällt Klick in Tabelle auf Viewport-
  // Center zurück – unerwartetes Recenter auf fremden Absatz.
  const root = mkEl('DIV');
  const table = mkEl('TABLE', root);
  const tr = mkEl('TR', table);
  const td = mkEl('TD', tr);
  const text = mkText(td);
  assert.equal(findBlockFromNode(text, root), td);
});

test('findBlockFromNode: DIV ist KEIN Block (Chromium-Default-Trap)', () => {
  const root = mkEl('BODY');
  const div = mkEl('DIV', root);
  const text = mkText(div);
  assert.equal(findBlockFromNode(text, root), null,
    'DIV dürfte nicht matchen — sonst bricht defaultParagraphSeparator-Garantie');
});

test('findBlockFromNode: <p> in <blockquote> → liefert blockquote (outermost)', () => {
  // Grund: opacity ist multiplikativ im Stacking-Context. Wenn nur das innere
  // <p> „.focus-paragraph-active" bekommt, dimmt das umschliessende <blockquote>
  // (opacity:0.5) den Textinhalt trotz opacity:1 am Kind.
  const root = mkEl('DIV');
  const bq = mkEl('BLOCKQUOTE', root);
  const p = mkEl('P', bq);
  const text = mkText(p);
  assert.equal(findBlockFromNode(text, root), bq);
});

test('findBlockFromNode: <p> in <li> (ul wrapper) → liefert li (outermost)', () => {
  const root = mkEl('DIV');
  const ul = mkEl('UL', root);
  const li = mkEl('LI', ul);
  const p = mkEl('P', li);
  const text = mkText(p);
  assert.equal(findBlockFromNode(text, root), li);
});

test('findBlockFromNode: tief verschachtelt liefert äusserst-möglichen Block', () => {
  // <blockquote><li><p>text</p></li></blockquote> — konstruiert, aber deckt die
  // Walk-Logik ab: höchster Block-Tag unter root gewinnt.
  const root = mkEl('DIV');
  const bq = mkEl('BLOCKQUOTE', root);
  const li = mkEl('LI', bq);
  const p = mkEl('P', li);
  const text = mkText(p);
  assert.equal(findBlockFromNode(text, root), bq);
});

// --- pickCenterBlock --------------------------------------------------------

function mkRectEl(top, bottom) {
  return { getBoundingClientRect: () => ({ top, bottom, height: bottom - top }) };
}

test('pickCenterBlock: Block nahe der Viewport-Mitte gewinnt', () => {
  const containerRect = { top: 0, bottom: 1000, height: 1000 }; // Mitte = 500
  const blocks = [mkRectEl(100, 150), mkRectEl(480, 530), mkRectEl(900, 950)];
  assert.equal(pickCenterBlock(containerRect, blocks), blocks[1]);
});

test('pickCenterBlock: Höhe 0 wird übersprungen', () => {
  const containerRect = { top: 0, bottom: 100, height: 100 };
  const blocks = [mkRectEl(50, 50), mkRectEl(30, 70)];
  assert.equal(pickCenterBlock(containerRect, blocks), blocks[1]);
});

test('pickCenterBlock: leere Liste → null', () => {
  assert.equal(pickCenterBlock({ top: 0, bottom: 100, height: 100 }, []), null);
});

test('pickCenterBlock: Tie → erster Fund (stable)', () => {
  const containerRect = { top: 0, bottom: 100, height: 100 }; // Mitte = 50
  const a = mkRectEl(40, 60);
  const b = mkRectEl(40, 60);
  assert.equal(pickCenterBlock(containerRect, [a, b]), a);
});

// --- findBlockAtViewportCenter ---------------------------------------------

test('findBlockAtViewportCenter: null-container → null', () => {
  assert.equal(findBlockAtViewportCenter(null, new Set()), null);
});

test('findBlockAtViewportCenter: leeres Set → Fallback auf querySelectorAll', () => {
  const fallbackBlocks = [mkRectEl(40, 60)];
  const container = {
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
    querySelectorAll: () => fallbackBlocks,
  };
  assert.equal(findBlockAtViewportCenter(container, new Set()), fallbackBlocks[0]);
});

test('findBlockAtViewportCenter: visibleBlocks bevorzugt', () => {
  const visible = new Set([mkRectEl(40, 60)]);
  const container = {
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
    querySelectorAll: () => { throw new Error('nicht aufrufen'); },
  };
  const got = findBlockAtViewportCenter(container, visible);
  assert.equal(got, [...visible][0]);
});

// --- computeTypewriterDelta -------------------------------------------------

test('computeTypewriterDelta: Target über Mitte → negatives Delta (scroll up)', () => {
  const cRect = { top: 0, bottom: 1000, height: 1000 }; // Mitte = 500
  const tRect = { top: 100, bottom: 140, height: 40 };  // Mitte = 120
  assert.equal(computeTypewriterDelta(cRect, tRect), 120 - 500);
});

test('computeTypewriterDelta: Target unter Mitte → positives Delta (scroll down)', () => {
  const cRect = { top: 0, bottom: 1000, height: 1000 };
  const tRect = { top: 800, bottom: 840, height: 40 };
  assert.equal(computeTypewriterDelta(cRect, tRect), 820 - 500);
});

test('computeTypewriterDelta: unter Schwelle → 0 (kein Jitter)', () => {
  // Schwelle (~16px) filtert Sub-Zeilen-Bewegungen raus — Caret-Rect-Jitter
  // und getBoundingClientRect-Subpixel-Shifts beim Tippen lösen keinen
  // Mini-Scroll aus. Echte Zeilenwechsel (line-wrap, Enter) übersteigen die
  // Schwelle und scrollen.
  const cRect = { top: 0, bottom: 1000, height: 1000 };
  const tRect = { top: 499, bottom: 500, height: 1 };  // Mitte = 499.5, delta = -0.5
  assert.equal(computeTypewriterDelta(cRect, tRect), 0);
  // 10px unter Schwelle → immer noch 0
  assert.equal(computeTypewriterDelta(cRect, { top: 495, bottom: 505, height: 10 }), 0);
  // Deutlich über Schwelle → Delta
  assert.notEqual(computeTypewriterDelta(cRect, { top: 600, bottom: 640, height: 40 }), 0);
});

test('computeTypewriterDelta: null-input → 0', () => {
  assert.equal(computeTypewriterDelta(null, { top: 1, bottom: 2, height: 1 }), 0);
  assert.equal(computeTypewriterDelta({ top: 0, bottom: 1, height: 1 }, null), 0);
});

// --- getCaretRect -----------------------------------------------------------

function mkSelection({ empty = false, outside = false, emptyRects = false, zeroHeight = false } = {}) {
  if (empty) return { rangeCount: 0, getRangeAt: () => null };
  const startContainer = {};
  const rect = zeroHeight ? { top: 0, bottom: 0, height: 0 } : { top: 10, bottom: 30, height: 20 };
  const rects = emptyRects ? [] : [rect];
  return {
    rangeCount: 1,
    getRangeAt: () => ({
      startContainer,
      getClientRects: () => rects,
      getBoundingClientRect: () => rect,
    }),
    _startContainer: startContainer,
    _outside: outside,
  };
}

function mkContainer(containsStart) {
  return { contains: (n) => containsStart(n) };
}

test('getCaretRect: keine Selection → null', () => {
  assert.equal(getCaretRect({ contains: () => true }, mkSelection({ empty: true })), null);
});

test('getCaretRect: null-selection → null', () => {
  assert.equal(getCaretRect({ contains: () => true }, null), null);
});

test('getCaretRect: Range ausserhalb Container → null', () => {
  const sel = mkSelection();
  const container = mkContainer(() => false);
  assert.equal(getCaretRect(container, sel), null);
});

test('getCaretRect: normale ClientRect → rect', () => {
  const sel = mkSelection();
  const container = mkContainer(() => true);
  const rect = getCaretRect(container, sel);
  assert.equal(rect.height, 20);
});

test('getCaretRect: leere getClientRects → Fallback boundingClientRect', () => {
  const sel = mkSelection({ emptyRects: true });
  const container = mkContainer(() => true);
  const rect = getCaretRect(container, sel);
  assert.equal(rect.height, 20);
});

test('getCaretRect: Höhe 0 → null', () => {
  const sel = mkSelection({ zeroHeight: true });
  const container = mkContainer(() => true);
  assert.equal(getCaretRect(container, sel), null);
});

// --- setActiveBlock (DOM-Mutation, aber simpel stubbar) ---------------------

function mkClassList() {
  const set = new Set();
  return {
    _set: set,
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
  };
}
function mkBlock(active = false) {
  const cl = mkClassList();
  if (active) cl.add('focus-paragraph-active');
  return { classList: cl };
}
function mkSetActiveContainer(activeBlocks) {
  return {
    querySelectorAll: (sel) => {
      assert.equal(sel, '.focus-paragraph-active');
      return activeBlocks.filter(b => b.classList.contains('focus-paragraph-active'));
    },
  };
}

test('setActiveBlock: setzt Klasse auf neuen Block', () => {
  const fresh = mkBlock();
  const container = mkSetActiveContainer([fresh]);
  setActiveBlock(container, fresh);
  assert.equal(fresh.classList.contains('focus-paragraph-active'), true);
});

test('setActiveBlock: entfernt Klasse von allen alten Blöcken (Chromium-Split-Bug)', () => {
  const ghost1 = mkBlock(true);
  const ghost2 = mkBlock(true);
  const neu = mkBlock();
  const container = mkSetActiveContainer([ghost1, ghost2, neu]);
  setActiveBlock(container, neu);
  assert.equal(ghost1.classList.contains('focus-paragraph-active'), false);
  assert.equal(ghost2.classList.contains('focus-paragraph-active'), false);
  assert.equal(neu.classList.contains('focus-paragraph-active'), true);
});

test('setActiveBlock: block=null → alle Markierungen weg', () => {
  const a = mkBlock(true);
  const container = mkSetActiveContainer([a]);
  setActiveBlock(container, null);
  assert.equal(a.classList.contains('focus-paragraph-active'), false);
});

test('setActiveBlock: Re-Set auf gleichen Block → idempotent', () => {
  const a = mkBlock(true);
  const container = mkSetActiveContainer([a]);
  setActiveBlock(container, a);
  assert.equal(a.classList.contains('focus-paragraph-active'), true);
});

test('setActiveBlock: null-container → no-op (kein Throw)', () => {
  setActiveBlock(null, null);
  setActiveBlock(null, mkBlock());
});

// --- dynamicTypewriterThreshold --------------------------------------------

test('dynamicTypewriterThreshold: ohne window/getComputedStyle → fallback', () => {
  // Block ohne ownerDocument → getComputedStyle wirft, fallback greift
  assert.equal(dynamicTypewriterThreshold(null, 16), 16);
  assert.equal(dynamicTypewriterThreshold(undefined, 21), 21);
});
