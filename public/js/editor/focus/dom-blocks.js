// Block-Selektion und Markierungs-Helpers für den Fokusmodus.
//
// - Block-Erkennung um Caret bzw. Viewport-Center.
// - Trailing-Paragraph-Slot beim Eintritt in den Fokusmodus.
// - active/near-Markierungen samt Cleanup ohne residuales `class=""`-Attribut
//   (würde sonst BookStack-Revisionen beim nächsten Save erzeugen).

import { BLOCK_TAGS, BLOCK_SEL } from './constants.js';
import { clearSentenceHighlight } from './sentence.js';
import { visibleViewportRect } from './typewriter.js';
import { ensureTrailingParagraph } from '../shared/auto-slot.js';
import { getActiveEditorContainer } from '../shared/active-editor.js';
export { isEmptyParagraph, removeAutoAddedParagraph } from '../shared/auto-slot.js';

// Beim Eintritt in den Fokusmodus: Caret an Buchende. Letzter Absatz schon
// leer → wiederverwenden, sonst neuen `<p><br></p>` anhängen. Slot-DOM-Logik
// lebt in shared/auto-slot.js — gemeinsam mit dem Normal-Editor. Hier bleibt
// nur die Focus-spezifische Erweiterung: Caret an den Slot und Container
// re-fokussieren (Chrome-Caret-Paint-Bug nach Mid-Focus-Mutation).
//
// Positioniert NICHT: das Scrollen auf die Schreiblinie macht der Aufrufer über
// `scrollEntryTargetToAnchor` (recenter.js) mit der Anker-Geometrie des
// Typewriters. Ein `scrollIntoView({block:'center'})` hier wäre eine zweite,
// abweichende Definition von „Zeile in die Mitte" (Box-Mitte statt
// Bildschirm-Anker, Anker ≠ 0.5 ignoriert).
//
// NICHT als dirty markieren – der neue Absatz ist nur ein „Schreib-Slot".
// Bleibt er leer und der User schliesst Focus-Mode wieder, räumt
// exitFocusMode den Slot via removeAutoAddedParagraph ab → keine
// Phantom-Revision im Content-Store.
export function jumpToTrailingParagraph(container) {
  if (!container) return null;
  const added = ensureTrailingParagraph(container);
  const target = added || container.lastElementChild;
  if (!target) return null;
  // Aktiv-Markierung synchron setzen, sonst gilt die Dim-Regel
  // (opacity 0.35) für den frisch erzeugten Slot bis `_focusUpdateActive`
  // im nächsten RAF aufräumt — Caret rendert dann bei 35% Alpha und ist
  // auf leerer Seite optisch unsichtbar. RAF reconciliiert später korrekt.
  target.classList.add('focus-paragraph-active');
  const range = document.createRange();
  range.setStart(target, 0);
  range.collapse(true);
  const sel = document.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  // Chrome verliert nach Mid-Focus-Mutation den Caret-Paint — explizit den
  // contenteditable-Container re-fokussieren. `preventScroll: true`, damit der
  // Browser nicht selbst scrollt: die Positionierung gehört dem Aufrufer.
  if (typeof container.focus === 'function') {
    try { container.focus({ preventScroll: true }); }
    catch { container.focus(); }
  }
  return added;
}

export function getScrollContainer() {
  // Fokusmodus läuft ausschliesslich im Edit-Modus (Guard in enterFocusMode),
  // also ist `--editing` immer der gewünschte Scroll-Container.
  return getActiveEditorContainer();
}

// Gibt den *äussersten* Block-Ancestor unterhalb von `root` zurück. Grund:
// Bei verschachtelten Blöcken (z.B. `<blockquote><p>…</p></blockquote>` oder
// `<li><p>…</p></li>`) würde ein innermost-Match nur den inneren `<p>` aktiv
// markieren. Der äussere Wrapper (`<blockquote>`/`<li>`) bekäme weiter
// opacity:0.5 — und da opacity im Stacking-Context multipliziert wird, wäre
// der vermeintlich aktive `<p>` trotzdem halb-gedimmt. Outermost-Wahl löst
// das auf: der sichtbare Container-Block wird aktiv, CSS dimmt ihn nicht,
// Kinder erben volle opacity.
export function findBlockFromNode(node, root, blockTags = BLOCK_TAGS) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  let outermost = null;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && blockTags.has(cur.tagName)) outermost = cur;
    cur = cur.parentNode;
  }
  return outermost;
}

// Nimmt beliebiges Iterable von Elementen mit getBoundingClientRect(). Für
// Unit-Tests reicht {getBoundingClientRect: () => ({top, bottom, height})}.
export function pickCenterBlock(containerRect, blocks) {
  const centerY = containerRect.top + containerRect.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    const dist = Math.abs((r.top + r.bottom) / 2 - centerY);
    if (dist < bestDist) { bestDist = dist; best = el; }
  }
  return best;
}

// Bezugsrechteck für den Center-Pick: Überschneidung von Scroll-Box und
// SICHTBAREM Bildschirm — derselbe Bezug, den der Typewriter für seinen Anker
// nimmt (`visibleViewportRect`). Die Box läuft mobil hinter der Tastatur weiter
// (der Tail-Puffer ist bewusst ~100vh hoch, Invariante 9), ihre geometrische
// Mitte liegt bei offener Tastatur also weit unter dem, was der User sieht: der
// Pick landete auf einem Absatz hinter der Tastatur, und alles Sichtbare war
// gedimmt — für den User nicht von „Hervorhebung weg" zu unterscheiden.
// Kein Überlapp (Box ganz off-screen) → Box-Bezug, damit der Pick nie leer
// ausgeht. Ohne `visualViewport` (Node-Tests, alte Browser) ebenfalls Box-Bezug.
function visibleBoxRect(container) {
  const r = container.getBoundingClientRect();
  const vv = visibleViewportRect();
  if (!vv || !(vv.height > 0)) return r;
  const top = Math.max(r.top, vv.top);
  const bottom = Math.min(r.top + r.height, vv.top + vv.height);
  return bottom - top > 1 ? { top, height: bottom - top } : r;
}

