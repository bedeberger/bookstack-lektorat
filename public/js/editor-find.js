// Find & Replace im Edit-Mode.
// Öffnet eine kleine Leiste über dem contenteditable, navigiert per
// Cmd/Ctrl+F. Wird in Alpine.data('editorFindCard') gespread; `this` zeigt
// auf die Sub-Komponente, Root-Zugriffe via window.__app.

import { getEditEl, isWordChar } from './editor-utils.js';

// Flache Liste aller Text-Nodes im Editor (keine Scripts/Styles – die
// gibt's hier ohnehin nicht, TreeWalker reicht).
function collectTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

// Alle Match-Positionen im konkatenierten Text berechnen und auf
// (Text-Node, Offset)-Tupel zurückmappen.
function findMatches(root, term, caseSensitive, wholeWord) {
  if (!term) return [];
  const nodes = collectTextNodes(root);
  const full = nodes.map(n => n.nodeValue).join('');
  const hay = caseSensitive ? full : full.toLowerCase();
  const needle = caseSensitive ? term : term.toLowerCase();
  // Ganzes Wort: Nachbar-Zeichen prüfen. _ zählt als Wort (z.B. Identifier).
  const isWord = (ch) => isWordChar(ch || '') || ch === '_';

  // Offsets jedes Nodes im konkatenierten String – für Rückmapping.
  const starts = new Array(nodes.length);
  let acc = 0;
  for (let i = 0; i < nodes.length; i++) {
    starts[i] = acc;
    acc += nodes[i].nodeValue.length;
  }

  const matches = [];
  let from = 0;
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    if (wholeWord) {
      const before = idx > 0 ? hay[idx - 1] : '';
      const after  = hay[idx + needle.length] || '';
      if (isWord(before) || isWord(after)) { from = idx + 1; continue; }
    }
    matches.push(mapOffset(nodes, starts, idx, needle.length));
    from = idx + Math.max(1, needle.length);
  }
  return matches;
}

function mapOffset(nodes, starts, globalStart, length) {
  const globalEnd = globalStart + length;
  let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
  for (let i = 0; i < nodes.length; i++) {
    const s = starts[i];
    const e = s + nodes[i].nodeValue.length;
    if (startNode == null && globalStart >= s && globalStart <= e) {
      startNode = nodes[i];
      startOffset = globalStart - s;
    }
    if (globalEnd >= s && globalEnd <= e) {
      endNode = nodes[i];
      endOffset = globalEnd - s;
      break;
    }
  }
  return { startNode, startOffset, endNode, endOffset };
}

