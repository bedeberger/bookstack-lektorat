// Teil von bookEditorCard (Facade cards/book-editor-card.js): Find/Replace
// über den ganzen Manuskript-Stream via CSS Custom Highlights. Methoden in
// den Card-Scope gespreadet (gemeinsames `this`).
//
// Match-Suche, Offset-Rückmapping und Highlight-Registrierung kommen aus
// editor/shared/text-find.js (geteilt mit dem Notebook-Finder). Hier bleibt
// nur die Bucheditor-Eigenheit: N Block-Roots statt einem, Replace über
// Range-Mutation (statt execCommand) und die Anbindung an die Save-Queue.

import { collectMatches, createHighlightPair, rangeOf } from '../../editor/shared/text-find.js';

const highlights = createHighlightPair('book-editor-find-match', 'book-editor-find-current');
export const clearHighlights = highlights.clear;

export const bookEditorFindMethods = {
    // ── Find / Replace ────────────────────────────────────────────────────
    openFind() {
      this.findOpen = true;
      this.$nextTick(() => {
        const inp = this.$root.querySelector('.book-editor-find-input');
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
    },

    onFindInput() {
      if (this._findRecomputeTimer) clearTimeout(this._findRecomputeTimer);
      this._findRecomputeTimer = setTimeout(() => {
        this._findRecomputeTimer = null;
        this.recomputeFindMatches();
        if (this.findMatches.length > 0) this._selectMatch(0);
      }, 120);
    },

    _allBlockEls() {
      return Array.from(this.$root.querySelectorAll('[data-book-editor-page]'));
    },

    // Treffer aller Blöcke in Stream-Reihenfolge; jeder Match trägt seine
    // Herkunft (pageId + Container) mit, damit Replace den Block wiederfindet.
    recomputeFindMatches() {
      const opts = { caseSensitive: this.findCaseSensitive, wholeWord: this.findWholeWord };
      const matches = [];
      if (this.findTerm) {
        for (const el of this._allBlockEls()) {
          const pageId = parseInt(el.dataset.bookEditorPage, 10);
          for (const m of collectMatches(el, this.findTerm, opts)) {
            matches.push({ ...m, pageId, container: el });
          }
        }
      }
      this.findMatches = matches;
      this.findIndex = matches.length > 0 ? 0 : -1;
      this._refreshFindHighlights();
    },

    _refreshFindHighlights() {
      highlights.paint(this.findMatches, this.findIndex);
    },

    findNext() {
      if (this.findMatches.length === 0) this.recomputeFindMatches();
      if (this.findMatches.length === 0) return;
      this._selectMatch((this.findIndex + 1) % this.findMatches.length);
    },

    findPrev() {
      if (this.findMatches.length === 0) this.recomputeFindMatches();
      if (this.findMatches.length === 0) return;
      this._selectMatch((this.findIndex - 1 + this.findMatches.length) % this.findMatches.length);
    },

    _selectMatch(i) {
      this.findIndex = i;
      this._refreshFindHighlights();
      const m = this.findMatches[i];
      if (!m?.startNode) return;
      try {
        const rect = rangeOf(m).getBoundingClientRect();
        if (rect && (rect.top < 120 || rect.bottom > window.innerHeight - 120)) {
          (m.startNode.parentElement || m.container)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        }
      } catch { /* noop */ }
    },

    replaceCurrent() {
      if (this.findMatches.length === 0) return;
      const m = this.findMatches[this.findIndex];
      if (!m?.startNode || !m?.endNode) return;
      this._doReplaceAt(m);
      this.$nextTick(() => {
        this.recomputeFindMatches();
        if (this.findMatches.length > 0) {
          this._selectMatch(Math.min(this.findIndex, this.findMatches.length - 1));
        }
      });
    },

    replaceAll() {
      if (!this.findTerm) return;
      this.recomputeFindMatches();
      if (this.findMatches.length === 0) return;
      // Von hinten nach vorne: Ersetzungen weiter hinten lassen die Ranges der
      // früheren Treffer intakt (sonst verschieben sich deren Offsets).
      const matches = this.findMatches.slice().reverse();
      let count = 0;
      for (const m of matches) {
        if (this._doReplaceAt(m)) count++;
      }
      const app = window.__app;
      app?.setStatus?.(app.t('bookEditor.find.replacedAll', { n: count }), false, 3000);
      this.$nextTick(() => this.recomputeFindMatches());
    },

    _doReplaceAt(m) {
      if (!m.startNode || !m.endNode) return false;
      const container = m.container || m.startNode.parentElement?.closest('[data-book-editor-page]');
      if (!container) return false;
      try {
        const range = rangeOf(m);
        range.deleteContents();
        range.insertNode(document.createTextNode(this.findReplace));
        const block = this._blockById(parseInt(container.dataset.bookEditorPage, 10));
        if (block) {
          block.html = container.innerHTML;
          this._markBlockDirty(block);
        }
        return true;
      } catch {
        return false;
      }
    },
};
