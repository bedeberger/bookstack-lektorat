// Block-Elemente, die als „aktiver Absatz" erkannt werden. TABLE-Zellen und
// FIGURE/FIGCAPTION zählen mit, damit Klicks in Tabellen/Bildunterschriften
// nicht auf Viewport-Center zurückfallen. DIV bewusst NICHT drin – Chromium-
// Default-Paragraph-Separator soll <p> erzeugen; DIV würde die Garantie
// aushebeln.
export const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'LI', 'PRE',
  'TD', 'TH', 'FIGURE', 'FIGCAPTION',
]);
export const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, pre, td, th, figure, figcaption';

export const POINTER_GRACE_MS = 300;
export const VV_DEBOUNCE_MS = 100;
export const CURSOR_HIDE_MS = 2000;

// Popover-/Menü-Wurzeln, die den Auto-Hide-Cursor pausieren: solange eines davon
// offen ist, muss der Zeiger sichtbar bleiben — man liest gerade Vorschläge und
// will sie anklicken. `.tip-layer` steht bewusst NICHT drin: der Tooltip-Layer
// wird einmal erzeugt und bleibt dauerhaft im DOM (nur Inhalt/Position wechseln),
// er würde Auto-Hide permanent aushebeln. Pendant im CSS:
// `.focus-cursor-hidden`-Regel in public/css/editor/focus/focus-mode.css.
export const CURSOR_KEEP_SEL = '.lt-popover, .synonym-menu, .synonym-picker, .figur-lookup';

// Schwelle dynamisch aus computed line-height. Im Fokusmodus ist font-size
// 1.45rem, line-height 1.85 → ~42px. Statisches 16px scrollte schon bei
// subpixel-Jitter; halbe Zeilenhöhe ist die natürliche Grenze für „echter
// Zeilenwechsel". 16 dient als Fallback, falls computed style nicht greifbar.
export const TYPEWRITER_THRESHOLD_PX = 16;

export const HAS_IO = typeof IntersectionObserver !== 'undefined';
export const HAS_MO = typeof MutationObserver !== 'undefined';

export function prefersReducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

export function reportError(tag, err) {
  // Zentraler Error-Sink, damit späteres Telemetry-Hook an einer Stelle eingeklinkt werden kann.
  try { console.error('[focus:' + tag + ']', err); } catch { /* last-resort swallow */ }
}
