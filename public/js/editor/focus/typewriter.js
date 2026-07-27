// Typewriter-Scroll: hält die Cursor-Zeile auf einer konfigurierbaren
// vertikalen Anker-Position des sichtbaren Bildschirms (Default Mitte,
// anchorRatio 0.5).
//
// Schwelle dynamisch aus computed line-height — Tippen innerhalb derselben
// Zeile löst dank Caret-Rect-Jitter sonst Mini-Scrolls aus, die den Editor
// unruhig wirken lassen.

import { TYPEWRITER_THRESHOLD_PX } from './constants.js';

export { TYPEWRITER_THRESHOLD_PX };

// Normalisiert den Anker-Ratio auf [0,1]. Ungültig/nicht gesetzt → 0.5 (Mitte),
// damit das Default-Verhalten pixelidentisch zur fixen Mitten-Variante bleibt.
export function normAnchorRatio(r) {
  return Number.isFinite(r) && r >= 0 && r <= 1 ? r : 0.5;
}

// Der Anker ist zugleich Scroll-Ziel (hier) und Layout-Grösse (Kopf-/Tail-Puffer
// in focus-mode.css). Damit es dafür genau EINE Zahl gibt, schreibt der
// Controller ihn beim Eintritt als Custom-Property auf `:root`; die Puffer-
// Formeln leiten sich daraus ab (Invariante 9). Ohne diese Kopplung müsste jede
// Anker-Änderung in CSS nachgezogen werden — und ein Anker ≠ 0.5 klemmte den
// Typewriter an Seitenanfang/-ende.
export const ANCHOR_CSS_VAR = '--focus-anchor';

export function publishAnchorRatio(ratio) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty(ANCHOR_CSS_VAR, String(normAnchorRatio(ratio)));
}

export function clearAnchorRatio() {
  if (typeof document === 'undefined') return;
  document.documentElement.style.removeProperty(ANCHOR_CSS_VAR);
}

export function dynamicTypewriterThreshold(block, fallback = TYPEWRITER_THRESHOLD_PX) {
  if (!block || typeof window === 'undefined' || !window.getComputedStyle) return fallback;
  try {
    const lh = parseFloat(window.getComputedStyle(block).lineHeight);
    if (Number.isFinite(lh) && lh > 0) return Math.max(fallback, lh * 0.5);
  } catch { /* ignore */ }
  return fallback;
}

// Threshold pro Block gecacht: die line-height (→ Threshold) ändert sich nur bei
// Blockwechsel oder Resize (Media-Query-Breakpoint), nicht beim Tippen. So läuft
// getComputedStyle nur bei Blockwechsel statt pro Keystroke. `cache` ist ein
// { block, value }; der Aufrufer setzt cache.value bei Resize auf null zurück.
export function cachedTypewriterThreshold(block, cache, fallback = TYPEWRITER_THRESHOLD_PX) {
  if (cache && cache.value != null && cache.block === block) return cache.value;
  const value = dynamicTypewriterThreshold(block, fallback);
  if (cache) { cache.block = block; cache.value = value; }
  return value;
}

// Range um 1 Position erweitern, Rect lesen, Probe wegwerfen. Browser liefern
// für collapsed Ranges am Soft-Wrap-Bruch / direkt nach <br> regelmässig
// leere getClientRects() und Höhe-0-BoundingClientRect. Eine non-collapsed
// Probe-Range liefert deterministisch den Rect der angrenzenden Glyphe — und
// damit die korrekte visuelle Zeile.
function expandRangeRect(range) {
  const node = range.startContainer;
  if (!node) return null;
  const off = range.startOffset;
  const len = node.nodeType === 3 ? (node.nodeValue || '').length : node.childNodes.length;
  const probe = range.cloneRange();
  try {
    if (off < len) probe.setEnd(node, off + 1);
    else if (off > 0) probe.setStart(node, off - 1);
    else return null;
  } catch { return null; }
  const rects = probe.getClientRects();
  if (rects.length > 0 && rects[0].height > 0) return rects[0];
  const bb = probe.getBoundingClientRect();
  if (bb && bb.height > 0) return bb;
  return null;
}

// Liefert das Rect der visuellen Zeile, in der der Caret sitzt. Drei Stufen:
// 1) `getClientRects()[0]` — schnellster Pfad, deckt 95 % der Fälle.
// 2) `getBoundingClientRect()` — Fallback wenn Step 1 leer (manche Browser).
// 3) **Range um 1 Zeichen expandieren** — fängt collapsed-Range-Bug am
//    Soft-Wrap-Bruch und direkt nach `<br>`: dort liefern Browser sonst Höhe 0
//    bzw. leere Rect-Liste, der Recenter würde auf Block-BBox zurückfallen
//    (Block-Mitte stillgestanden → Typewriter scrollte bei langem Absatz mit
//    Soft-Wraps oder shift-enter-Bruchen nicht mit).
export function getCaretRect(container, selection) {
  const sel = selection || (typeof document !== 'undefined' ? document.getSelection() : null);
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container || !container.contains(range.startContainer)) return null;
  const rects = range.getClientRects();
  if (rects.length > 0 && rects[0].height > 0) return rects[0];
  const rect = range.getBoundingClientRect();
  if (rect && rect.height > 0) return rect;
  return expandRangeRect(range);
}

