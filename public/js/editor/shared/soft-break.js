// Weicher Zeilenumbruch (Shift+Enter) — SSoT für die Editoren, die den
// Soft-Break selbst setzen statt ihn dem Browser zu überlassen.
//
// Konsumenten: Notebook-Toolbar (via Re-Export in notebook/toolbar/_shared.js)
// und der Focus-Editor (focus/listeners.js). Der Focus-Pfad darf den
// Toolbar-Modulgraph nicht importieren — er läuft auch in der Standalone-Shell
// der nativen Clients, die keine Toolbar-Karte mountet.

// Steht links vom (kollabierten) Caret schon ein <br>? Dann würde ein weiterer
// Soft-Break einen zweiten aufeinanderfolgenden <br> erzeugen, den
// collapseEmptyBlocks (utils.js) beim Save ohnehin wegräumt — der User sähe zwei
// Umbrüche, von denen nach dem Reload nur einer überlebt. Whitespace-Textknoten
// zwischen <br> und Caret werden übersprungen (exakt die, die der Collapse auch
// ignoriert). Inline-Element-Grenzen werden bewusst nicht überstiegen; den
// seltenen Rest fängt der Cleaner verlustfrei ab.
export function brLeftOfCaret(sel) {
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const c = range.startContainer;
  const o = range.startOffset;
  let probe;
  if (c.nodeType === 3) {
    if (c.nodeValue.slice(0, o).trim() !== '') return false; // echter Text links → erlauben
    probe = c.previousSibling;
  } else {
    probe = o > 0 ? c.childNodes[o - 1] : null;
  }
  while (probe && probe.nodeType === 3 && !probe.nodeValue.trim()) {
    probe = probe.previousSibling;
  }
  return !!(probe && probe.nodeType === 1 && probe.tagName === 'BR');
}