export function findBlockAtViewportCenter(container, visibleBlocks, blockSel = BLOCK_SEL) {
  if (!container) return null;
  const containerRect = visibleBoxRect(container);
  // Bevorzugt das IO-getrackte Set (günstig, keine QSA). ABER: das Set kann
  // transient nur Höhe-0/abgehängte Einträge halten (Mutation vor IO-Callback,
  // oder eine entfernte Node, die noch nicht ge-unobserve't wurde) — dann liefert
  // pickCenterBlock null, obwohl on-screen valide Blöcke existieren. In dem Fall
  // auf den vollständigen QSA-Scan zurückfallen, statt die Hervorhebung zu
  // verlieren (block===null → setActiveBlock clear't alles).
  if (visibleBlocks && visibleBlocks.size > 0) {
    const fromVisible = pickCenterBlock(containerRect, visibleBlocks);
    if (fromVisible) return fromVisible;
  }
  return pickCenterBlock(containerRect, container.querySelectorAll(blockSel));
}

// Räumt defensiv ALLE Active-Markierungen ab und setzt – falls gewünscht –
// genau eine neue. querySelectorAll statt querySelector, weil Chromium beim
// Paragraph-Split in contenteditable die Klasse auf beide <p> kopiert (Enter
// im aktiven Absatz); ohne Vollscan bleibt die „Leiche" stehen und es wirkt,
// als seien zwei Absätze aktiv. block=null → alles ausgrauen.
export function setActiveBlock(container, block) {
  if (!container) return;
  const prevs = container.querySelectorAll('.focus-paragraph-active');
  for (const prev of prevs) {
    if (prev !== block) {
      prev.classList.remove('focus-paragraph-active');
      // classList.remove leert das Attribut nur, entfernt es aber nicht.
      // Zurück bleibt `class=""` und produziert sonst eine BookStack-Revision
      // beim nächsten Save (Diff zur ursprünglichen, attributlosen Fassung).
      if (prev.classList.length === 0) prev.removeAttribute('class');
    }
  }
  if (block && !block.classList.contains('focus-paragraph-active')) {
    block.classList.add('focus-paragraph-active');
  }
}

// Window-Mode: Vorgänger + Nachfolger des aktiven Blocks bleiben hell.
// Idempotent: nur mutieren, wenn sich das near-Set gegenüber dem aktuellen DOM
// ändert. Beim Tippen im selben Absatz (gleiche Nachbarn) fällt so die sonst
// unbedingte remove-/re-add-Churn (Style-/Paint-Invalidierung) pro Keystroke weg.
//
// `marks` ist ein optionaler Zustandsspeicher (`ctx._marks`), der mitführt, ob
// aktuell überhaupt near-Marks im Baum hängen. Ist nichts gewünscht UND nichts
// gesetzt, entfällt der `querySelectorAll` komplett — das ist der Normalfall
// jedes Ticks in paragraph/sentence/typewriter-only, wo near nie vorkommt.
// Ohne den Speicher müsste jeder Keystroke den ganzen Baum absuchen, nur um
// festzustellen, dass es nichts abzuräumen gibt.
//
// Rückgabe: ob nach dem Aufruf near-Marks gesetzt sind.
export function setNearBlocks(container, block, marks = null, blockSel = BLOCK_SEL) {
  if (!container) return false;
  if (!block && marks && marks.near === false) return false;
  const sib = (el, dir) => {
    let n = el?.[dir];
    while (n && (n.nodeType !== 1 || !n.matches(blockSel))) n = n[dir];
    return n;
  };
  const want = new Set();
  if (block) {
    const prev = sib(block, 'previousElementSibling');
    const next = sib(block, 'nextElementSibling');
    if (prev && prev !== block) want.add(prev);
    if (next && next !== block) want.add(next);
  }
  // Der End-Zustand ist exakt `want` — die Schleifen unten stellen ihn nur her.
  // Deshalb steht das Ergebnis schon vor der Mutation fest.
  const hasNear = want.size > 0;
  // Stale near-Marks abräumen (alles, was nicht mehr gewünscht ist).
  for (const el of container.querySelectorAll('.focus-paragraph-near')) {
    if (want.has(el)) { want.delete(el); continue; }  // schon korrekt markiert
    el.classList.remove('focus-paragraph-near');
    if (el.classList.length === 0) el.removeAttribute('class');
  }
  // Fehlende Marks setzen (in `want` verbliebene = noch nicht markiert).
  for (const el of want) el.classList.add('focus-paragraph-near');
  if (marks) marks.near = hasNear;
  return hasNear;
}

// Räumt sowohl active- als auch near-Klassen + Custom-Highlight ab.
//
// `root` ist per Default das ganze Dokument: der Exit-Pfad räumt auf, wenn der
// Focus-Container bereits ausgeblendet ist und dieselben Klassen zusätzlich im
// zurückgespiegelten Normal-Container hängen können. Ein Container-Scope
// (Aufrufer übergibt ihn explizit) bleibt für gezieltes Aufräumen möglich.
export function clearAllFocusMarks(root = document) {
  if (!root) return;
  for (const el of root.querySelectorAll('.focus-paragraph-active, .focus-paragraph-near')) {
    el.classList.remove('focus-paragraph-active');
    el.classList.remove('focus-paragraph-near');
    if (el.classList.length === 0) el.removeAttribute('class');
  }
  clearSentenceHighlight();
}
