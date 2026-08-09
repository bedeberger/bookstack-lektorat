// Plain-Text-Extraktion + Offset->Range-Mapping fuer LanguageTool-Overlay.
//
// buildOffsetTable(root):
//   Walks Text-/Element-Nodes innerhalb von `root` und baut drei Outputs:
//     - text:      Plain-Text-Stream, der ans LT-API geht.
//     - positions: Array von { node, start, end } pro Text-Node — start/end
//                  sind Offsets im `text`-Stream (UTF-16 Code Units = JS
//                  String.length = LT-Offset-Semantik).
//     - protectedRanges: [start,end]-Intervalle der Quellen-Chips. Ihr Text bleibt
//                  IM Stream (siehe unten), Treffer darin werden verworfen.
//   Block-Element-Boundaries fuegen `\n\n` ein (LT interpretiert das als
//   Paragraph-Break), `<br>` fuegt `\n` ein. Whitespace innerhalb von
//   Text-Nodes bleibt unangetastet — LT-Engine handhabt Tokenisierung.
//
// rangeFromOffset(table, offset, length):
//   Liefert eine DOM-Range, deren Start/End auf Text-Nodes innerhalb von
//   `root` zeigen. Match darf ueber mehrere Text-Nodes hinwegspannen.
//   Returns null wenn Offsets ausserhalb der Tabelle liegen (z.B. nach
//   DOM-Mutation zwischen Build und Lookup).

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'PRE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
  'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'TR',
]);

// SHOW_ELEMENT=1, SHOW_TEXT=4 als rohe Bitmask (statt NodeFilter.SHOW_*),
// damit das Modul auch in linkedom laeuft (kein NodeFilter-Constructor).
const SHOW_ELEMENT_AND_TEXT = 1 | 4;

// LT-eigene UI-Inseln (Popover, Badge) leben innerhalb des Editor-Roots,
// damit Scroll sie nativ mitnimmt. Ihre Texte (Regelmeldungen, Buttons) sollen
// NICHT in den LT-Eingabe-Stream wandern — sonst pruefte LT seine eigene UI.
// Diagramm-Bloecke fallen aus demselben Grund komplett raus wie die LT-eigene UI:
// `flowchart TD` ist kein Deutsch, und jede Knotenbeschriftung ohne Satzzeichen
// erzeugt eine Meldung. Anders als beim Quellen-Chip wird hier GESCHNITTEN statt
// geschuetzt — der Block steht fuer sich, es gibt keine Nachbar-Textknoten, die
// durch das Schneiden zusammenklebten. Selektor ist eine bewusste Kopie aus
// public/js/diagram/mermaid-html.js (dieses Modul haelt sich frei von
// App-Bundle-Importen), gegated durch tests/unit/mermaid-drift.test.mjs.
const DIAGRAM_SKIP_SEL = 'pre.mermaid';

// Tabellen werden im Manuskript ebenfalls geschnitten — aber aus einem anderen
// Grund als das Diagramm, und der Unterschied ist wichtig: Zellinhalt IST
// Prosa und soll geprueft werden. Nur nicht hier.
//
// Der Block ist `contenteditable="false"` (markTablesAtomic) und wird
// ausschliesslich im Gitter-Dialog bearbeitet. Eine Meldung im Manuskript waere
// darum nicht anwendbar: der Ersetzungs-Vorschlag hat keine Schreibstelle, und
// die Zellen-Randfaelle (Zelle endet ohne Satzzeichen, Zahlenkolonne, „ff.")
// erzeugen reihenweise Falschmeldungen mitten im Fliesstext-Stream.
//
// GEPRUEFT WIRD, WO GESCHRIEBEN WIRD: die Zellenfelder des Dialogs tragen
// `data-spellcheck="spelling"` und laufen damit ueber denselben globalen
// Dispatcher wie jedes andere Prosafeld (harte Regel „LanguageTool auf
// Prosatextfeldern Pflicht"). Kopie von TABLE_SEL aus
// public/js/table/table-html.js; dieses Modul haelt sich frei von
// App-Bundle-Importen. Gegated durch tests/unit/table-drift.test.mjs.
const TABLE_SKIP_SEL = 'table';

