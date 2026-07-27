// Typewriter-Scroll: hält die Cursor-Zeile auf einer konfigurierbaren
// vertikalen Anker-Position des sichtbaren Bildschirms (Default Mitte,
// anchorRatio 0.5).
//
// Schwelle dynamisch aus computed line-height — Tippen innerhalb derselben
// Zeile löst dank Caret-Rect-Jitter sonst Mini-Scrolls aus, die den Editor
// unruhig wirken lassen.

import { TYPEWRITER_THRESHOLD_PX, prefersReducedMotion } from './constants.js';

export { TYPEWRITER_THRESHOLD_PX };

// Normalisiert den Anker-Ratio auf [0,1]. Ungültig/nicht gesetzt → 0.5 (Mitte),
// damit das Default-Verhalten pixelidentisch zur fixen Mitten-Variante bleibt.
function normAnchorRatio(r) {
  return Number.isFinite(r) && r >= 0 && r <= 1 ? r : 0.5;
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

export function typewriterScroll(container, targetRect, ctx, threshold = TYPEWRITER_THRESHOLD_PX, anchorRatio = 0.5) {
  if (!container || !targetRect) return 0;
  const delta = computeTypewriterDelta(container.getBoundingClientRect(), targetRect, threshold, anchorRatio, visibleViewportRect());
  if (delta === 0) return 0;
  const before = container.scrollTop;
  // prefers-reduced-motion: User hat System-weit angegeben „kein Animation-
  // Overhead". Zwei-Schritt-Scroll überspringen und direkt den Zielwert
  // setzen, damit aktiver Absatz trotzdem passt.
  if (prefersReducedMotion()) container.scrollTop = before + delta;
  else container.scrollBy({ top: delta, behavior: 'auto' });
  // `behavior: 'auto'` schreibt scrollTop synchron — die tatsächlich gefahrene
  // Strecke ist hier bereits messbar. Nur ein Scroll, der die Position wirklich
  // verschoben hat, feuert später ein scroll-Event; nur der darf im Counter
  // angekündigt werden. Am Scroll-Anschlag (kurzer Tail-Puffer, letzter Absatz)
  // ist der Aufruf ein No-op: würde er trotzdem gezählt, bliebe `expectedScroll`
  // dauerhaft > 0 und `onScroll` verschluckte danach jeden echten User-Scroll —
  // das Spotlight bliebe beim Blättern stehen und der Zähler wüchse pro
  // Tastendruck weiter.
  const moved = container.scrollTop - before;
  // Container hat sich nicht bewegt UND kann grundsätzlich nicht scrollen →
  // fremde Scroll-Box (siehe scrollFallbackTarget). Am regulären Scroll-Anschlag
  // (Box ist scrollbar, steht nur am Ende) greift der Pfad bewusst nicht.
  if (moved === 0 && !canScroll(container)) {
    const fb = scrollFallbackTarget(container);
    if (fb) {
      const fbBefore = fb.scrollTop;
      if (prefersReducedMotion()) fb.scrollTop = fbBefore + delta;
      else fb.scrollBy({ top: delta, behavior: 'auto' });
      // Kein expectedScroll-Increment: das scroll-Event feuert am Fallback-Ziel,
      // nicht am Container — `onScroll` hängt aber nur am Container.
      return fb.scrollTop - fbBefore;
    }
  }
  if (ctx && moved !== 0) ctx.expectedScroll++;
  return moved;
}
