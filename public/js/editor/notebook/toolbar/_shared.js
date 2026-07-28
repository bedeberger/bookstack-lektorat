// Geteilte Modul-Helfer + Konstanten der editorToolbarCard-Submodule
// (bubble/slash/keydown). Reine Modul-Scope-Funktionen ohne Alpine-`this`; die
// Methoden-Objekte in den Geschwister-Files konsumieren sie.

import { getEditEl, placeCaretIn, WORD_RE } from '../../utils.js';
import { tzOpts, localeTag } from '../../../utils.js';
import { BLOCK_SEL, findBlock, topLevelBlock, caretAtBlockStart, caretAtBlockEnd } from '../../shared/dom-block.js';
import { brLeftOfCaret } from '../../shared/soft-break.js';
import { TODO_ITEM_SEL, TODO_LIST_CLASS } from '../../shared/todo-html.js';

export { getEditEl, placeCaretIn, WORD_RE };
// Block-Lookup + Caret-Randlage leben in shared/dom-block.js (auch von
// edit/view.js und shared/soft-break.js konsumiert) — hier nur re-exportiert,
// damit die Toolbar-Submodule ihren Import behalten.
export { BLOCK_SEL, findBlock, topLevelBlock, caretAtBlockStart, caretAtBlockEnd };
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
  { key: 'todo',       tag: 'ul', className: TODO_LIST_CLASS, todoList: true, group: 'block' },
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

// Nächstliegender Vorfahr ab `node` (Textknoten erlaubt), der `selector`
// matcht — begrenzt auf echte Nachfahren von `root`. `root` selbst zählt
// bewusst NICHT mit: sonst könnte der Editor-Container als Treffer durchgehen
// und die Aufrufer würden ihn wie einen Block behandeln. Basis der find*-Familie
// darunter; `closest` löst dabei auch Kind-Kombinatoren auf, sodass „li in einer
// Todo-Liste" bzw. „p in einem Gedicht" ein Selektor statt einer Handschleife ist.
export function findAncestor(node, root, selector) {
  const el = node && node.nodeType === 3 ? node.parentNode : node;
  const hit = el?.closest?.(selector);
  return hit && hit !== root && root?.contains(hit) ? hit : null;
}

// Nächstliegendes <a>-Element ab node aufwärts, innerhalb von root. null wenn
// node nicht in einem Link sitzt.
export function findAnchor(node, root) {
  return findAncestor(node, root, 'a');
}

// Absatz-artige Top-Level-Blöcke, deren Verschmelzung über eine Absatzgrenze
// hinweg (Backspace am Anfang / Delete am Ende) wir bei weichen Umbrüchen
// selbst übernehmen. Listen, Tabellen, Gedichte, <pre>, <hr> bleiben aussen
// vor — dort ist das native bzw. das HR-Verhalten gewünscht.
export const MERGE_BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

// Blöcke, die sich wie ein einzelnes Zeichen verhalten, aber keinen Caret
// aufnehmen: sie lassen sich nicht selektieren, also gibt es ohne eigenen
// Lösch-Pfad überhaupt keinen. `<hr>` ist ein echtes void-Element; ein
// `<figure>` ist es nicht, hat aber dieselbe Eigenschaft — die einzige
// Caret-Position darin ist die `<figcaption>`, und für das Bild selbst gibt es
// (anders als bei `<hr>`, siehe `hr-selected`) keine Klick-Auswahl.
export const ATOMIC_BLOCK_TAGS = new Set(['HR', 'FIGURE']);

// Wrapper-Blöcke mit eigener Formatierung. Chromium bäckt beim Merge über deren
// Grenze die BERECHNETEN CSS-Werte des Quellblocks als Inline-`style` ein („um
// das Aussehen zu erhalten") — das verstösst gegen die Regel „Styles nur in
// public/css", brennt Light-Mode-Farben fest und wird mitgespeichert, weil
// `cleanPageHtml` `style`-Attribute nicht strippt. Darum bedient der Editor
// diese Grenzen selbst. `ul.todo` ist ausgenommen: dafür ist der spezifischere
// `_kbTodoDelete` zuständig (Checkbox als Struktur).
// Muss mit den Wrapper-erzeugenden Einträgen aus SLASH_ITEMS synchron bleiben —
// ein neuer Wrapper-Blocktyp im Slash-Menü, der hier fehlt, verliert lautlos
// seine Grenz-Behandlung. Gegated durch tests/unit/notebook-toolbar.test.mjs.
// `pre` und `ol` stehen vorsorglich drin, obwohl (noch) kein Slash-Item sie
// erzeugt — sie entstehen über Paste/Import.
export const BOUNDARY_WRAPPER_SEL = `blockquote, div.poem, pre, ul:not(.${TODO_LIST_CLASS}), ol`;

// Die text-tragenden Kind-Blöcke eines Wrapper-Blocks, in Dokumentordnung.
// `<pre>` trägt seinen Text direkt und ist damit sein eigener einziger
// Kind-Block — dadurch behandeln die Grenz-Handler es wie die übrigen Wrapper,
// ohne Sonderzweig.
export function wrapperInnerBlocks(wrapper) {
  if (!wrapper) return [];
  if (wrapper.tagName === 'PRE') return [wrapper];
  return Array.from(wrapper.children).filter((c) => c.matches?.(BLOCK_SEL));
}

// Nächstliegende `<figcaption>` ab `node` aufwärts, innerhalb von `root`.
// `figcaption` steht bewusst NICHT in BLOCK_SEL (sonst würde `findBlock` sie
// als Absatz-artigen Block behandeln und die Merge-Pfade würden greifen).
export function findFigcaption(node, root) {
  return findAncestor(node, root, 'figcaption');
}

// Liefert die umschliessende Zeile einer Checkbox-Liste, falls die
// Caret-Position darin liegt. Sonst null. Struktur-Selektor aus der
// Markup-SSoT `editor/shared/todo-html.js`.
export function findTodoLi(node, root) {
  return findAncestor(node, root, TODO_ITEM_SEL);
}

// Liefert das <p> innerhalb eines <div class="poem">, falls die Caret-Position
// in einem Gedicht liegt. Sonst null.
export function findPoemP(node, root) {
  return findAncestor(node, root, 'div.poem > p');
}
