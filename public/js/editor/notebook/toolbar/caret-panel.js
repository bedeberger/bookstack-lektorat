// Bausteine der caret-verankerten Panels des Notebook-Editors: Link-Bar
// (bubble.js), Beleg-Picker (cite.js), Querverweis-Picker (xref.js) und
// Diagramm-Dialog (diagram.js).
//
// Die vier folgen derselben Choreografie — Range beim Öffnen sichern, Panel über
// der Range verankern, beim Übernehmen an genau dieser Range einfügen, Caret
// dahinter setzen, schliessen und den Editor wieder fokussieren. Ausgeschrieben
// wurde davon jeder Schritt mehrfach; hier steht er einmal.
//
// Nur Notebook: Focus-Editor und Bucheditor stellen die erzeugten Marker dar,
// bringen aber keinen Einfügepfad mit (harte Regel „Editor-Spezifikation").
//
// Was hier NICHT hingehört: was gesucht, formatiert und eingefügt wird. Das ist
// je Panel genuin verschieden und bleibt in cite.js/xref.js/bubble.js.

import { findBlock } from '../../shared/dom-block.js';
import { placeCaretAfter } from '../../utils.js';

export { placeCaretAfter };

// ── Panel-Position ────────────────────────────────────────────────────────

// Ankerpunkt (Viewport-Koordinaten) für ein Panel über `range`. Eine kollabierte
// Range hat kein Rechteck — dann auf den umgebenden Block ausweichen, sonst
// klebte das Panel in der linken oberen Ecke.
export function panelAnchorFor(range, editEl) {
  let rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    const block = findBlock(range.startContainer, editEl) || editEl;
    rect = block.getBoundingClientRect();
  }
  return { x: rect.left + rect.width / 2, y: rect.top };
}

// ── HTML einfügen ─────────────────────────────────────────────────────────
//
// IMMER über die Range-/DOM-API, NIE über execCommand('insertHTML'): Chromium
// schleust den Fragment-String durch seinen Editing-Sanitizer, der `class` und
// `data-*` verwirft und die berechneten CSS-Werte der Klasse als Inline-`style`
// einbäckt. Aus einem Beleg-Chip würde `<span style="color: rgb(...)">` — der
// `data-src`-Zeiger (die Wahrheit) wäre weg, und das `style`-Attribut verstiesse
// gegen „Styles nur in public/css" und wäre im Dark-Mode falsch. Dieselbe
// Chromium-Eigenheit steckt hinter der Blockgrenzen-Löschbehandlung
// (docs/notebook-editor.md, Invarianten 17+18).

// Markup-String zu einem DocumentFragment. `lastNode` ist der letzte erzeugte
// Knoten — der Anker für den Caret danach.
export function htmlToFragment(html, doc = document) {
  const holder = doc.createElement('div');
  holder.innerHTML = html;
  const frag = doc.createDocumentFragment();
  while (holder.firstChild) frag.appendChild(holder.firstChild);
  return { frag, lastNode: frag.lastChild };
}

// Markup-String zu genau EINEM Element (null, wenn das Markup keines liefert).
// Für die Panels, die einen bestehenden Knoten ersetzen statt einzufügen.
export function htmlToElement(html, doc = document) {
  const holder = doc.createElement('div');
  holder.innerHTML = html;
  return holder.firstElementChild;
}

// Geschütztes Leerzeichen als benannte Konstante. Der Beleg-Chip trennt damit
// (statt mit einem gewöhnlichen Leerzeichen), weil er `contenteditable="false"`
// und `white-space: nowrap` trägt: ein normales Leerzeichen direkt hinter einem
// atomaren Inline-Element am Blockende kollabiert weg und lässt keinen
// Caret-Slot übrig, in den der User weiterschreiben könnte. Steht die Quelle am
// Absatzende, trimmt der Server-Cleaner es beim Speichern (stripBlockEdgeNbsp).
//
// Als Literal im Quelltext war das ein unsichtbares Zeichen — hier hat es einen
// Namen. Der Querverweis benutzt bewusst weiterhin ein gewöhnliches Leerzeichen
// (`after: ' '`): er ist Fliesstext im Satz, kein abgesetzter Nachweis.
export const NBSP = '\u00A0';

