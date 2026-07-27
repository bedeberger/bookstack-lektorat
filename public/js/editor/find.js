// Find & Replace im Edit-Mode.
// Öffnet eine kleine Leiste über dem contenteditable, navigiert per
// Cmd/Ctrl+F. Wird in Alpine.data('editorFindCard') gespread; `this` zeigt
// auf die Sub-Komponente, Root-Zugriffe via window.__app.

import { getEditEl, attachReflow } from './utils.js';
import { collectMatches, createHighlightPair, rangeOf } from './shared/text-find.js';

// Match-Suche + Offset-Rückmapping + Highlight-Registrierung liegen in
// shared/text-find.js — geteilt mit dem Bucheditor (cards/book-editor/find.js).
const findMatches = (root, term, caseSensitive, wholeWord) =>
  collectMatches(root, term, { caseSensitive, wholeWord });

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

// CSS Custom Highlight API – Paar aus „alle Treffer" und „aktueller Treffer".
// Die Highlights gehören zum Dokument, nicht zum DOM-Baum, landen also nicht
// im gespeicherten Seiten-HTML.
const highlights = createHighlightPair('edit-find-match', 'edit-find-current');
const clearHighlights = highlights.clear;

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
    if (this._findReflowDetach) return;
    this._findReflowDetach = attachReflow(() => this._positionFindWidget());
  },

  _uninstallFindReflow() {
    if (!this._findReflowDetach) return;
    this._findReflowDetach();
    this._findReflowDetach = null;
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

  // Alle Treffer hervorheben (reine Render-Ebene, kein DOM-Eingriff). Läuft
  // ohne Effekt, falls der Browser die API nicht kennt – native Selektion des
  // aktuellen Treffers bleibt immer bestehen.
  _refreshFindHighlights() {
    highlights.paint(this.findMatches, this.findIndex);
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
