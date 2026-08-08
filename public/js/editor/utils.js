// Gemeinsame Utilities für die Editor-Module (find, synonyme, figur-lookup,
// toolbar): Wort-Regex, Namens-Normalisierung, Caret-Setup,
// Popup-Positionierung und Reflow-Listener.

import { getActiveEditorContainer } from './shared/active-editor.js';

// Ein "Einzelwort" ist eine zusammenhängende Sequenz aus Buchstaben/Ziffern.
// Bindestriche und Apostrophe zählen mit, damit «auf-/abwärts» oder «wir's» erfasst werden.
export const WORD_RE = /^[\p{L}\p{N}][\p{L}\p{N}\-']*$/u;

// Test, ob ein Zeichen Teil eines Wortes ist (inkl. Bindestrich/Apostroph).
export const isWordChar = (c) => /[\p{L}\p{N}\-']/u.test(c);

// NFD-normalisierter, diakritikafreier Lowercase-String für lookup-Vergleiche.
export function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

export function getEditEl() {
  return getActiveEditorContainer();
}

// Setzt den Cursor in ein (oft frisch transformiertes, leeres) Blockelement.
// Bei <p><br></p>-Mustern erwartet der Browser die Position auf dem
// Elternelement mit Offset 0 – dort erscheint der Cursor sichtbar.
export function placeCaretIn(el) {
  const sel = document.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(el, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Setzt den Cursor unmittelbar HINTER `node`. Nach jedem programmatischen
// Einfügen nötig: der Browser lässt den Caret sonst vor dem eingefügten Knoten
// stehen, und der User tippt in das frisch gesetzte Element hinein statt
// dahinter weiterzuschreiben.
export function placeCaretAfter(node) {
  const doc = node?.ownerDocument || document;
  const sel = doc.getSelection?.() || document.getSelection();
  if (!sel || !node) return;
  const range = doc.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Aktuelle Selektions-/Caret-Range, sofern sie IM Edit-Feld liegt — sonst null.
// Der Containment-Test ist Pflicht, weil `document.getSelection()` global ist
// und auch eine Auswahl in Sidebar, Modal oder Chat liefert.
export function caretRangeIn(editEl) {
  if (!editEl) return null;
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const c = range.commonAncestorContainer;
  return (editEl === c || editEl.contains(c)) ? range : null;
}

// Kollabierte Range am ENDE des Editorinhalts — ohne die Selektion anzufassen.
// Rückfallanker für alle Einfügewege, die ohne gesetzten Caret ausgelöst werden
// (Beleg-Picker aus der Seiten-Toolbar, Diktat-Start ohne Klick ins Feld):
// lieber ans Ende anhängen als gar nichts tun — den Block danach zu verschieben
// ist ein Handgriff, ihn erneut herauszusuchen nicht.
export function rangeAtEnd(editEl) {
  if (!editEl) return null;
  const doc = editEl.ownerDocument || document;
  const range = doc.createRange();
  range.selectNodeContents(editEl);
  range.collapse(false);
  return range;
}

// Wie `rangeAtEnd`, setzt den Caret aber auch wirklich dorthin. Für Wege, bei
// denen der User anschliessend IM Editor weiterarbeitet (Diktat-Start) — im
// Unterschied zu den Panels, die den Fokus selbst übernehmen und die Selektion
// darum nicht verschieben dürfen.
export function anchorCaretToEnd(editEl) {
  const range = rangeAtEnd(editEl);
  if (!range) return null;
  const sel = (editEl.ownerDocument || document).getSelection?.() || document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return range;
}

// Expandiert einen Punkt (clientX/Y) zum darunterliegenden Wort und liefert
// sowohl das Wort als auch einen Range über genau dieses Wort. Wird vom
// Synonym-Handler genutzt (Safari-Rechtsklick ohne Selection markiert das
// Wort unter dem Cursor automatisch) und vom Figuren-Lookup.
export function rangeForWordAtClientPoint(x, y) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (!range) return null;
  const node = range.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.nodeValue || '';
  if (!text) return null;
  let start = range.startOffset;
  let end   = range.startOffset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return null;
  const word = text.slice(start, end);
  if (!WORD_RE.test(word)) return null;
  const wordRange = document.createRange();
  wordRange.setStart(node, start);
  wordRange.setEnd(node, end);
  return { range: wordRange, word };
}

// Hängt scroll (capture) + resize an window und gibt eine Teardown-Fn zurück.
// Capture-Phase, damit Scrolls in inneren Containern (edit area, focus mode)
// auch erfasst werden. Wird von Popups (Synonym, Figuren-Lookup, Find-Widget)
// genutzt, um sich beim Scrollen mitzuneubrechen.
export function attachReflow(handler) {
  const ctrl = new AbortController();
  const { signal } = ctrl;
  window.addEventListener('scroll', handler, { capture: true, signal });
  window.addEventListener('resize', handler, { signal });
  return () => ctrl.abort();
}

// Berechnet eine Popup-Position relativ zu einem Anker-Rect (oder Punkt-Rect
// mit width/height = 0). Flippt nach oben, wenn unten kein Platz ist; clamped
// horizontal an die Viewport-Grenzen. Liefert ganzzahlige Pixelwerte.
//
// `popupEl` kann null sein — dann werden `fallback*`-Dimensionen genutzt.
// `gap` ist der Abstand zum Anker (in Pixeln). `padding` der Abstand zum
// Viewport-Rand.
export function positionPopupNearRect(rect, popupEl, opts = {}) {
  const { gap = 4, padding = 8, fallbackWidth = 280, fallbackHeight = 200 } = opts;
  const w = popupEl?.offsetWidth  || fallbackWidth;
  const h = popupEl?.offsetHeight || fallbackHeight;
  const spaceBelow = window.innerHeight - rect.bottom;
  const placeBelow = spaceBelow >= h + gap;
  const x = Math.max(padding, Math.min(Math.round(rect.left), window.innerWidth - w - padding));
  const y = placeBelow
    ? Math.round(rect.bottom + gap)
    : Math.max(padding, Math.round(rect.top - h - gap));
  return { x, y, placeBelow };
}