function _isSkippedIsland(el) {
  if (!el || el.nodeType !== 1) return false;
  const cl = el.classList;
  if (!cl) return false;
  if (cl.contains('lt-popover') || cl.contains('lt-badge')) return true;
  return !!el.matches && (el.matches(DIAGRAM_SKIP_SEL) || el.matches(TABLE_SKIP_SEL));
}

// Quellen-Chips (Quellennachweise) werden NICHT aus dem Stream geschnitten, sondern
// als geschuetzte Intervalle markiert. Zwei Gruende:
//   - Schneiden hinterliesse ein doppeltes Leerzeichen zwischen den Nachbar-
//     Textknoten, und genau darauf hat LanguageTool eine Regel — der Chip
//     erzeugte also selbst den Fehler, den er vermeiden soll.
//   - Der Satz bleibt fuer LTs Grammatik-Regeln vollstaendig; nur Treffer, die
//     die Quellenangabe beruehren, fallen weg. Wichtig, weil ein angewandter Vorschlag
//     den Bereich ersetzt und damit den Chip samt Zeiger zerstoeren wuerde.
// Selektor ist eine bewusste Kopie von CITE_SEL (public/js/sources/cite-html.js);
// dieses Modul haelt sich frei von App-Bundle-Importen. Gegen Drift gesichert
// durch tests/unit/cite-guard-drift.test.mjs.
const CITE_SKIP_SEL = 'span.cite[data-src]';

// Querverweise („siehe Kapitel 3") aus demselben Grund geschuetzt: ein
// angewandter Vorschlag ersetzt den Bereich und zerstoert dabei den Zeiger — der
// Verweis nummerierte danach nicht mehr mit. Ebenfalls eine bewusste Kopie
// (XREF_SEL in public/js/xrefs/xref-html.js), gegated durch denselben Test.
const XREF_SKIP_SEL = 'span.xref[data-xref-id]';

function _isCiteChip(el) {
  return !!(el && el.nodeType === 1 && el.matches
    && (el.matches(CITE_SKIP_SEL) || el.matches(XREF_SKIP_SEL)));
}

export function buildOffsetTable(root) {
  if (!root) return { text: '', positions: [], protectedRanges: [] };
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, SHOW_ELEMENT_AND_TEXT, null);

  let text = '';
  const positions = [];
  const protectedRanges = [];
  let pendingBreak = '';
  let skipRoot = null; // gesetzt solange Walker im Subtree einer LT-Insel laeuft
  // Offener Quellen-Chip: Start wird beim ERSTEN Textknoten darin gesetzt (nicht
  // beim Element), damit ein vorher eingefuegter Block-Break nicht ins Intervall
  // rutscht.
  let citeRoot = null;
  let citeStart = -1;
  const closeCite = () => {
    if (citeRoot && citeStart >= 0 && text.length > citeStart) {
      protectedRanges.push([citeStart, text.length]);
    }
    citeRoot = null;
    citeStart = -1;
  };
  let cur = walker.nextNode();
  while (cur) {
    if (skipRoot && !skipRoot.contains(cur)) skipRoot = null;
    if (skipRoot) { cur = walker.nextNode(); continue; }
    if (citeRoot && !citeRoot.contains(cur)) closeCite();
    if (cur.nodeType === 1 /* ELEMENT */) {
      if (_isSkippedIsland(cur)) {
        skipRoot = cur;
        cur = walker.nextNode();
        continue;
      }
      if (!citeRoot && _isCiteChip(cur)) { citeRoot = cur; citeStart = -1; }
      const tag = cur.tagName;
      if (tag === 'BR') {
        pendingBreak = '\n';
      } else if (BLOCK_TAGS.has(tag)) {
        // Doppelter Break nicht stapeln; \n\n reicht.
        if (pendingBreak !== '\n\n') pendingBreak = '\n\n';
      }
    } else if (cur.nodeType === 3 /* TEXT */) {
      const v = cur.nodeValue || '';
      if (v) {
        if (pendingBreak && text) {
          text += pendingBreak;
        }
        pendingBreak = '';
        const start = text.length;
        text += v;
        positions.push({ node: cur, start, end: start + v.length });
        if (citeRoot && citeStart < 0) citeStart = start;
      }
    }
    cur = walker.nextNode();
  }
  closeCite();
  return { text, positions, protectedRanges };
}

