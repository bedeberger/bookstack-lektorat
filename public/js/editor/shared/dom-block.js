// Block-Lookup im contenteditable — SSoT für beide Editoren, die auf dem
// Seiten-Container laufen (Notebook-Toolbar + Notebook-Edit-Pfade).
//
// Ausserdem Vokabular-SSoT für die Blockselektoren der Editor-/Reader-Pfade:
// `TEXT_BLOCK_TAGS` ist der gemeinsame Kern, jeder Konsument komponiert seinen
// Selektor daraus mit einem EXPLIZITEN Zusatz. **Why:** die Selektoren hiessen
// vorher alle `BLOCK_SEL`, hatten aber vier verschiedene Inhalte — gleicher
// Name suggeriert Gleichheit, die nicht besteht, und ein Aufrufer griff
// dadurch (unbemerkt) zum Selektor der falschen Familie. Sie unterscheiden sich
// weiterhin, aber jetzt sichtbar am Namen und an der Zusatzliste. Wer eine
// Familie ändert, ändert genau die eine.
export const TEXT_BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li'];

// Kern + explizite Zusätze zu einem CSS-Selektor.
export function composeBlockSel(...extra) {
  return [...TEXT_BLOCK_TAGS, ...extra.flat()].join(', ');
}

// Block-artige Elemente, in denen ein Caret sitzen kann. `li` und `div.poem`
// sind absichtlich dabei: der Caret-Block ist dort das tief verschachtelte
// Element, nicht das Top-Level-Child von editEl. Konsumenten: Notebook-Toolbar
// (Slash/Keydown/Grenz-Handler), Notebook-Edit-Pfade, focus/soft-newlines.js.
export const CARET_BLOCK_SEL = composeBlockSel('pre', 'div.poem');

// Nächstliegender Block ab `node` aufwärts, innerhalb von `root` (exklusive).
// null, wenn zwischen node und root kein Block liegt.
export function findBlock(node, root) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && cur.matches?.(CARET_BLOCK_SEL)) return cur;
    cur = cur.parentNode;
  }
  return null;
}

// Top-Level-Child von `root`, das `block` enthält (bzw. `block` selbst).
// Nötig, um Geschwister auf Editor-Root-Ebene zu finden (z.B. eine `<hr>`
// neben einer Liste, deren Caret-Block ein tief liegendes `<li>` ist).
export function topLevelBlock(block, root) {
  let top = block;
  while (top?.parentNode && top.parentNode !== root) top = top.parentNode;
  return top;
}

// Liegt der collapsed Caret am Block-Anfang bzw. -Ende? Genutzt, um eine
// direkt angrenzende <hr> per Backspace/Delete zu löschen — das void-Element
// lässt sich nicht selektieren, deshalb gibt es sonst keinen Lösch-Pfad — und
// um den Blockende-Fall beim weichen Umbruch zu erkennen (shared/soft-break.js).
export function caretAtBlockStart(range, block) {
  if (!range.collapsed) return false;
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setEnd(range.startContainer, range.startOffset);
  return r.toString().length === 0;
}
export function caretAtBlockEnd(range, block) {
  if (!range.collapsed) return false;
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setStart(range.startContainer, range.startOffset);
  return r.toString().length === 0;
}
