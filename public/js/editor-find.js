// Find & Replace im Edit-Mode.
// Öffnet eine kleine Leiste über dem contenteditable, navigiert per
// Cmd/Ctrl+F. `this` zeigt auf die Alpine-Komponente.

function getEditEl() {
  return document.querySelector('#editor-card .page-content-view--editing');
}

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
  const isWord = (ch) => /\p{L}|\p{N}|_/u.test(ch || '');

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

export const editorFindMethods = {
  findOpen: false,
  findTerm: '',
  findReplace: '',
  findCaseSensitive: false,
  findWholeWord: false,
  findMatches: [],
  findIndex: -1,
  findX: 0,
  findY: 0,
  _findRecomputeTimer: null,
  _findReflowHandler: null,

  // Cmd/Ctrl+F global: im Edit-Mode Finder öffnen, sonst BookStack-Suche fokussieren.
  handleFindHotkey(event) {
    const isFind = (event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'f' || event.key === 'F');
    if (!isFind) return;
    if (this.editMode && !this.focusMode) {
      event.preventDefault();
      this.openFind();
    } else if (this.selectedBookId) {
      event.preventDefault();
      const input = document.querySelector('.bookstack-search-input');
      if (input) { input.focus(); input.select?.(); }
    }
  },

  openFind() {
    if (!this.editMode) return;
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
        const editEl = getEditEl();
        const within = rect.top >= 80 && rect.bottom <= window.innerHeight - 40;
        if (!within) {
          editEl?.scrollIntoView?.({ block: 'nearest' });
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
      this._markEditDirty?.();
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
    this._markEditDirty?.();
    this.setStatus(this.t('find.replacedAll', { n: count }), false, 3000);
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
