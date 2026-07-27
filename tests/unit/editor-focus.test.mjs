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
  caretWithinViewport,
  consumeProgrammaticScroll,
  resolveScrollBox,
  normAnchorRatio,
  resolveActiveBlock,
  resolveGutterCaretPoint,
} = await import('../../public/js/editor/focus.js');

const { shouldRecenterOnViewport, measureBoxGeometry } = await import('../../public/js/editor/focus/viewport.js');

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

test('findBlockAtViewportCenter: IO-Set komplett off-screen (Sprung-Scroll) → QSA-Fallback', () => {
  // IntersectionObserver-Callbacks laufen asynchron: nach einem Sprung-Scroll
  // (Page-Down, Scrollbar-Zug, programmatischer Sprung) sieht der Recenter-Tick
  // im RAF noch das Set der ALTEN Position. Ohne Sichtbarkeits-Gegenprobe liefert
  // pickCenterBlock daraus einen Block weit ausserhalb des Bildes — der ganze
  // sichtbare Text bliebe gedimmt, und weil ein IO-Callback selbst keinen Tick
  // auslöst, bis zum nächsten Event.
  const onScreen = mkRectEl(40, 60);
  const stale = new Set([mkRectEl(-800, -700), mkRectEl(-690, -600)]);
  const container = {
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
    querySelectorAll: () => [onScreen],
  };
  assert.equal(findBlockAtViewportCenter(container, stale), onScreen);
});

