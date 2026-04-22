// Figuren-Lookup für den Editor (Edit- und Fokus-Modus).
// Ctrl/Cmd-Klick auf ein Wort, das gegen Figur-Namen matcht → Popover mit
// Geburt, Eigenschaften sowie optional Beruf/Rolle. Im Edit-Modus zusätzlich
// "Figur öffnen"-Link (nicht im Fokus-Modus, dort würde der Kontext-Wechsel
// den Fluss brechen).
//
// Zweigeteilt:
//   - `figurLookupMethods`: Root-Methoden (Index, Word-Lookup, Click-Handler,
//     `_tryOpenFigurLookupAt` für synchronen Hit-Test aus dem Synonym-Menü).
//     Dispatcht `editor:figur-lookup:open { fig, x, y }` und
//     `editor:figur-lookup:close` — die Sub-Komponente hört darauf.
//   - `figurLookupCardMethods`: Popup-Display (Position, Scroll, Schliessen)
//     in Alpine.data('editorFigurLookupCard').

import { isWordChar, normalizeName, WORD_RE } from './editor-utils.js';

function extractYear(geburtstag) {
  if (!geburtstag) return null;
  const m = String(geburtstag).match(/\b(\d{4})\b/);
  return m ? m[1] : null;
}

function wordAtClientPoint(x, y) {
  const r = rangeForWordAtClientPoint(x, y);
  return r ? r.word : null;
}

// Expandiert einen Punkt (clientX/Y) zum darunterliegenden Wort und liefert
// sowohl das Wort als auch einen Range über genau dieses Wort. Wird auch vom
// Synonym-Handler genutzt, um bei Safari-Rechtsklick ohne Selection das Wort
// unter dem Cursor automatisch zu markieren.
export function rangeForWordAtClientPoint(x, y) {
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
  const text = node.nodeValue || '';
  if (!text) return null;
  let start = range.startOffset;
  let end   = range.startOffset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return null;
  const word = text.slice(start, end);
  if (!WORD_RE.test(word)) return null;
  const wordRange = document.createRange();
  wordRange.setStart(node, start);
  wordRange.setEnd(node, end);
  return { range: wordRange, word };
}

// ── Root-Methoden ──────────────────────────────────────────────────────────
// Lookup-Index + Word-Matching leben am Root, weil `_tryOpenFigurLookupAt`
// synchron ein Bool zurückgeben muss (Synonym-Menü nutzt das, um nicht zu
// öffnen, falls bereits ein Figur-Popover gezeigt wird). Der Display-Teil
// läuft als Sub-Komponente und wird über Events gesteuert.
export const figurLookupMethods = {
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
    this._tryOpenFigurLookupAt(e);
  },

  // Gemeinsamer Einstieg für Figuren-Popover an einer Click-Position.
  // Auf macOS feuert Ctrl+Click kein `click`-Event, nur `contextmenu` — daher
  // ruft auch der Synonym-Kontextmenü-Handler diese Methode auf.
  // Gibt true zurück, wenn ein Popover geöffnet wurde.
  _tryOpenFigurLookupAt(e) {
    if (!this.editMode) return false;
    const word = wordAtClientPoint(e.clientX, e.clientY);
    if (!word) return false;
    const fig = this._findFigurByWord(word);
    if (!fig) return false;
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('editor:figur-lookup:open', {
      detail: { fig, x: e.clientX, y: e.clientY },
    }));
    return true;
  },

  // Trampolin — Legacy-Aufrufer (resetPage, cancelEdit, focus-mode,
  // synonyme-close) rufen `closeFigurLookup()` am Root. Dispatcht an die Sub.
  closeFigurLookup() {
    window.dispatchEvent(new CustomEvent('editor:figur-lookup:close'));
  },
};

// ── Sub-Komponenten-Methoden ──────────────────────────────────────────────
// `this` zeigt auf die Alpine.data('editorFigurLookupCard')-Instanz.
export const figurLookupCardMethods = {
  _openFigurLookup(fig, clientX, clientY) {
    this.figurLookupData = fig;
    this.showFigurLookup = true;
    // Root-Flag, damit editor-focus-onKey (Escape) weiss, dass ein Popover
    // offen ist, ohne in die Sub greifen zu müssen.
    if (window.__app) window.__app._figurLookupOpen = true;
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
    if (window.__app) window.__app._figurLookupOpen = false;
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
      if (window.__app?.focusMode) { this.closeFigurLookup(); return; }
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
    await window.__app?.openFigurById?.(fig.id);
  },
};
