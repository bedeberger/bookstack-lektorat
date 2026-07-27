// Sentence-Mode: Satz-Erkennung am Caret + CSS-Custom-Highlight für die
// nicht-aktiven Sätze des aktiven Blocks. Keine DOM-Mutation → kein Risiko
// eines Save-Diffs.

// Intl.Segmenter pro Locale einmal instanziieren (Konstruktion ist teuer, das
// Ergebnis ist stateless). null = Segmenter nicht verfügbar → Regex-Fallback.
const _segmenters = new Map();
function getSegmenter(locale) {
  if (_segmenters.has(locale)) return _segmenters.get(locale);
  let seg = null;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try { seg = new Intl.Segmenter(locale, { granularity: 'sentence' }); }
    catch { seg = null; }
  }
  _segmenters.set(locale, seg);
  return seg;
}

function computeSentenceRanges(text, locale) {
  const seg = getSegmenter(locale);
  if (seg) {
    try {
      const out = [];
      for (const s of seg.segment(text)) {
        const start = s.index;
        const end = start + s.segment.length;
        if (s.segment.trim()) out.push([start, end]);
      }
      return out;
    } catch { /* fallthrough */ }
  }
  const out = [];
  const re = /[^.!?]+[.!?]*\s*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim()) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// Satzgrenzen via Intl.Segmenter (handhabt Abkürzungen wie „z. B." korrekt).
// Fallback Regex split nach .!? mit Whitespace. Liefert [start,end]-Paare.
//
// Einträge-Memo (letzter Text + Locale): bewegt sich nur der Cursor im selben
// Block (Text unverändert), wird nicht neu segmentiert — der teure Segmenter-
// Lauf entfällt pro Keystroke im Satz-Modus. Rückgabe read-only (kein Caller
// mutiert das Array).
let _memoText = null;
let _memoLocale = null;
let _memoRanges = null;
export function findSentenceRanges(text, locale = 'de') {
  if (!text) return [];
  if (text === _memoText && locale === _memoLocale) return _memoRanges;
  const ranges = computeSentenceRanges(text, locale);
  _memoText = text;
  _memoLocale = locale;
  _memoRanges = ranges;
  return ranges;
}

// Zeichen im Block VOR dem Element `el` (Dokument-Reihenfolge).
function textBefore(block, el) {
  if (el === block) return 0;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let pos = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (el.contains(node)) break;
    pos += (node.nodeValue || '').length;
  }
  return pos;
}

// Caret als Zeichen-Offset im Block-Text.
//
// Der Caret-Container ist nicht immer ein Textknoten: nach dem Leeren eines
// Absatzes, direkt nach einem `<br>` und unmittelbar nach einem Merge setzt
// Chromium ihn aufs Element und zählt dann KINDKNOTEN statt Zeichen. Eine reine
// Textknoten-Suche findet den Container dann nie und fiele auf 0 zurück — als
// aktiv gälte der erste Satz, obwohl der Caret im letzten steht: beim Löschen
// sprang das Satz-Spotlight an den Absatzanfang.
function caretOffsetInBlock(block, node, offset) {
  if (!node) return 0;
  if (node.nodeType === 3) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    let pos = 0;
    let n;
    while ((n = walker.nextNode())) {
      if (n === node) return pos + Math.max(0, Math.min(offset, (n.nodeValue || '').length));
      pos += (n.nodeValue || '').length;
    }
    return pos;
  }
  let chars = 0;
  const kids = node.childNodes || [];
  for (let i = 0; i < offset && i < kids.length; i++) chars += kids[i].textContent?.length || 0;
  return textBefore(block, node) + chars;
}

// Findet die Satz-Range im Block, die den Caret enthält.
export function findSentenceAtCaret(block, selection) {
  if (!block || !selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!block.contains(range.startContainer)) return null;
  const caretPos = caretOffsetInBlock(block, range.startContainer, range.startOffset);
  const text = block.textContent || '';
  const ranges = findSentenceRanges(text);
  if (ranges.length === 0) return { sentence: [0, text.length], totalLength: text.length };
  // Halboffenes Intervall [start, end): sitzt der Caret exakt auf einer
  // Satzgrenze, gewinnt der Satz, der dort BEGINNT. Der Segmenter schlägt den
  // Trennraum dem Vorgänger zu — mit `<= end` galt nach jedem getippten Punkt
  // plus Leerzeichen noch der abgeschlossene Satz als aktiv, und beim
  // Rückwärtslöschen über eine Grenze sprang das Spotlight einen Satz zurück.
  for (const r of ranges) {
    if (caretPos >= r[0] && caretPos < r[1]) return { sentence: r, totalLength: text.length };
  }
  // Caret hinter dem letzten Satz (Blockende, Trailing-Whitespace).
  return { sentence: ranges[ranges.length - 1], totalLength: text.length };
}

function rangeFromOffsets(block, startOffset, endOffset) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let pos = 0;
  let startNode = null, startOff = 0, endNode = null, endOff = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (!startNode && pos + len >= startOffset) {
      startNode = node;
      startOff = startOffset - pos;
    }
    if (pos + len >= endOffset) {
      endNode = node;
      endOff = endOffset - pos;
      break;
    }
    pos += len;
  }
  if (!startNode || !endNode) return null;
  const r = document.createRange();
  try {
    r.setStart(startNode, Math.max(0, Math.min(startOff, startNode.nodeValue.length)));
    r.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.nodeValue.length)));
  } catch { return null; }
  return r;
}

// Ein Name für das Highlight-Register, ein Ort zum Löschen — Recenter, Exit und
// clearAllFocusMarks teilen sich diesen Aufruf.
export const SENTENCE_HL = 'focus-sentence-dim';

export function clearSentenceHighlight() {
  if (typeof CSS === 'undefined' || !CSS.highlights) return;
  CSS.highlights.delete(SENTENCE_HL);
}

// Nicht-aktive Sätze im aktiven Block werden via CSS-Custom-Highlight gedimmt.
export function applySentenceHighlight(block, selection) {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
  clearSentenceHighlight();
  // Abgehängter Block (gerade weggelöscht/gemerged): Ranges darauf wären für den
  // Renderer wertlos und hielten den Knoten am Leben. Nächster Tick hat einen
  // frischen Block.
  if (!block || block.isConnected === false) return;
  const text = block.textContent || '';
  let active = null;
  const info = findSentenceAtCaret(block, selection);
  if (info) {
    active = info.sentence;
  } else {
    // Caret sitzt nicht in diesem Block — passiert beim manuellen Scroll
    // (preferCenter: aktiver Block kommt aus der Viewport-Mitte, der Caret
    // steht noch im alten Block) oder ohne Selection. Ersten Satz als „aktiv"
    // nehmen, damit das Satz-Dimming sichtbar bleibt, statt den ganzen Block
    // voll aufleuchten zu lassen (sonst stünden 3 Grautöne nebeneinander:
    // andere Blöcke gedimmt, zentraler Block voll hell, kein Satz-Spotlight).
    const sentences = findSentenceRanges(text);
    if (sentences.length === 0) return;
    active = sentences[0];
  }
  const [s, e] = active;
  const dimRanges = [];
  if (s > 0) {
    const r = rangeFromOffsets(block, 0, s);
    if (r) dimRanges.push(r);
  }
  if (e < text.length) {
    const r = rangeFromOffsets(block, e, text.length);
    if (r) dimRanges.push(r);
  }
  if (dimRanges.length === 0) return;
  try {
    const hl = new Highlight(...dimRanges);
    CSS.highlights.set(SENTENCE_HL, hl);
  } catch { /* unsupported / Range invalid */ }
}
