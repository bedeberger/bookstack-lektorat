// Geteilte Modul-Helfer + Konstanten der editorToolbarCard-Submodule
// (bubble/slash/keydown). Reine Modul-Scope-Funktionen ohne Alpine-`this`; die
// Methoden-Objekte in den Geschwister-Files konsumieren sie.

import { getEditEl, placeCaretIn, WORD_RE } from '../../utils.js';
import { tzOpts, localeTag } from '../../../utils.js';
import { BLOCK_SEL, findBlock, topLevelBlock } from '../../shared/dom-block.js';
import { brLeftOfCaret } from '../../shared/soft-break.js';

export { getEditEl, placeCaretIn, WORD_RE };
// Block-Lookup lebt in shared/dom-block.js (auch von edit/view.js konsumiert) —
// hier nur re-exportiert, damit die Toolbar-Submodule ihren Import behalten.
export { BLOCK_SEL, findBlock, topLevelBlock };
// Soft-Break-Dedup lebt in shared/soft-break.js (auch vom Focus-Editor
// konsumiert, der den Toolbar-Modulgraph nicht importieren darf) — hier unter
// dem eingeführten Unterstrich-Namen re-exportiert.
export { brLeftOfCaret as _brLeftOfCaret };

// Blocktyp-Definitionen für Slash-Transform. `tag` ist das Zielelement;
// `className` optional (aktuell für .poem + .todo). `list: true` wrappt den
// Inhalt in ein <li>. `todoList: true` erzeugt eine Checkbox-Liste.
// `insertText: 'date'|'time'|'datetime'` ersetzt den Block durch einen
// formatierten Datums-/Zeit-Stempel.
export const SLASH_ITEMS = [
  { key: 'paragraph',  tag: 'p',          group: 'block' },
  { key: 'h2',         tag: 'h2',         group: 'block' },
  { key: 'h3',         tag: 'h3',         group: 'block' },
  { key: 'blockquote', tag: 'blockquote', wrapP: true,                   group: 'block' },
  { key: 'poem',       tag: 'div', className: 'poem', wrapP: true,       group: 'block' },
  { key: 'list',       tag: 'ul', list: true,                           group: 'block' },
  { key: 'todo',       tag: 'ul', className: 'todo', todoList: true,     group: 'block' },
  { key: 'hr',         tag: 'hr',                          group: 'break' },
  { key: 'pagebreak',  tag: 'hr', className: 'pagebreak',  group: 'break' },
  { key: 'blankpage',  tag: 'hr', className: 'blankpage',  group: 'break' },
  { key: 'bild',       upload: 'image',        group: 'insert' },
  { key: 'heute',      insertText: 'date',     group: 'insert' },
  { key: 'jetzt',      insertText: 'datetime', group: 'insert' },
  { key: 'zeit',       insertText: 'time',     group: 'insert' },
];

// Datums-/Zeit-Stempel im uiLocale + appTimezone. Kein Locale-Param —
// liest live aus dem Root.
export function _formatStamp(kind) {
  const tag = localeTag(Alpine.store('shell').uiLocale);
  const d = new Date();
  if (kind === 'date') {
    return d.toLocaleDateString(tag, tzOpts({ day: '2-digit', month: '2-digit', year: 'numeric' }));
  }
  if (kind === 'time') {
    return d.toLocaleTimeString(tag, tzOpts({ hour: '2-digit', minute: '2-digit' }));
  }
  // 'datetime'
  const date = d.toLocaleDateString(tag, tzOpts({ day: '2-digit', month: '2-digit', year: 'numeric' }));
  const time = d.toLocaleTimeString(tag, tzOpts({ hour: '2-digit', minute: '2-digit' }));
  return `${date} ${time}`;
}

// Link-URL normalisieren: leerer/whitespace-only String → ''. Bekannte Schemes
// (http/https/mailto/tel) durchreichen. Plain `foo@bar.tld` → mailto:. Sonst
// `https://` voranstellen.
export function _normalizeLinkUrl(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'mailto:' + s;
  return 'https://' + s;
}

// Range zu <a href> machen. Bei nicht-collapsed Range: execCommand('createLink')
// (behält Inline-Formate, splittet Tags sauber). Bei Caret (collapsed): URL als
// Linktext einfügen. Caller hat Selection bereits auf range gesetzt + Editor
// fokussiert.
export function _applyLinkAtRange(range, url) {
  if (range.collapsed) {
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    range.insertNode(a);
    const after = document.createRange();
    after.setStartAfter(a);
    after.collapse(true);
    const sel = document.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(after); }
  } else {
    document.execCommand('createLink', false, url);
  }
}

// Nächstliegendes <a>-Element ab node aufwärts, innerhalb von root. null wenn
// node nicht in einem Link sitzt.
export function findAnchor(node, root) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && cur.nodeName === 'A') return cur;
    cur = cur.parentNode;
  }
  return null;
}

// Absatz-artige Top-Level-Blöcke, deren Verschmelzung über eine Absatzgrenze
// hinweg (Backspace am Anfang / Delete am Ende) wir bei weichen Umbrüchen
// selbst übernehmen. Listen, Tabellen, Gedichte, <pre>, <hr> bleiben aussen
// vor — dort ist das native bzw. das HR-Verhalten gewünscht.
export const MERGE_BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

// Liegt der collapsed Caret am Block-Anfang bzw. -Ende? Genutzt, um eine
// direkt angrenzende <hr> per Backspace/Delete zu löschen — das void-Element
// lässt sich nicht selektieren, deshalb gibt es sonst keinen Lösch-Pfad.
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

// Liefert das umschliessende <li class="todo-item">, falls die Caret-Position
// in einer Checkbox-Liste liegt. Sonst null.
export function findTodoLi(node, root) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && cur.tagName === 'LI'
        && cur.parentNode?.tagName === 'UL'
        && cur.parentNode.classList?.contains('todo')) {
      return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}

// Liefert das <p> innerhalb eines <div class="poem">, falls die Caret-Position
// in einem Gedicht liegt. Sonst null.
export function findPoemP(node, root) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && cur.tagName === 'P'
        && cur.parentNode?.tagName === 'DIV'
        && cur.parentNode.classList?.contains('poem')) {
      return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}
