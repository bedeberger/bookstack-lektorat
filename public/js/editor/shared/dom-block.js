// Block-Lookup im contenteditable — SSoT für beide Editoren, die auf dem
// Seiten-Container laufen (Notebook-Toolbar + Notebook-Edit-Pfade).
//
// Lag vorher doppelt: einmal in notebook/toolbar/_shared.js (Slash/Keydown),
// einmal inline in notebook/edit/view.js (insertHorizontalRule). Ein neuer
// Blocktyp hätte an zwei Stellen nachgezogen werden müssen — genau die Drift,
// die shared/ verhindert.

// Block-artige Elemente, in denen ein Caret sitzen kann. `li` und `div.poem`
// sind absichtlich dabei: der Caret-Block ist dort das tief verschachtelte
// Element, nicht das Top-Level-Child von editEl.
export const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, li, div.poem';

// Nächstliegender Block ab `node` aufwärts, innerhalb von `root` (exklusive).
// null, wenn zwischen node und root kein Block liegt.
export function findBlock(node, root) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && cur.matches?.(BLOCK_SEL)) return cur;
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