// Sichtbarer Bildschirmausschnitt in Client-Koordinaten (`{ top, height }`).
// `visualViewport` ist die Wahrheit: die Mobile-Tastatur schrumpft ihn und Android
// Chrome verschiebt ihn zusätzlich (`offsetTop`). Ohne API → Layout-Window.
export function visibleViewportRect() {
  if (typeof window === 'undefined') return null;
  const vv = window.visualViewport;
  if (vv && vv.height > 0) return { top: vv.offsetTop || 0, height: vv.height };
  const h = window.innerHeight;
  return h > 0 ? { top: 0, height: h } : null;
}

// Anker-Y in Client-Koordinaten. Bezug ist der sichtbare Bildschirm, NICHT die
// Scroll-Box: die Box beginnt unter der Focus-Topbar, ihre Mitte liegt damit um
// die halbe Topbar-Höhe unter der Bildschirmmitte — die Schreiblinie wirkt „zu
// tief". Mobil mit offener Tastatur ist der Unterschied gross, weil die Box
// hinter der Tastatur weiterläuft. In die Box geclampt, damit der Anker vom
// Caret überhaupt erreichbar bleibt.
function anchorY(containerRect, viewportRect, ratio) {
  const base = viewportRect && viewportRect.height > 0 ? viewportRect : containerRect;
  const y = base.top + base.height * ratio;
  return Math.min(Math.max(y, containerRect.top), containerRect.top + containerRect.height);
}

// Pure: wie weit muss gescrollt werden, damit targetRect auf der Anker-Position
// sitzt? `anchorRatio` ist der relative vertikale Anker (0 = oben, 0.5 = Mitte
// [Default], 0.33 = oberes Drittel), `viewportRect` der Bezugsausschnitt (ohne
// Angabe: containerRect). Unter Schwelle → no-op. Schwelle ist grob eine halbe
// Zeilenhöhe, damit Tippen innerhalb derselben Textzeile (Caret-Rect-Jitter,
// subpixel-Shifts) keinen Mini-Scroll auslöst und der Editor „ruhig" wirkt; die
// Ruheposition der Schreibzeile bleibt dadurch exakt der Anker.
export function computeTypewriterDelta(containerRect, targetRect, threshold = TYPEWRITER_THRESHOLD_PX, anchorRatio = 0.5, viewportRect = null) {
  if (!containerRect || !targetRect) return 0;
  const ratio = normAnchorRatio(anchorRatio);
  const targetCenter = targetRect.top + targetRect.height / 2;
  const delta = targetCenter - anchorY(containerRect, viewportRect, ratio);
  return Math.abs(delta) < threshold ? 0 : delta;
}

// Liegt die Caret-Zeile im sichtbaren Bereich, mit `margin` Sicherheitsband an
// beiden Rändern? Pure. Ohne Bezugsrechteck → true (nichts zu retten). Das Band
// wird auf ein Viertel der Höhe geklemmt, damit es auf sehr flachen Viewports
// (Mobile mit offener Tastatur) nicht die ganze Fläche auffrisst und damit
// jede Position als „ausserhalb" gälte.
export function caretWithinViewport(targetRect, viewportRect, margin = 0) {
  if (!targetRect || !viewportRect || !(viewportRect.height > 0)) return true;
  const m = Math.max(0, Math.min(margin, viewportRect.height / 4));
  return targetRect.top >= viewportRect.top + m
    && targetRect.bottom <= viewportRect.top + viewportRect.height - m;
}

function canScroll(el) {
  return !!el && el.scrollHeight > el.clientHeight + 1;
}

// Fremde Schalen (native Clients) bringen eigenes Host-CSS mit und können das
// Layout so überschreiben, dass nicht `.focus-editor__content` die Scroll-Box
// ist, sondern ein Vorfahr oder das Dokument. Unlayered Host-Regeln schlagen
// dabei jede Regel aus focus-mode.css (`@layer components`), unabhängig von
// Spezifität — der Editor kann sich also nicht per CSS dagegen wehren. Ohne
// diesen Rettungspfad wäre `container.scrollBy` dort ein No-op und der
// Typewriter komplett tot.
function scrollFallbackTarget(container) {
  let el = container && container.parentElement;
  while (el) {
    if (canScroll(el)) {
      let oy = 'auto';
      try { oy = window.getComputedStyle(el).overflowY; } catch { /* ignore */ }
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return el;
    }
    el = el.parentElement;
  }
  if (typeof document === 'undefined') return null;
  const doc = document.scrollingElement || document.documentElement;
  return canScroll(doc) ? doc : null;
}