/** Ueberlappt der LT-Treffer [offset, offset+length) einen geschuetzten Bereich?
 *  Bewusst Ueberlappung, nicht Enthaltensein: ein Treffer, der nur teilweise in
 *  die Quellenangabe reicht, wuerde beim Anwenden ebenfalls Chip-Zeichen ersetzen. */
/** Treffer in Quellen-Chips wegfiltern. Genau EIN Aufrufpunkt im Controller,
 *  damit Squiggles und Badge-Zahl dieselbe Menge sehen — wird nur beim Rendern
 *  gefiltert, meldet das Badge Fehler, die nirgends markiert sind. */
export function filterProtectedMatches(matches, ranges) {
  if (!Array.isArray(matches) || !matches.length) return [];
  if (!Array.isArray(ranges) || !ranges.length) return matches;
  return matches.filter((m) => !overlapsProtected(m.offset, m.length, ranges));
}

export function overlapsProtected(offset, length, ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return false;
  const s = Number(offset) || 0;
  const e = s + Math.max(0, Number(length) || 0);
  for (const [ps, pe] of ranges) {
    if (s < pe && e > ps) return true;
  }
  return false;
}

// Positions sind nach `start` aufsteigend + nicht-ueberlappend (TreeWalker-
// Dokumentreihenfolge). Darum Binary-Search statt Linear-Scan — bei grossen
// Seiten (viele Text-Nodes × viele Matches) waere O(M·P) sonst quadratisch und
// blockiert beim Render der LT-Antwort den Main-Thread.

// Index der Position, die `target` enthaelt (p.start <= target < p.end), sonst
// -1. `target` faellt in eine Block-Break-Luecke (\n\n ohne Node) → -1.
function _findStartIndex(positions, target) {
  let lo = 0;
  let hi = positions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = positions[mid];
    if (target < p.start) hi = mid - 1;
    else if (target >= p.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// Index der Position mit p.start < end <= p.end (end ist exklusive Grenze, darf
// auf p.end fallen), sonst -1.
function _findEndIndex(positions, end) {
  let lo = 0;
  let hi = positions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = positions[mid];
    if (end <= p.start) hi = mid - 1;
    else if (end > p.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// Lokalisiert Offset-Range in der Positions-Tabelle (pure, testbar ohne Range).
// Liefert { startNode, startOffset, endNode, endOffset } oder null.
export function locateOffset(table, offset, length) {
  if (!table || !table.positions || length <= 0) return null;
  const end = offset + length;
  const si = _findStartIndex(table.positions, offset);
  if (si < 0) return null;
  const ei = _findEndIndex(table.positions, end);
  if (ei < 0) return null;
  const sp = table.positions[si];
  const ep = table.positions[ei];
  return {
    startNode: sp.node,
    startOffset: offset - sp.start,
    endNode: ep.node,
    endOffset: end - ep.start,
  };
}

export function rangeFromOffset(table, offset, length) {
  const loc = locateOffset(table, offset, length);
  if (!loc) return null;
  const doc = loc.startNode.ownerDocument || document;
  const range = doc.createRange();
  try {
    range.setStart(loc.startNode, loc.startOffset);
    range.setEnd(loc.endNode, loc.endOffset);
  } catch {
    return null;
  }
  return range;
}
