// Figuren-Lookup für den Editor (Edit- und Fokus-Modus).
// Ctrl/Cmd-Klick auf ein Wort, das gegen Figur-Namen matcht → Popover mit
// Geburt, Eigenschaften sowie optional Beruf/Rolle. Im Edit-Modus zusätzlich
// "Figur öffnen"-Link (nicht im Fokus-Modus, dort würde der Kontext-Wechsel
// den Fluss brechen).

import { escHtml } from './utils.js';

const WORD_AT_POINT_RE = /[\p{L}\p{N}][\p{L}\p{N}\-']*/u;

function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function extractYear(geburtstag) {
  if (!geburtstag) return null;
  const m = String(geburtstag).match(/\b(\d{4})\b/);
  return m ? m[1] : null;
}

// Expandiert den Offset im Textknoten zu einem Wort (Buchstaben/Ziffern, plus - und ').
function wordAtTextNode(textNode, offset) {
  const text = textNode.nodeValue || '';
  if (!text) return null;
  const isWordChar = (c) => /[\p{L}\p{N}\-']/u.test(c);
  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return null;
  const word = text.slice(start, end);
  if (!WORD_AT_POINT_RE.test(word)) return null;
  return word;
}

function wordAtClientPoint(x, y) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (!range) return null;
  const node = range.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  return wordAtTextNode(node, range.startOffset);
}

export const figurLookupMethods = {
  // ── State (via Spread in Alpine-Komponente ergänzt) ────────────────────────
  // showFigurLookup, figurLookupX, figurLookupY, figurLookupData
  // _figurLookupScrollHandler, _figurLookupIndex

  _buildFigurLookupIndex() {
    const map = new Map();
    for (const f of (this.figuren || [])) {
      const keys = new Set();
      if (f.name) keys.add(normalizeName(f.name));
      if (f.kurzname) keys.add(normalizeName(f.kurzname));
      // Einzel-Tokens aus dem Vollnamen (für "Müller" aus "Anna Müller"),
      // aber nur wenn der Token eindeutig bleibt.
      if (f.name) {
        for (const tok of String(f.name).split(/\s+/)) {
          const n = normalizeName(tok);
          if (n.length >= 3) keys.add(n);
        }
      }
      for (const k of keys) {
        if (!k) continue;
        if (map.has(k)) {
          map.set(k, null); // mehrdeutig → nicht matchen
        } else {
          map.set(k, f);
        }
      }
    }
    this._figurLookupIndex = map;
  },

  _findFigurByWord(word) {
    if (!word) return null;
    if (!this._figurLookupIndex) this._buildFigurLookupIndex();
    const n = normalizeName(word);
    // Exakter Hit: value kann null sein (mehrdeutig → bewusst nicht matchen).
    if (this._figurLookupIndex.has(n)) return this._figurLookupIndex.get(n);
    // Genitiv-s abschneiden: "Samuels" → "Samuel", "Müllers" → "Müller".
    if (n.length > 2 && n.endsWith('s')) {
      const base = n.slice(0, -1);
      if (this._figurLookupIndex.has(base)) return this._figurLookupIndex.get(base);
    }
    return null;
  },

  _onEditClick(e) {
    if (!this.editMode) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const word = wordAtClientPoint(e.clientX, e.clientY);
    if (!word) return;
    const fig = this._findFigurByWord(word);
    if (!fig) return;
    e.preventDefault();
    e.stopPropagation();
    this._openFigurLookup(fig, e.clientX, e.clientY);
  },

  _openFigurLookup(fig, clientX, clientY) {
    this.figurLookupData = fig;
    this.showFigurLookup = true;
    this._figurLookupAnchor = { x: clientX, y: clientY };
    this._attachFigurLookupScroll();
    this.$nextTick(() => this._positionFigurLookup());
    // Erstpositionierung bereits vor nextTick, damit kein Flash oben links.
    this._positionFigurLookup();
  },

  closeFigurLookup() {
    if (!this.showFigurLookup) return;
    this.showFigurLookup = false;
    this.figurLookupData = null;
    this._figurLookupAnchor = null;
    this._detachFigurLookupScroll();
  },

  _positionFigurLookup() {
    const a = this._figurLookupAnchor;
    if (!a) return;
    const el = document.querySelector('.figur-lookup');
    const h = el?.offsetHeight || 200;
    const w = el?.offsetWidth  || 280;
    const spaceBelow = window.innerHeight - a.y;
    const placeBelow = spaceBelow >= h + 8;
    this.figurLookupX = Math.max(8, Math.min(Math.round(a.x), window.innerWidth - w - 8));
    this.figurLookupY = placeBelow
      ? Math.round(a.y + 8)
      : Math.max(8, Math.round(a.y - h - 8));
  },

  _attachFigurLookupScroll() {
    if (this._figurLookupScrollHandler) return;
    const handler = () => {
      // Im Fokus-Modus driftet das Popover vom darunterliegenden Wort weg,
      // sobald der Text scrollt (typewriter-Recenter). Statt mitzuwandern:
      // schliessen, damit der User einen klaren Zustand sieht.
      if (this.focusMode) { this.closeFigurLookup(); return; }
      this._positionFigurLookup();
    };
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    this._figurLookupScrollHandler = handler;
  },

  _detachFigurLookupScroll() {
    if (!this._figurLookupScrollHandler) return;
    window.removeEventListener('scroll', this._figurLookupScrollHandler, true);
    window.removeEventListener('resize', this._figurLookupScrollHandler);
    this._figurLookupScrollHandler = null;
  },

  // Anzeigewert für das Geburtsfeld: wenn `geburtstag` eine Jahreszahl
  // enthält, diese zurückgeben – sonst den Rohwert (z.B. "Frühling 1850").
  figurLookupGeburt() {
    const g = this.figurLookupData?.geburtstag;
    if (!g) return '';
    return extractYear(g) || String(g);
  },

  async openFigurLookupTarget() {
    const fig = this.figurLookupData;
    this.closeFigurLookup();
    if (!fig?.id) return;
    await this.openFigurById(fig.id);
  },
};