test('findBlockAtViewportCenter: teilweise sichtbarer Pick bleibt (kein QSA)', () => {
  // Abgrenzung: beim laufenden Scroll ist das Set höchstens einen Frame alt und
  // überlappt fast vollständig. Ein Pick, der das Band noch anschneidet, gilt —
  // sonst liefe der QSA-Vollscan in jedem Scroll-Frame.
  const partly = new Set([mkRectEl(-20, 10)]);
  const container = {
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
    querySelectorAll: () => { throw new Error('nicht aufrufen'); },
  };
  assert.equal(findBlockAtViewportCenter(container, partly), [...partly][0]);
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
// [0, max], `scrollTo` schreibt synchron (wie behavior:'instant' im Browser).
// `scrollHeight`/`clientHeight` sind Pflicht: daran erkennt `resolveScrollBox`,
// ob die Box überhaupt scrollen KANN — nur eine grundsätzlich nicht scrollbare
// Box gibt an einen scrollbaren Vorfahr ab.
// `smooth: true` simuliert eine Schale mit `scroll-behavior: smooth` im
// Host-CSS: dort verschiebt nur `behavior:'instant'` die Position synchron,
// `'auto'` (und die Kurzform) delegieren an die CSS-Property und animieren.
function mkScroller({ scrollTop = 0, max = 1000, height = 1000, parentElement = null, smooth = false } = {}) {
  const el = {
    scrollTop,
    clientHeight: height,
    scrollHeight: height + max,
    parentElement,
    getBoundingClientRect: () => ({ top: 0, bottom: height, height }),
    scrollTo({ top, behavior }) {
      if (smooth && behavior !== 'instant') return;    // animiert → noch keine Bewegung
      el.scrollTop = Math.max(0, Math.min(max, top));
    },
  };
  return el;
}

// --- resolveScrollBox -------------------------------------------------------

test('resolveScrollBox: scrollbarer Container ist selbst die Box', () => {
  const ancestor = mkScroller({ max: 1000 });
  const el = mkScroller({ max: 1000, parentElement: ancestor });
  assert.equal(resolveScrollBox(el), el);
});

test('resolveScrollBox: nicht scrollbarer Container gibt an den Vorfahr ab', () => {
  const ancestor = mkScroller({ max: 1000 });
  const el = mkScroller({ max: 0, parentElement: ancestor });
  assert.equal(resolveScrollBox(el), ancestor);
});

test('resolveScrollBox: Container am Anschlag bleibt die Box', () => {
  // Abgrenzung: die Box KANN scrollen (scrollHeight > clientHeight), sie steht
  // nur am Ende. Gäbe sie hier ab, zöge der Typewriter die Seite unter dem
  // Editor weg.
  const ancestor = mkScroller({ max: 1000 });
  const el = mkScroller({ scrollTop: 1000, max: 1000, parentElement: ancestor });
  assert.equal(resolveScrollBox(el), el);
});

test('resolveScrollBox: kein scrollbarer Vorfahr → Container als letzte Instanz', () => {
  const el = mkScroller({ max: 0 });
  assert.equal(resolveScrollBox(el), el);
});

// --- typewriterScroll -------------------------------------------------------

test('typewriterScroll: echter Scroll markiert Box + eigene Zielposition', () => {
  const el = mkScroller({ scrollTop: 100 });
  const ctx = { progScroll: null };
  const moved = typewriterScroll(el, { top: 800, bottom: 840, height: 40 }, ctx, 16, 0.5);
  assert.equal(moved, 320);
  assert.equal(el.scrollTop, 420);
  assert.deepEqual(ctx.progScroll, { box: el, top: 420 });
  // Das folgende scroll-Event ist das eigene → wird verschluckt, Marke gelöscht.
  assert.equal(consumeProgrammaticScroll(el, ctx), true);
  assert.equal(ctx.progScroll, null);
});

test('typewriterScroll: am Anschlag geklemmt → keine Marke', () => {
  // Container steht am Maximum; der Caret sitzt unter dem Anker, das Delta ist
  // also positiv — die Box kann aber nichts mehr fahren und feuert darum auch
  // kein scroll-Event. Eine Marke dafür bliebe stehen und liesse onScroll den
  // nächsten echten User-Scroll verschlucken.
  const el = mkScroller({ scrollTop: 1000, max: 1000 });
  const ctx = { progScroll: null };
  const moved = typewriterScroll(el, { top: 900, bottom: 940, height: 40 }, ctx, 16, 0.5);
  assert.equal(moved, 0);
  assert.equal(el.scrollTop, 1000);
  assert.equal(ctx.progScroll, null);
});

test('typewriterScroll: teilweise geklemmt → Marke auf der erreichten Position', () => {
  const el = mkScroller({ scrollTop: 950, max: 1000 });
  const ctx = { progScroll: null };
  const moved = typewriterScroll(el, { top: 900, bottom: 940, height: 40 }, ctx, 16, 0.5);
  assert.equal(moved, 50);
  assert.deepEqual(ctx.progScroll, { box: el, top: 1000 });
});

test('typewriterScroll: Tippen am Scroll-Ende hinterlässt keine Marke', () => {
  // 20 Tastendrücke gegen den Anschlag — danach darf kein User-Scroll als
  // „eigener" gelten.
  const el = mkScroller({ scrollTop: 1000, max: 1000 });
  const ctx = { progScroll: null };
  for (let i = 0; i < 20; i++) {
    typewriterScroll(el, { top: 900, bottom: 940, height: 40 }, ctx, 16, 0.5);
  }
  assert.equal(ctx.progScroll, null);
  assert.equal(consumeProgrammaticScroll(el, ctx), false);
});

test('typewriterScroll: Delta unter Schwelle → kein Scroll, keine Marke', () => {
  const el = mkScroller({ scrollTop: 100 });
  const ctx = { progScroll: null };
  assert.equal(typewriterScroll(el, { top: 495, bottom: 505, height: 10 }, ctx, 16, 0.5), 0);
  assert.equal(el.scrollTop, 100);
  assert.equal(ctx.progScroll, null);
});

test('typewriterScroll: nicht scrollbare Box → scrollbarer Vorfahr übernimmt, MIT Marke', () => {
  // Fremde Schale (nativer Client) überschreibt das Layout so, dass nicht das
  // contenteditable die Scroll-Box ist, sondern ein Vorfahr. Ohne Fallback wäre
  // der Typewriter dort komplett tot. Die Marke muss den Vorfahr benennen: das
  // scroll-Event feuert dort, und der document-Capture-Listener in listeners.js
  // fragt sie mit genau dieser Box ab. Ohne Box-Bezug gälte der eigene Scroll
  // als User-Scroll und risse das Spotlight auf den Center-Block.
  const ancestor = mkScroller({ scrollTop: 100, max: 1000 });
  const el = mkScroller({ max: 0, parentElement: ancestor });   // scrollHeight === clientHeight
  const ctx = { progScroll: null };
  const moved = typewriterScroll(el, { top: 800, bottom: 840, height: 40 }, ctx, 16, 0.5);
  assert.equal(moved, 320);
  assert.equal(ancestor.scrollTop, 420);
  assert.equal(el.scrollTop, 0);
  assert.deepEqual(ctx.progScroll, { box: ancestor, top: 420 });
  assert.equal(consumeProgrammaticScroll(ancestor, ctx), true);
});

test('typewriterScroll: scrollbare Box am Anschlag → kein Vorfahr-Fallback', () => {
  // Abgrenzung zum Test darüber: die Box KANN scrollen, steht nur am Ende.
  // Dann ist der No-op korrekt — ein Fallback würde die Seite unter dem Editor
  // wegziehen.
  const ancestor = mkScroller({ scrollTop: 100, max: 1000 });
  const el = mkScroller({ scrollTop: 1000, max: 1000, parentElement: ancestor });
  const ctx = { progScroll: null };
  assert.equal(typewriterScroll(el, { top: 900, bottom: 940, height: 40 }, ctx, 16, 0.5), 0);
  assert.equal(ancestor.scrollTop, 100);
  assert.equal(ctx.progScroll, null);
});

test('typewriterScroll: Host-CSS mit scroll-behavior:smooth bremst nicht', () => {
  // Fremde Schale setzt unlayered `scroll-behavior: smooth`. Nur
  // `behavior: 'instant'` verschiebt dann synchron; `'auto'` und die Kurzform
  // delegieren laut CSSOM-View an die CSS-Property. Animiert stünde scrollTop
  // direkt danach noch auf dem Altwert → gefahrene Strecke 0 → keine Marke →
  // das eigene scroll-Event gälte als User-Scroll.
  const el = mkScroller({ scrollTop: 100, smooth: true });
  const ctx = { progScroll: null };
  const moved = typewriterScroll(el, { top: 800, bottom: 840, height: 40 }, ctx, 16, 0.5);
  assert.equal(moved, 320);
  assert.equal(el.scrollTop, 420);
  assert.deepEqual(ctx.progScroll, { box: el, top: 420 });
});

// --- consumeProgrammaticScroll ----------------------------------------------

test('consumeProgrammaticScroll: User-Scroll wird nicht verschluckt', () => {
  const el = mkScroller({ scrollTop: 420 });
  const ctx = { progScroll: { box: el, top: 420 } };
  el.scrollTop = 700;                      // User rollt weg
  assert.equal(consumeProgrammaticScroll(el, ctx), false);
  assert.equal(ctx.progScroll, null);
});

test('consumeProgrammaticScroll: Subpixel-Rest gilt als eigener Scroll', () => {
  const el = mkScroller({ scrollTop: 420.4 });
  assert.equal(consumeProgrammaticScroll(el, { progScroll: { box: el, top: 420 } }), true);
});

test('consumeProgrammaticScroll: Marke wird immer verbraucht (kein Leak)', () => {
  // Kernunterschied zum früheren Zähler: ein verlorenes/zusätzliches Event kostet
  // höchstens einen Tick. Zweites Event ohne neuen prog-Scroll ist User-Scroll.
  const el = mkScroller({ scrollTop: 420 });
  const ctx = { progScroll: { box: el, top: 420 } };
  assert.equal(consumeProgrammaticScroll(el, ctx), true);
  assert.equal(consumeProgrammaticScroll(el, ctx), false);
});

test('consumeProgrammaticScroll: Marke einer fremden Box verschluckt nichts', () => {
  // Position allein reicht als Kriterium nicht: Container und Vorfahr können
  // zufällig auf demselben scrollTop stehen. Ohne Box-Vergleich verschluckte der
  // Container-Scroll die Marke des Vorfahren (und umgekehrt).
  const ancestor = mkScroller({ scrollTop: 420 });
  const el = mkScroller({ scrollTop: 420, parentElement: ancestor });
  const ctx = { progScroll: { box: ancestor, top: 420 } };
  assert.equal(consumeProgrammaticScroll(el, ctx), false);
});

// --- shouldRecenterOnViewport -----------------------------------------------

test('shouldRecenterOnViewport: Höhenwechsel beim Schreiben recentert', () => {
  assert.equal(shouldRecenterOnViewport({ h: 800, top: 0 }, { h: 400, top: 0 }, true), true);
});

test('shouldRecenterOnViewport: reiner Versatz recentert ebenfalls', () => {
  // Der Anker ist `offsetTop + height × ratio` — Android Chrome schiebt den
  // sichtbaren Ausschnitt bei Tastatur/URL-Leiste auch ohne Höhenwechsel nach
  // unten. Ohne diesen Zweig driftet die Schreibzeile vom Anker weg.
  assert.equal(shouldRecenterOnViewport({ h: 800, top: 0 }, { h: 800, top: 120 }, true), true);
});

test('shouldRecenterOnViewport: Sub-Pixel-Rauschen recentert nicht', () => {
  assert.equal(shouldRecenterOnViewport({ h: 800, top: 0 }, { h: 800.4, top: 0.6 }, true), false);
});

test('shouldRecenterOnViewport: ohne Schreibfokus nie', () => {
  assert.equal(shouldRecenterOnViewport({ h: 800, top: 0 }, { h: 400, top: 120 }, false), false);
});

test('shouldRecenterOnViewport: erster Tick (Mount) recentert nicht', () => {
  assert.equal(shouldRecenterOnViewport(null, { h: 800, top: 0 }, true), false);
});

// --- measureBoxGeometry -----------------------------------------------------

// Fake-Box, die das CSS-Border-Box-Clamping nachbildet: `clientHeight` kann nie
// kleiner werden als die eigene Padding-Summe, `top` verschiebt sich davon nicht
// (die Flex-Kette darüber bestimmt sie).
function mkBox({ slot, padTop, padBottom, top = 40 }) {
  const style = { paddingTop: padTop, paddingBottom: padBottom };
  const px = (v) => parseFloat(v) || 0;
  return {
    style,
    get clientHeight() { return Math.max(slot, px(style.paddingTop) + px(style.paddingBottom)); },
    getBoundingClientRect: () => ({ top }),
  };
}

test('measureBoxGeometry: liefert den Layout-Slot, nicht die aufgeblähte Padding-Summe', () => {
  // Der Kern der Messung: mit gesetzten Puffern (~eine Bildschirmhöhe) meldet
  // `clientHeight` genau diese Summe zurück. Direkt gelesen wäre die
  // Puffer-Formel zirkulär und die Summe schrumpfte pro Viewport-Tick um die
  // Reserve, bis Kopf- und Tail-Puffer nicht mehr bis zum Anker reichen.
  const wide = mkBox({ slot: 700, padTop: '400px', padBottom: '400px' });
  assert.equal(wide.clientHeight, 800);            // aufgebläht: Padding-Summe gewinnt
  assert.equal(measureBoxGeometry(wide).h, 700);   // gemessen: der Slot
});

test('measureBoxGeometry: stellt die Inline-Puffer danach wieder her', () => {
  // Die Messung darf keinen Zustand hinterlassen — eine leere Inline-Angabe muss
  // leer bleiben, sonst überschreibt sie ab dann die CSS-Formel.
  const box = mkBox({ slot: 700, padTop: '', padBottom: '' });
  measureBoxGeometry(box);
  assert.equal(box.style.paddingTop, '');
  assert.equal(box.style.paddingBottom, '');
});

test('measureBoxGeometry: Oberkante kommt mit (Basis des --focus-box-top-Abzugs)', () => {
  assert.equal(measureBoxGeometry(mkBox({ slot: 700, padTop: '', padBottom: '', top: 45 })).top, 45);
});

test('measureBoxGeometry: ohne Box neutral (kein Wurf im Viewport-Tick)', () => {
  assert.deepEqual(measureBoxGeometry(null), { h: 0, top: 0 });
});

// --- normAnchorRatio --------------------------------------------------------

test('normAnchorRatio: gültige Ratios durch, ungültige auf 0.5', () => {
  assert.equal(normAnchorRatio(0), 0);
  assert.equal(normAnchorRatio(0.33), 0.33);
  assert.equal(normAnchorRatio(1), 1);
  assert.equal(normAnchorRatio(undefined), 0.5);
  assert.equal(normAnchorRatio(-0.2), 0.5);
  assert.equal(normAnchorRatio(1.5), 0.5);
  assert.equal(normAnchorRatio(NaN), 0.5);
  assert.equal(normAnchorRatio('0.3'), 0.5);
});

// --- resolveActiveBlock -----------------------------------------------------

// Fake-Container mit Block-Kindern: `contains` über die parentNode-Kette,
// getBoundingClientRect für den Center-Pick.
function mkBlockHost(blocks) {
  const container = {
    nodeType: 1, tagName: 'DIV', parentNode: null,
    getBoundingClientRect: () => ({ top: 0, bottom: 300, height: 300 }),
    querySelectorAll: () => blocks,
    contains(node) {
      let cur = node;
      while (cur) { if (cur === container) return true; cur = cur.parentNode; }
      return false;
    },
  };
  return container;
}
function mkHostedBlock(container, top, height = 40) {
  return {
    nodeType: 1, tagName: 'P', parentNode: container,
    getBoundingClientRect: () => ({ top, bottom: top + height, height }),
  };
}

test('resolveActiveBlock: Caret-Anchor gewinnt', () => {
  const container = mkBlockHost([]);
  const p1 = mkHostedBlock(container, 0);
  const p2 = mkHostedBlock(container, 140);
  const sel = { rangeCount: 1, anchorNode: mkText(p1) };
  const block = resolveActiveBlock({
    container, sel, visibleBlocks: new Set([p1, p2]), granularity: 'paragraph', lastBlock: null,
  });
  assert.equal(block, p1);
});

test('resolveActiveBlock: preferCenter ignoriert den Caret', () => {
  const container = mkBlockHost([]);
  const p1 = mkHostedBlock(container, 0);
  const p2 = mkHostedBlock(container, 130);   // Mitte 150 → Container-Center
  const sel = { rangeCount: 1, anchorNode: mkText(p1) };
  const block = resolveActiveBlock({
    container, sel, visibleBlocks: new Set([p1, p2]),
    granularity: 'paragraph', lastBlock: null, preferCenter: true,
  });
  assert.equal(block, p2);
});

test('resolveActiveBlock: fremde Selection → Viewport-Center', () => {
  const container = mkBlockHost([]);
  const p = mkHostedBlock(container, 130);
  const foreign = mkText(mkEl('INPUT'));   // ausserhalb des Containers
  const block = resolveActiveBlock({
    container, sel: { rangeCount: 1, anchorNode: foreign },
    visibleBlocks: new Set([p]), granularity: 'paragraph', lastBlock: null,
  });
  assert.equal(block, p);
});

test('resolveActiveBlock: transienter null-Tick behält den letzten Block', () => {
  const container = mkBlockHost([]);           // keine Blöcke auffindbar
  const last = mkHostedBlock(container, 0);
  const block = resolveActiveBlock({
    container, sel: null, visibleBlocks: new Set(),
    granularity: 'paragraph', lastBlock: last,
  });
  assert.equal(block, last);
});

test('resolveActiveBlock: kein Halten in typewriter-only / bei abgehängtem Block', () => {
  const container = mkBlockHost([]);
  const last = mkHostedBlock(container, 0);
  assert.equal(resolveActiveBlock({
    container, sel: null, visibleBlocks: new Set(),
    granularity: 'typewriter-only', lastBlock: last,
  }), null);
  const detached = mkHostedBlock(null, 0);          // nicht mehr im Container
  assert.equal(resolveActiveBlock({
    container, sel: null, visibleBlocks: new Set(),
    granularity: 'paragraph', lastBlock: detached,
  }), null);
});

// --- caretWithinViewport ----------------------------------------------------

test('caretWithinViewport: innerhalb / ausserhalb / ohne Bezug', () => {
  const vp = { top: 0, height: 400 };
  assert.equal(caretWithinViewport({ top: 180, bottom: 220 }, vp), true);
  assert.equal(caretWithinViewport({ top: 420, bottom: 460 }, vp), false);   // unter der Tastatur
  assert.equal(caretWithinViewport({ top: -40, bottom: 0 }, vp), false);     // über dem Rand
  // Kein Bezugsrechteck (kein visualViewport, Höhe 0) → nichts zu retten.
  assert.equal(caretWithinViewport({ top: 999, bottom: 1040 }, null), true);
  assert.equal(caretWithinViewport({ top: 999, bottom: 1040 }, { top: 0, height: 0 }), true);
});

test('caretWithinViewport: Sicherheitsband zieht den Rand nach innen', () => {
  const vp = { top: 0, height: 400 };
  // Ohne Band noch drin, mit 40px Band (eine Zeile) bereits „zu nah am Rand".
  assert.equal(caretWithinViewport({ top: 350, bottom: 390 }, vp), true);
  assert.equal(caretWithinViewport({ top: 350, bottom: 390 }, vp, 40), false);
});

test('caretWithinViewport: Band auf Viewport-Viertel geklemmt', () => {
  // Flacher Viewport (Mobile mit offener Tastatur) + grosses Band würde sonst
  // die ganze Fläche auffressen → jede Position gälte als ausserhalb und der
  // Typewriter würde während der Composition bei jedem Zeichen scrollen.
  const vp = { top: 0, height: 100 };
  assert.equal(caretWithinViewport({ top: 40, bottom: 60 }, vp, 400), true);
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

// --- resolveGutterCaretPoint ------------------------------------------------
//
// Klick in die leere Seitenfläche: y bleibt auf der Zeile, x wandert an den Rand
// der Textspalte (dort trifft caretRangeFromPoint erstes/letztes Zeichen).

// Textspalte 300–700 px; zwei Blöcke à 40 px Höhe mit 20 px Lücke.
const GUTTER_BOX = { left: 300, right: 700 };
const mkBlockRect = (top, bottom) => ({
  getBoundingClientRect: () => ({ top, bottom, height: bottom - top }),
});
const GUTTER_BLOCKS = [mkBlockRect(100, 140), mkBlockRect(160, 200)];

test('resolveGutterCaretPoint: Klick links neben einer Zeile → linker Spaltenrand', () => {
  const pt = resolveGutterCaretPoint(GUTTER_BOX, GUTTER_BLOCKS, 40, 120);
  assert.deepEqual(pt, { x: 301, y: 120 }, 'x an den Spaltenanfang, y unverändert');
});

test('resolveGutterCaretPoint: Klick rechts neben einer Zeile → rechter Spaltenrand', () => {
  const pt = resolveGutterCaretPoint(GUTTER_BOX, GUTTER_BLOCKS, 1200, 180);
  assert.deepEqual(pt, { x: 699, y: 180 });
});

test('resolveGutterCaretPoint: Kopf-/Tail-Puffer bleibt inert', () => {
  assert.equal(resolveGutterCaretPoint(GUTTER_BOX, GUTTER_BLOCKS, 40, 20), null, 'über dem ersten Block');
  assert.equal(resolveGutterCaretPoint(GUTTER_BOX, GUTTER_BLOCKS, 40, 900), null, 'unter dem letzten Block');
});

test('resolveGutterCaretPoint: Klick in die Absatz-Lücke nimmt den nächsten Block', () => {
  // y=145 liegt 5 px unter Block 1 und 15 px über Block 2 → Block 1, geclamped
  // auf dessen Unterkante − 1.
  assert.deepEqual(resolveGutterCaretPoint(GUTTER_BOX, GUTTER_BLOCKS, 40, 145), { x: 301, y: 139 });
  // y=155 liegt näher an Block 2 → dessen Oberkante + 1.
  assert.deepEqual(resolveGutterCaretPoint(GUTTER_BOX, GUTTER_BLOCKS, 40, 155), { x: 301, y: 161 });
});

test('resolveGutterCaretPoint: Höhe-0-Blöcke zählen nicht, leerer Satz → null', () => {
  assert.equal(resolveGutterCaretPoint(GUTTER_BOX, [mkBlockRect(100, 100)], 40, 100), null);
  assert.equal(resolveGutterCaretPoint(GUTTER_BOX, [], 40, 120), null);
});

test('resolveGutterCaretPoint: kaputte Content-Box → null (kein Caret-Sprung)', () => {
  assert.equal(resolveGutterCaretPoint({ left: 500, right: 500 }, GUTTER_BLOCKS, 40, 120), null);
  assert.equal(resolveGutterCaretPoint(null, GUTTER_BLOCKS, 40, 120), null);
});