// Nächster scrollbarer Vorfahre — wichtig für Focus-Mode, wo das
// Edit-Element selbst scrollt statt das Window.
function findScrollContainer(node) {
  let el = node;
  while (el && el !== document.body) {
    const st = getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

function rangeOf(m) {
  const r = document.createRange();
  r.setStart(m.startNode, m.startOffset);
  r.setEnd(m.endNode, m.endOffset);
  return r;
}

// CSS Custom Highlight API – registriert einmalig leere Highlight-Objekte
// unter festen Namen. Die gehören zum Dokument, nicht zum DOM-Baum, landen
// also nicht in BookStack beim Speichern.
const HIGHLIGHT_ALL = 'edit-find-match';
const HIGHLIGHT_CURRENT = 'edit-find-current';
let _hlAll = null, _hlCurrent = null;
function ensureHighlights() {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return false;
  if (!_hlAll) {
    _hlAll = new Highlight();
    CSS.highlights.set(HIGHLIGHT_ALL, _hlAll);
  }
  if (!_hlCurrent) {
    _hlCurrent = new Highlight();
    CSS.highlights.set(HIGHLIGHT_CURRENT, _hlCurrent);
  }
  return true;
}
function clearHighlights() {
  if (_hlAll) _hlAll.clear();
  if (_hlCurrent) _hlCurrent.clear();
}

export const editorFindCardMethods = {
  openFind() {
    const app = window.__app;
    if (!app?.editMode) return;
    const sel = window.getSelection();
    if (sel && sel.toString() && sel.rangeCount > 0) {
      const editEl = getEditEl();
      if (editEl && editEl.contains(sel.anchorNode)) {
        const picked = sel.toString();
        if (picked.length > 0 && picked.length <= 200 && !/\n/.test(picked)) {
          this.findTerm = picked;
        }
      }
    }
    this.findOpen = true;
    this._positionFindWidget();
    this._installFindReflow();
    this.$nextTick(() => {
      const inp = document.querySelector('.edit-find-input');
      if (inp) { inp.focus(); inp.select(); }
      this.recomputeFindMatches();
    });
  },

  closeFind() {
    this.findOpen = false;
    this.findMatches = [];
    this.findIndex = -1;
    clearHighlights();
    if (this._findRecomputeTimer) { clearTimeout(this._findRecomputeTimer); this._findRecomputeTimer = null; }
    this._uninstallFindReflow();
    getEditEl()?.focus();
  },

  // Position an die rechte obere Ecke der Editor-Karte koppeln.
  // Bewusst position:fixed (teleportiert, scrollt nicht mit), damit die
  // Leiste beim Scrollen sichtbar bleibt – Position relativ zur aktuellen
  // Karten-Box des Editors, nicht zum Viewport.
  _positionFindWidget() {
    const card = document.getElementById('editor-card');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const width = 420;
    const right = rect.right - 12;
    this.findX = Math.max(12, Math.min(window.innerWidth - width - 12, right - width));
    this.findY = Math.max(12, rect.top + 12);
  },

  _installFindReflow() {
    if (this._findReflowHandler) return;
    this._findReflowHandler = () => this._positionFindWidget();
    window.addEventListener('resize', this._findReflowHandler);
    window.addEventListener('scroll', this._findReflowHandler, true);
  },

  _uninstallFindReflow() {
    if (!this._findReflowHandler) return;
    window.removeEventListener('resize', this._findReflowHandler);
    window.removeEventListener('scroll', this._findReflowHandler, true);
    this._findReflowHandler = null;
  },

  onFindInput() {
    if (this._findRecomputeTimer) clearTimeout(this._findRecomputeTimer);
    this._findRecomputeTimer = setTimeout(() => {
      this._findRecomputeTimer = null;
      this.recomputeFindMatches();
      if (this.findMatches.length > 0) this._selectFindMatch(0);
    }, 120);
  },

  recomputeFindMatches() {
    const editEl = getEditEl();
    if (!editEl || !this.findTerm) {
      this.findMatches = [];
      this.findIndex = -1;
      this._refreshFindHighlights();
      return;
    }
    this.findMatches = findMatches(editEl, this.findTerm, this.findCaseSensitive, this.findWholeWord);
    this.findIndex = this.findMatches.length > 0 ? 0 : -1;
    this._refreshFindHighlights();
  },

  // Alle Treffer hervorheben via CSS Custom Highlight API (reine Render-
  // Ebene, kein DOM-Eingriff). Läuft komplett ohne Effekt, falls der
  // Browser die API nicht kennt – native Selektion des aktuellen Treffers
  // bleibt immer bestehen.
  _refreshFindHighlights() {
    if (!ensureHighlights()) return;
    clearHighlights();
    if (!this.findMatches || this.findMatches.length === 0) return;
    for (let i = 0; i < this.findMatches.length; i++) {
      const m = this.findMatches[i];
      if (!m.startNode || !m.endNode) continue;
      try {
        const r = rangeOf(m);
        if (i === this.findIndex) _hlCurrent.add(r);
        else _hlAll.add(r);
      } catch (e) { /* ignorieren */ }
    }
  },

  findNext() {
    if (this.findMatches.length === 0) { this.recomputeFindMatches(); }
    if (this.findMatches.length === 0) return;
    const next = (this.findIndex + 1) % this.findMatches.length;
    this._selectFindMatch(next);
  },

  findPrev() {
    if (this.findMatches.length === 0) { this.recomputeFindMatches(); }
    if (this.findMatches.length === 0) return;
    const prev = (this.findIndex - 1 + this.findMatches.length) % this.findMatches.length;
    this._selectFindMatch(prev);
  },

  _selectFindMatch(i) {
    this.findIndex = i;
    this._refreshFindHighlights();
    const m = this.findMatches[i];
    if (!m || !m.startNode || !m.endNode) return;
    // selection.addRange() im contenteditable entreisst ihm den Fokus –
    // aktiven Fokus merken und nach der Selektion zurückgeben, damit der
    // User im Finder weitertippen kann.
    const prevActive = document.activeElement;
    const fromFind = prevActive && prevActive.closest && prevActive.closest('.edit-find');
    try {
      const range = rangeOf(m);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const rect = range.getBoundingClientRect();
      if (rect) {
        // Sichtbarkeitsprüfung gegen den tatsächlichen Scroll-Container
        // (im Focus-Mode scrollt das Edit-Element selbst, sonst das Window).
        // Grosszügige Margins (~25% oben/unten), damit Treffer am Rand
        // beim Durchklicken nicht klemmen, sondern in die Mitte rutschen.
        const editEl = getEditEl();
        const scroller = findScrollContainer(m.startNode.parentElement) || editEl;
        const cRect = scroller && scroller !== document.scrollingElement
          ? scroller.getBoundingClientRect()
          : { top: 0, bottom: window.innerHeight };
        const margin = Math.max(120, (cRect.bottom - cRect.top) * 0.25);
        const within = rect.top >= cRect.top + margin && rect.bottom <= cRect.bottom - margin;
        if (!within) {
          const el = m.startNode.parentElement;
          el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        }
      }
    } catch (e) { /* DOM hat sich geändert – nächster Tick fängt's */ }
    if (fromFind && prevActive.focus) prevActive.focus();
  },

  replaceCurrent() {
    if (this.findMatches.length === 0) return;
    const m = this.findMatches[this.findIndex];
    if (!m || !m.startNode || !m.endNode) return;
    const editEl = getEditEl();
    if (!editEl) return;
    try {
      const range = rangeOf(m);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      editEl.focus();
      document.execCommand('insertText', false, this.findReplace);
      window.__app?._markEditDirty?.();
      this.$nextTick(() => {
        this.recomputeFindMatches();
        if (this.findMatches.length > 0) {
          const nextIdx = Math.min(this.findIndex, this.findMatches.length - 1);
          this._selectFindMatch(nextIdx);
        }
      });
    } catch (e) { /* ignorieren */ }
  },

  replaceAll() {
    const editEl = getEditEl();
    if (!editEl) return;
    const matches = findMatches(editEl, this.findTerm, this.findCaseSensitive, this.findWholeWord);
    if (matches.length === 0) return;
    editEl.focus();
    // Von hinten nach vorne: Ersetzungen weiter hinten im Dokument
    // lassen die Ranges der früheren Treffer intakt – keine erneuten
    // Match-Scans, damit "Ersatz enthält Suchbegriff" nicht endlos loopt.
    let count = 0;
    for (let i = matches.length - 1; i >= 0; i--) {
      try {
        const range = rangeOf(matches[i]);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, this.findReplace);
        count++;
      } catch (e) { /* Match ungültig – überspringen */ }
    }
    const app = window.__app;
    app?._markEditDirty?.();
    app?.setStatus?.(app.t('find.replacedAll', { n: count }), false, 3000);
    this.$nextTick(() => this.recomputeFindMatches());
  },

  // Tastatur innerhalb der Find-Leiste.
  onFindKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); this.closeFind(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) this.findPrev();
      else this.findNext();
    }
  },
};
