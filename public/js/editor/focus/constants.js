import { composeBlockSel } from '../shared/dom-block.js';

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
// Selektor-Pendant zu BLOCK_TAGS oben, komponiert aus dem gemeinsamen Kern in
// shared/dom-block.js. Unterscheidet sich bewusst von `CARET_BLOCK_SEL`
// (Notebook-Caret-Lookup): hier zählen `td`/`th`/`figure`/`figcaption` mit,
// `div.poem` dagegen nicht. Deshalb trägt er einen eigenen Namen — vorher hiess
// er wie der Notebook-Selektor und `focus/soft-newlines.js` griff unbemerkt zum
// anderen.
export const FOCUS_BLOCK_SEL = composeBlockSel('pre', 'td', 'th', 'figure', 'figcaption');

export const POINTER_GRACE_MS = 300;
// Touch-Eingabe braucht mehr Karenz: das Setzen des Carets per Fingertipp
// erzeugt auf langsamen Geräten (und über die Soft-Keyboard-Animation hinweg)
// erst deutlich nach `pointerup` ein `selectionchange`. Mit der Maus-Karenz
// wäre das Flag dann schon abgelaufen und die getippte Stelle würde weggerissen.
export const POINTER_GRACE_TOUCH_MS = 700;
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
// `var(--font-size-xl)` (22px), line-height 1.85 → ~41px. Statisches 16px scrollte schon bei
// subpixel-Jitter; halbe Zeilenhöhe ist die natürliche Grenze für „echter
// Zeilenwechsel". 16 dient als Fallback, falls computed style nicht greifbar.
export const TYPEWRITER_THRESHOLD_PX = 16;

// Der Toggle-Chord des Fokusmodus, Cmd/Ctrl+Shift+E. Zwei Handler hören darauf:
// der Body-Listener im Lese-/Edit-Modus (trampoline.js#handleFocusHotkey) und
// der Window-Listener innerhalb des Fokusmodus (listeners.js#onKey). Eine
// gemeinsame Definition, damit die beiden nicht auseinanderdriften und der
// Modus per Tastatur nur noch in eine Richtung erreichbar wäre.
// `code` statt `key`: auf nicht-QWERTZ-Layouts (und mit Shift) liefert `key`
// nicht zuverlässig 'E'.
export function isFocusToggleChord(e) {
  return !!e && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyE';
}

// Vorrang-Regel aus Invariante 16: ein laufender Save und offene Popover gehen
// dem Verlassen per Tastatur vor. Geteilt von den BEIDEN Wegen, auf denen der
// Toggle-Chord im Fokusmodus ankommt — dem Body-Listener
// (trampoline.js#handleFocusHotkey) und dem Container-Listener
// (listeners.js#onKey). Ein Guard in nur einem der beiden wäre wirkungslos: der
// jeweils andere ruft `exitFocusMode` trotzdem, und die Methode selbst kennt
// ausser dem State-Guard keine Vorbedingung.
//
// Der Escape-Zweig in listeners.js#onKey prüft dieselben Felder bewusst inline:
// er blockt nicht nur, sondern schliesst zusätzlich den Figur-Lookup. Wer diese
// Liste erweitert, zieht ihn mit.
export function isFocusExitBlocked(app) {
  if (!app) return false;
  return !!(app._synonymMenuOpen || app._synonymPickerOpen || app._figurLookupOpen || app.editSaving);
}

export const HAS_IO = typeof IntersectionObserver !== 'undefined';
export const HAS_MO = typeof MutationObserver !== 'undefined';

export function reportError(tag, err) {
  // Zentraler Error-Sink, damit späteres Telemetry-Hook an einer Stelle eingeklinkt werden kann.
  try { console.error('[focus:' + tag + ']', err); } catch { /* last-resort swallow */ }
}
