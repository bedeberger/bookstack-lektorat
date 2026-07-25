// Unit-Tests für Pure-Helpers aus public/js/editor/focus.js.
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
  typewriterScroll,
} = await import('../../public/js/editor/focus.js');

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

test('pickCenterBlock: Pool nicht leer, ALLE Höhe 0 → null', () => {
  // Genau der transiente Fall hinter „Hervorhebung weg": das IO-Set enthält
  // Einträge, die gerade abgehängt / collapsed sind (Höhe 0). Alle werden
  // übersprungen → kein Treffer.
  const containerRect = { top: 0, bottom: 100, height: 100 };
  const blocks = [mkRectEl(10, 10), mkRectEl(50, 50), mkRectEl(90, 90)];
  assert.equal(pickCenterBlock(containerRect, blocks), null);
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

test('findBlockAtViewportCenter: visibleBlocks alle Höhe 0 → QSA-Fallback statt null', () => {
  // Regression gegen den intermittierenden „Hervorhebung weg"-Bug: das IO-Set
  // ist nicht leer, hält aber nur Höhe-0-Einträge (transiente Mutation / nicht
  // ge-unobserve'te removed Node). Früher gab pickCenterBlock null zurück und
  // es gab KEINEN QSA-Fallback → block===null → setActiveBlock clear't alles.
  // Jetzt muss der vollständige QSA-Scan den sichtbaren Absatz liefern.
  const onScreen = mkRectEl(40, 60);
  const visibleAllZero = new Set([mkRectEl(50, 50), mkRectEl(70, 70)]);
  const container = {
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
    querySelectorAll: () => [onScreen],
  };
  assert.equal(findBlockAtViewportCenter(container, visibleAllZero), onScreen);
});

test('findBlockAtViewportCenter: visibleBlocks Höhe 0 UND QSA leer → null', () => {
  // Kein sichtbarer Block irgendwo → legitimes null (z.B. komplett leerer
  // Container). Der Fallback rettet nichts, was nicht da ist.
  const visibleAllZero = new Set([mkRectEl(50, 50)]);
  const container = {
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
    querySelectorAll: () => [],
  };
  assert.equal(findBlockAtViewportCenter(container, visibleAllZero), null);
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

test('computeTypewriterDelta: anchorRatio 0.33 ankert aufs obere Drittel', () => {
  const cRect = { top: 0, bottom: 1000, height: 1000 }; // oberes Drittel = 330
  const tRect = { top: 800, bottom: 840, height: 40 };  // Mitte = 820
  assert.equal(computeTypewriterDelta(cRect, tRect, 16, 0.33), 820 - 330);
});

test('computeTypewriterDelta: anchorRatio Default/ungültig → Mitte (0.5)', () => {
  const cRect = { top: 0, bottom: 1000, height: 1000 };
  const tRect = { top: 800, bottom: 840, height: 40 };  // Mitte = 820
  const mitte = 820 - 500;
  // weggelassen, undefined, ausserhalb [0,1], NaN → alle wie 0.5
  assert.equal(computeTypewriterDelta(cRect, tRect), mitte);
  assert.equal(computeTypewriterDelta(cRect, tRect, 16, undefined), mitte);
  assert.equal(computeTypewriterDelta(cRect, tRect, 16, 1.5), mitte);
  assert.equal(computeTypewriterDelta(cRect, tRect, 16, NaN), mitte);
});

test('computeTypewriterDelta: Anker ist die Bildschirmmitte, nicht die Box-Mitte', () => {
  // Scroll-Box beginnt unter der Focus-Topbar (top 50) → Box-Mitte 525, aber
  // Bildschirmmitte 500. Ohne Viewport-Bezug sässe die Schreiblinie 25px zu tief.
  const cRect = { top: 50, bottom: 1000, height: 950 };
  const tRect = { top: 800, bottom: 840, height: 40 };  // Mitte = 820
  assert.equal(computeTypewriterDelta(cRect, tRect, 16, 0.5, { top: 0, height: 1000 }), 820 - 500);
});

test('computeTypewriterDelta: Viewport-Anker respektiert offsetTop (Mobile-Tastatur)', () => {
  // Android Chrome schiebt den fixed Container nach oben: visualViewport
  // top=100, height=400 → sichtbare Mitte = 300.
  const cRect = { top: 0, bottom: 1000, height: 1000 };
  const tRect = { top: 480, bottom: 520, height: 40 };  // Mitte = 500
  assert.equal(computeTypewriterDelta(cRect, tRect, 16, 0.5, { top: 100, height: 400 }), 200);
});

test('computeTypewriterDelta: Anker in die Scroll-Box geclampt', () => {
  // Sichtbare Mitte (500) liegt unter der Box (endet bei 300) → Anker = 300,
  // sonst wäre er für den Caret unerreichbar (Scroll läuft ins Leere).
  const cRect = { top: 0, bottom: 300, height: 300 };
  const tRect = { top: 480, bottom: 520, height: 40 };  // Mitte = 500
  assert.equal(computeTypewriterDelta(cRect, tRect, 16, 0.5, { top: 0, height: 1000 }), 200);
});

test('computeTypewriterDelta: viewportRect fehlt/leer → Box als Bezug', () => {
  const cRect = { top: 0, bottom: 1000, height: 1000 };
  const tRect = { top: 800, bottom: 840, height: 40 };  // Mitte = 820
  assert.equal(computeTypewriterDelta(cRect, tRect, 16, 0.5, null), 820 - 500);
  assert.equal(computeTypewriterDelta(cRect, tRect, 16, 0.5, { top: 0, height: 0 }), 820 - 500);
});

// --- typewriterScroll -------------------------------------------------------

// Fake-Scroll-Container mit echter Anschlag-Semantik: scrollTop clamped auf
// [0, max], scrollBy schreibt synchron (wie behavior:'auto' im Browser).
function mkScroller({ scrollTop = 0, max = 1000, height = 1000 } = {}) {
  const el = {
    scrollTop,
    getBoundingClientRect: () => ({ top: 0, bottom: height, height }),
    scrollBy({ top }) { el.scrollTop = Math.max(0, Math.min(max, el.scrollTop + top)); },
  };
  return el;
}

test('typewriterScroll: echter Scroll kündigt genau einen prog-Scroll an', () => {
  const el = mkScroller({ scrollTop: 100 });
  const ctx = { expectedScroll: 0 };
  const moved = typewriterScroll(el, { top: 800, bottom: 840, height: 40 }, ctx, 16, 0.5, 0);
  assert.equal(moved, 320);
  assert.equal(el.scrollTop, 420);
  assert.equal(ctx.expectedScroll, 1);
});

test('typewriterScroll: am Anschlag geklemmt → kein Counter-Increment', () => {
  // Container steht am Maximum; der Caret sitzt unter dem Anker, das Delta ist
  // also positiv — scrollBy kann aber nichts mehr fahren und feuert darum auch
  // kein scroll-Event. Ein Increment hier liesse `expectedScroll` dauerhaft
  // stehen; onScroll verschluckte danach jeden echten User-Scroll (Spotlight
  // bleibt beim Blättern stehen).
  const el = mkScroller({ scrollTop: 1000, max: 1000 });
  const ctx = { expectedScroll: 0 };
  const moved = typewriterScroll(el, { top: 900, bottom: 940, height: 40 }, ctx, 16, 0.5, 0);
  assert.equal(moved, 0);
  assert.equal(el.scrollTop, 1000);
  assert.equal(ctx.expectedScroll, 0);
});

test('typewriterScroll: teilweise geklemmt → zählt einmal (Scroll-Event feuert)', () => {
  const el = mkScroller({ scrollTop: 950, max: 1000 });
  const ctx = { expectedScroll: 0 };
  const moved = typewriterScroll(el, { top: 900, bottom: 940, height: 40 }, ctx, 16, 0.5, 0);
  assert.equal(moved, 50);
  assert.equal(ctx.expectedScroll, 1);
});

test('typewriterScroll: Tippen am Scroll-Ende leakt den Counter nicht', () => {
  // 20 Tastendrücke gegen den Anschlag — der Counter darf bei 0 bleiben.
  const el = mkScroller({ scrollTop: 1000, max: 1000 });
  const ctx = { expectedScroll: 0 };
  for (let i = 0; i < 20; i++) {
    typewriterScroll(el, { top: 900, bottom: 940, height: 40 }, ctx, 16, 0.5, 0.08);
  }
  assert.equal(ctx.expectedScroll, 0);
});

test('typewriterScroll: Delta unter Schwelle → kein Scroll, kein Counter', () => {
  const el = mkScroller({ scrollTop: 100 });
  const ctx = { expectedScroll: 0 };
  assert.equal(typewriterScroll(el, { top: 495, bottom: 505, height: 10 }, ctx, 16, 0.5, 0), 0);
  assert.equal(el.scrollTop, 100);
  assert.equal(ctx.expectedScroll, 0);
});

// --- getCaretRect -----------------------------------------------------------

function mkSelection({
  empty = false,
  outside = false,
  emptyRects = false,
  zeroHeight = false,
  expandRect = null,        // {top, bottom, height} – Rect der Probe-Range
  startContainer = null,    // erlaubt mkTextNode-Override für Expansion
  startOffset = 0,
} = {}) {
  if (empty) return { rangeCount: 0, getRangeAt: () => null };
  const sc = startContainer || {};
  const rect = zeroHeight ? { top: 0, bottom: 0, height: 0 } : { top: 10, bottom: 30, height: 20 };
  const rects = emptyRects ? [] : [rect];
  const range = {
    startContainer: sc,
    startOffset,
    getClientRects: () => rects,
    getBoundingClientRect: () => rect,
    cloneRange() {
      // Clone-Range muss die Expansion-Branch in getCaretRect bedienen:
      // setEnd/setStart wechselt das Rect-Verhalten auf expandRect.
      let expanded = false;
      return {
        startContainer: sc,
        startOffset,
        setEnd() { expanded = true; },
        setStart() { expanded = true; },
        getClientRects: () => (expanded && expandRect ? [expandRect] : []),
        getBoundingClientRect: () => (expanded && expandRect
          ? expandRect
          : { top: 0, bottom: 0, height: 0 }),
      };
    },
  };
  return {
    rangeCount: 1,
    getRangeAt: () => range,
    _startContainer: sc,
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

test('getCaretRect: Höhe 0 ohne Expansion-Möglichkeit → null', () => {
  // Text-Node mit Länge 0 und Offset 0 → weder setEnd(off+1) noch
  // setStart(off-1) möglich; Probe-Range bringt nichts.
  const textNode = { nodeType: 3, nodeValue: '' };
  const sel = mkSelection({
    zeroHeight: true,
    startContainer: textNode,
    startOffset: 0,
  });
  const container = mkContainer(() => true);
  assert.equal(getCaretRect(container, sel), null);
});

// Regression: collapsed Caret am Soft-Wrap-Bruch oder direkt nach <br> liefert
// in Chromium/Firefox regelmässig leere getClientRects() und Höhe-0-BoundingRect.
// Ohne Probe-Range-Expansion würde der Recenter dann auf Block-BBox zurückfallen,
// und der Typewriter scrollte bei langen Absätzen ohne neue Absatzmarken nicht
// mit. Mit Expansion liefert eine non-collapsed Probe-Range deterministisch das
// Rect der angrenzenden Glyphe → korrekte visuelle Zeile.
test('getCaretRect: Soft-Wrap-Bruch (leere Rects + Höhe 0) → Probe-Range-Expansion', () => {
  const textNode = { nodeType: 3, nodeValue: 'lorem ipsum dolor sit amet' };
  const sel = mkSelection({
    emptyRects: true,
    zeroHeight: true,
    startContainer: textNode,
    startOffset: 12,                              // Position innerhalb Textknoten
    expandRect: { top: 240, bottom: 268, height: 28 },
  });
  const container = mkContainer(() => true);
  const rect = getCaretRect(container, sel);
  assert.ok(rect, 'expand-fallback muss greifen');
  assert.equal(rect.top, 240);
  assert.equal(rect.height, 28);
});

test('getCaretRect: Caret am Textnode-Ende → setStart(off-1) als Expansion', () => {
  // Im selben Test-Helper deckt setStart denselben Pfad ab — Rect-Wechsel
  // wird unabhängig von setEnd/setStart getriggert.
  const textNode = { nodeType: 3, nodeValue: 'abc' };
  const sel = mkSelection({
    emptyRects: true,
    zeroHeight: true,
    startContainer: textNode,
    startOffset: 3,
    expandRect: { top: 100, bottom: 120, height: 20 },
  });
  const container = mkContainer(() => true);
  const rect = getCaretRect(container, sel);
  assert.ok(rect);
  assert.equal(rect.top, 100);
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

// --- jumpToTrailingParagraph -----------------------------------------------

// Stub-DOM: minimal, document.createElement/createRange/getSelection.
// dom-blocks.js wird hier separat geladen (nicht via focus.js-Facade), damit
// Globals vor dem Import gesetzt sind.
function installStubDocument() {
  function mkNode(tagName) {
    const node = {
      tagName: tagName ? tagName.toUpperCase() : null,
      nodeType: 1,
      childNodes: [],
      get lastElementChild() {
        return this.childNodes.filter(n => n.nodeType === 1).at(-1) || null;
      },
      hasChildNodes() { return this.childNodes.length > 0; },
      appendChild(child) {
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
      },
      get textContent() {
        return this.childNodes.map(c => c.textContent || '').join('');
      },
      scrollIntoView() {},
      classList: (() => {
        const set = new Set();
        return {
          add: (c) => set.add(c),
          remove: (c) => set.delete(c),
          contains: (c) => set.has(c),
        };
      })(),
    };
    return node;
  }
  const sel = {
    _range: null,
    rangeCount: 0,
    getRangeAt() { return null; },
    removeAllRanges() { this._range = null; },
    addRange(r) { this._range = r; this.rangeCount = 1; },
  };
  globalThis.document = {
    createElement: (tag) => mkNode(tag),
    createRange: () => ({ _start: null, setStart(n, o) { this._start = [n, o]; }, collapse() {} }),
    getSelection: () => sel,
  };
  return { mkNode, sel };
}

const { mkNode } = installStubDocument();
const { jumpToTrailingParagraph } = await import('../../public/js/editor/focus/dom-blocks.js');

test('jumpToTrailingParagraph: leeres <p> ohne Kinder bekommt <br> (neue-Seite-Bug)', () => {
  // Frisch erstellte Seite startet mit `<p></p>` ohne Text-Node/BR. Caret
  // an Offset 0 in element-node ohne Kinder empfängt keine input-Events →
  // User kann nicht tippen. jumpToTrailingParagraph muss <br> ergänzen.
  const container = mkNode('div');
  const emptyP = mkNode('p');
  container.appendChild(emptyP);
  const added = jumpToTrailingParagraph(container);
  assert.equal(added, null, 'leeres <p> recycled, nicht neu angehängt');
  assert.equal(emptyP.childNodes.length, 1, '<br> als Schreib-Slot ergänzt');
  assert.equal(emptyP.childNodes[0].tagName, 'BR');
});

test('jumpToTrailingParagraph: leeres <p> mit <br> bleibt unverändert', () => {
  const container = mkNode('div');
  const p = mkNode('p');
  p.appendChild(mkNode('br'));
  container.appendChild(p);
  jumpToTrailingParagraph(container);
  assert.equal(p.childNodes.length, 1, 'kein doppeltes <br>');
});

test('jumpToTrailingParagraph: kein leerer Trailing-Block → neuer <p><br>', () => {
  const container = mkNode('div');
  const p = mkNode('p');
  p.appendChild({ nodeType: 3, textContent: 'lorem' });
  container.appendChild(p);
  const added = jumpToTrailingParagraph(container);
  assert.ok(added, 'neuer <p> wurde angehängt');
  assert.equal(added.tagName, 'P');
  assert.equal(added.childNodes[0].tagName, 'BR');
});