/**
 * Markup an einer gesicherten Range einfügen und den Caret dahinter setzen.
 *
 * @param {Range} range
 * @param {string} html
 * @param {object} [opts]
 * @param {string}  [opts.after]           Trennzeichen hinter dem Markup, damit
 *   der User direkt weiterschreiben kann (siehe NBSP).
 * @param {boolean} [opts.replaceContents] Range-Inhalt löschen statt behalten.
 *   Default false — ein Beleg weist die markierte Stelle NACH, er ersetzt sie
 *   nicht (anders als beim Link, wo die Selektion der Linktext ist).
 * @returns {Node|null} der letzte eingefügte Knoten
 */
export function insertHtmlAtRange(range, html, { after = '', replaceContents = false } = {}) {
  if (!range || !html) return null;
  const doc = range.startContainer?.ownerDocument || document;
  const { frag, lastNode } = htmlToFragment(html + after, doc);
  if (replaceContents) range.deleteContents();
  else if (!range.collapsed) range.collapse(false);
  range.insertNode(frag);
  if (lastNode) placeCaretAfter(lastNode);
  return lastNode;
}

/**
 * Markup ans ENDE eines Hosts hängen (statt an eine Range). Für Belege am
 * Blockzitat: der Kurzbeleg weist dort das ganze Zitat nach, nicht die Stelle,
 * an der der Cursor zufällig stand.
 *
 * Setzt bewusst KEINEN Caret — anders als `insertHtmlAtRange`. Der Host kann
 * hier noch losgelöst vom Dokument sein (O-Ton-Block, der erst danach eingehängt
 * wird), und dann zeigte der Caret auf einen abgehängten Knoten. Aufrufer, die
 * ihn brauchen, rufen `placeCaretAfter(lastNode)` selbst.
 *
 * @returns {Node|null} der letzte angehängte Knoten
 */
export function appendHtmlInto(host, html, { before = '' } = {}) {
  if (!host || !html) return null;
  const doc = host.ownerDocument || document;
  const { frag, lastNode } = htmlToFragment(before + html, doc);
  host.appendChild(frag);
  return lastNode;
}

// ── Trefferliste + Tastatur ───────────────────────────────────────────────

// Zyklisch durch die Trefferliste (↑ am Anfang springt ans Ende und umgekehrt).
export function cycleIdx(idx, delta, len) {
  if (!len) return 0;
  return ((idx + delta) % len + len) % len;
}

// Liste auf `max` kappen. Der Deckel ist Absicht: mehr als ~40 Zeilen scannt
// niemand, und bei dreistelligen Literaturverzeichnissen bzw. langen Büchern
// soll der Picker nicht zur Endlosliste werden.
export function capHits(list, max) {
  return list.length > max ? list.slice(0, max) : list;
}

/**
 * Tastatur-Vertrag aller Picker: Escape schliesst, ↑/↓ bewegen die Auswahl,
 * Enter übernimmt den markierten Treffer. Jeder Zweig ruft `preventDefault` —
 * die Panels liegen über einem contenteditable, wo die Browser-Defaults
 * (Scroll, Zeilenumbruch) den Text verändern würden.
 *
 * @returns {boolean} ob das Event behandelt wurde
 */
export function onPickerKeydown(e, { onClose, onMove, onEnter }) {
  switch (e.key) {
    case 'Escape':    e.preventDefault(); onClose?.(); return true;
    case 'ArrowDown': e.preventDefault(); onMove?.(1); return true;
    case 'ArrowUp':   e.preventDefault(); onMove?.(-1); return true;
    case 'Enter':     e.preventDefault(); onEnter?.(); return true;
    default: return false;
  }
}