// Welche Box scrollt tatsächlich? Normalfall ist der Container selbst; kann er
// grundsätzlich nicht scrollen, hat eine fremde Schale das Layout umgebogen und
// der nächste scrollbare Vorfahr bzw. das Dokument übernimmt.
//
// `canScroll` ist dafür ein verlässlicher Diskriminator, obwohl es nur den
// Ist-Zustand misst: die Kopf-/Tail-Puffer auf `.focus-editor__content`
// (Invariante 9) sind zusammen ~1.5 Bildschirmhöhen, eine Box mit intakter
// Höhenkette ist damit auch bei leerer Seite scrollbar. Bleibt scrollHeight ===
// clientHeight, ist die Kette gebrochen — und genau dann greift der Rettungspfad.
//
// SSoT für alle Konsumenten: der Typewriter scrollt sie, `installFocusListeners`
// hängt IntersectionObserver-`root` daran und `onScroll` filtert darauf.
export function resolveScrollBox(container) {
  if (!container) return null;
  if (canScroll(container)) return container;
  return scrollFallbackTarget(container) || container;
}

// Scrollt `box` auf eine absolute Position, garantiert ohne Animation, und
// liefert die tatsächlich gefahrene Strecke.
//
// `behavior: 'instant'` ist Pflicht und NICHT `'auto'`: `'auto'` delegiert laut
// CSSOM-View an die computed `scroll-behavior` des Elements. Eine fremde Schale
// mit unlayered `scroll-behavior: smooth` im Host-CSS (Bundle-CSS liegt in
// `@layer components` und verliert dagegen) animierte den Scroll dann — direkt
// danach steht `scrollTop` noch auf dem alten Wert, die gefahrene Strecke misst
// 0, es wird keine prog-Marke gesetzt, und das später eintreffende scroll-Event
// gilt als User-Scroll und reisst das Spotlight auf den Center-Block. Im Web
// deckt das nur der `prefers-reduced-motion`-Block in layout/base.css ab, den
// weder die Schalen noch die Test-Harness laden.
//
// Der catch-Zweig fängt Engines, die den Enum-Wert `'instant'` nicht kennen —
// dort wirft schon die Options-Dictionary-Konversion (TypeError).
function scrollBoxTo(box, top) {
  const before = box.scrollTop;
  try { box.scrollTo({ top, behavior: 'instant' }); }
  catch { box.scrollTop = top; }
  return box.scrollTop - before;
}

// Toleranz beim Wiedererkennen des eigenen Scrolls: `scrollTop` ist in Chromium
// subpixel-genau, ein Rundungsrest darf die Marke nicht entwerten.
const PROG_SCROLL_EPS = 1;

// Hat dieses `scroll`-Event der Typewriter selbst ausgelöst? Die Marke ist die
// zuletzt selbst geschriebene Scroll-Position **samt der Box, die sie trägt**
// (`ctx.progScroll = { box, top }`) — im Fallback-Fall scrollt nicht der
// Container, sondern ein Vorfahr, und das Event feuert dort.
//
// Die Marke wird bei JEDEM Event verbraucht, auch wenn sie zu einer anderen Box
// gehört: Position statt Zähler, damit ein verlorenes oder zusätzliches Event
// höchstens einen Tick kostet. Ein Zähler bliebe im Fehlerfall dauerhaft
// desynchron und liesse `onScroll` danach jeden echten User-Scroll verschlucken
// (Spotlight bleibt beim Blättern stehen).
export function consumeProgrammaticScroll(box, ctx) {
  if (!ctx) return false;
  const mark = ctx.progScroll;
  ctx.progScroll = null;
  if (!mark || !box || mark.box !== box) return false;
  return Math.abs(box.scrollTop - mark.top) <= PROG_SCROLL_EPS;
}

export function typewriterScroll(container, targetRect, ctx, threshold = TYPEWRITER_THRESHOLD_PX, anchorRatio = 0.5) {
  if (!container || !targetRect) return 0;
  // Geometrie bleibt am Container gemessen — das Delta ist eine Bildschirm-
  // Strecke und gilt unabhängig davon, welche Box sie danach fährt.
  const delta = computeTypewriterDelta(container.getBoundingClientRect(), targetRect, threshold, anchorRatio, visibleViewportRect());
  if (delta === 0) return 0;
  const box = resolveScrollBox(container);
  if (!box) return 0;
  // Nur ein Scroll, der die Position wirklich verschoben hat, feuert später ein
  // scroll-Event; nur der darf eine Marke setzen. Am Scroll-Anschlag (letzter
  // Absatz) ist der Aufruf ein No-op — und `resolveScrollBox` liefert dort
  // weiterhin den Container, nicht den Vorfahr: die Box KANN scrollen, sie steht
  // nur am Ende. Ein Fallback zöge sonst die Seite unter dem Editor weg.
  const moved = scrollBoxTo(box, box.scrollTop + delta);
  if (ctx && moved !== 0) ctx.progScroll = { box, top: box.scrollTop };
  return moved;
}
