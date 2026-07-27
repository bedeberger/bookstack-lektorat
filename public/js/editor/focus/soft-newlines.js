// Rohe Zeilenumbrüche und Rand-Whitespace im Blockinneren einebnen, bevor der
// Fokusmodus den Inhalt zeigt.
//
// Why: der Fokus fährt `white-space: pre-wrap` auf den Schreibblöcken
// (Invariante 11c). Damit wird sichtbar, was in jeder anderen Ansicht
// kollabiert — ein `\n` im Blockinneren rendert als Umbruch (gemessen: aus
// einer Zeile werden drei), führende Leerzeichen als Einzug (15 px). Solche
// Bestände entstehen durch Importe und hübsch formatiertes Quell-HTML; der
// Server-Cleaner kollabiert sie nicht (`lib/html-clean.js` fasst Textknoten
// nicht an, es trimmt nur die Blockränder). Ohne diese Normalisierung sähe der
// Autor im Fokus Umbrüche und Einzüge, die es in seinem Buch nicht gibt.
//
// Die Ersetzung ist für jeden Konsumenten bedeutungsgleich: Leseansicht,
// Share-Reader, PDF/DOCX/EPUB und die Stats-Normalisierung kollabieren
// Whitespace ohnehin zu einem Leerzeichen. Genau deshalb ist sie sicher — und
// genau deshalb müssen `pre` und `.poem` aussen vor bleiben: dort ist der
// Zeilenumbruch echte Struktur (`white-space: pre-line`/`pre-wrap` auch in der
// Leseansicht), ein Kollaps wäre dort Datenverlust.

import { BLOCK_SEL } from '../shared/dom-block.js';

// Blöcke, in denen `\n` Struktur ist und bleiben muss.
const PRESERVE_SEL = 'pre, .poem';

// `\n` samt umgebender Spaces/Tabs (und Folge-Umbrüchen) auf ein Leerzeichen.
const NEWLINE_RUN = /[^\S\n]*\n\s*/g;

function collapse(value) {
  return value.replace(NEWLINE_RUN, ' ');
}

// Offset in den kollabierten Text übersetzen: dieselbe Ersetzung auf das
// Präfix anwenden und dessen Länge nehmen. An einer Umbruch-Fuge kann das um
// ein Zeichen danebenliegen — im Gegenzug bleibt der Caret ohne Sonderfälle in
// derselben Wortumgebung stehen.
function mapOffset(oldValue, offset, newLength) {
  return Math.min(collapse(oldValue.slice(0, offset)).length, newLength);
}

// Text-Kinder eines Blocks in Dokumentreihenfolge (nur eigene, nicht die in
// verschachtelten Preserve-Subtrees).
function textNodesOf(block, root) {
  const doc = block.ownerDocument || document;
  const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const keep = node.parentElement?.closest(PRESERVE_SEL);
      if (keep && root.contains(keep)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out = [];
  while (walker.nextNode()) out.push(walker.currentNode);
  return out;
}

// Normalisiert alle Blöcke unterhalb von `root`. Liefert true, wenn etwas
// geändert wurde. Textknoten ZWISCHEN den Blöcken (direkte Kinder von `root`)
// bleiben unangetastet — der Container selbst ist `white-space: normal`, dort
// rendert der Zeilenumbruch nicht und eine Ersetzung wäre eine grundlose
// Änderung am gespeicherten HTML.
export function collapseSoftNewlines(root) {
  if (!root) return false;
  const sel = (root.ownerDocument || document).getSelection?.();
  const saved = sel && sel.rangeCount > 0 && root.contains(sel.anchorNode)
    ? { node: sel.anchorNode, offset: sel.anchorOffset, value: sel.anchorNode.nodeValue }
    : null;
  let changed = false;
  let caret = null;

  for (const block of root.querySelectorAll(BLOCK_SEL)) {
    if (block.closest(PRESERVE_SEL)) continue;
    const nodes = textNodesOf(block, root);
    if (!nodes.length) continue;

    nodes.forEach((node, i) => {
      let next = collapse(node.nodeValue);
      // Blockränder trimmen — unter pre-wrap rendern sie sonst als Einzug bzw.
      // als hängender Leerraum. Gleiche Regel wie `stripBlockEdgeNbsp` im
      // Server-Cleaner, damit der Save nichts Neues zu tun findet.
      if (i === 0) next = next.replace(/^[\s ]+/u, '');
      if (i === nodes.length - 1) next = next.replace(/[\s ]+$/u, '');
      if (next === node.nodeValue) return;
      if (saved && saved.node === node) {
        caret = { node, offset: mapOffset(saved.value, saved.offset, next.length) };
      }
      node.nodeValue = next;
      changed = true;
    });
  }

  if (caret && sel) {
    const range = (root.ownerDocument || document).createRange();
    range.setStart(caret.node, Math.min(caret.offset, caret.node.nodeValue.length));
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return changed;
}
