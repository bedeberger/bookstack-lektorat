// Teil von bookEditorCard (Facade cards/book-editor-card.js): Outline/TOC —
// abgeleitete Gliederung + IntersectionObserver für die aktive Markierung.
// Methoden in den Card-Scope gespreadet (gemeinsames `this`).

export const bookEditorOutlineMethods = {
    _initOutlineObserver() {
      this._teardownOutlineObserver();
      if (typeof IntersectionObserver === 'undefined') return;
      const targets = document.querySelectorAll('.book-editor-page-card');
      if (targets.length === 0) return;
      const visible = new Map();
      let rafScheduled = false;
      const flush = () => {
        rafScheduled = false;
        // Topmost sichtbaren Block wählen: kleinster top-offset > 0.
        let bestId = null, bestTop = Infinity;
        for (const [id, top] of visible) {
          if (top < bestTop) { bestTop = top; bestId = id; }
        }
        if (bestId != null) {
          const next = parseInt(bestId, 10);
          if (next !== this.visiblePageId) {
            this.visiblePageId = next;
            // Outline-Scroll der aktiven Markierung nachführen, sobald Alpine die
            // `--active`-Klasse gesetzt hat — sonst wandert der aktive Eintrag bei
            // langem Buch aus dem (höhen-gedeckelten) sticky Outline-Viewport und
            // wird unten abgeschnitten.
            this.$nextTick(() => this._scrollOutlineToActive());
          }
        }
      };
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const id = entry.target.dataset.outlinePageId;
          if (!id) continue;
          if (entry.isIntersecting) {
            // Top-Position relativ zum Viewport — stabiler als intersectionRatio
            // bei langen Blöcken, die den ganzen Viewport füllen (Ratio nahe 1
            // für mehrere Pages → Wechsel zwischen ihnen wackelt).
            visible.set(id, entry.boundingClientRect.top);
          } else {
            visible.delete(id);
          }
        }
        // rAF-Throttle: viele IO-Entries pro Scroll-Tick zu EINEM Update bündeln.
        // Verhindert Reactivity-Sturm + Outline-Active-Glitches beim Fast-Scroll.
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(flush);
        }
      }, {
        // Top-Margin schiebt den Schwellenwert unter den Sticky-Header.
        // Threshold [0] reicht — wir wählen nach boundingClientRect.top, nicht
        // nach Ratio; weniger Trigger-Events.
        rootMargin: '-100px 0px -60% 0px',
        threshold: 0,
      });
      for (const t of targets) io.observe(t);
      this._outlineObserver = io;
    },

    _teardownOutlineObserver() {
      if (this._outlineObserver) {
        this._outlineObserver.disconnect();
        this._outlineObserver = null;
      }
    },

    scrollToBlock(pageId) {
      const el = document.querySelector(`[data-outline-page-id="${pageId}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      this.visiblePageId = pageId;
    },

    // Hält den aktiven Outline-Eintrag im sichtbaren Bereich des sticky, höhen-
    // gedeckelten Inhaltsverzeichnisses — scrollt ausschliesslich den Outline-
    // Container (nie das Fenster), sonst springt das Manuskript. `block: 'nearest'`-
    // Äquivalent: nur scrollen, wenn der Eintrag oben/unten aus dem Viewport ragt.
    _scrollOutlineToActive() {
      const outline = this.$root?.querySelector?.('.book-editor-outline');
      if (!outline) return;
      const active = outline.querySelector('.book-editor-outline-page--active');
      if (!active) return;
      const cRect = outline.getBoundingClientRect();
      const aRect = active.getBoundingClientRect();
      const pad = 24; // etwas Kontext über/unter dem aktiven Eintrag halten
      if (aRect.top < cRect.top + pad) {
        outline.scrollTop -= (cRect.top + pad) - aRect.top;
      } else if (aRect.bottom > cRect.bottom - pad) {
        outline.scrollTop += aRect.bottom - (cRect.bottom - pad);
      }
    },

    toggleChapterCollapse(chapterId) {
      const next = { ...this.collapsedChapters };
      if (next[chapterId]) delete next[chapterId];
      else next[chapterId] = true;
      this.collapsedChapters = next;
    },

    // Mini-Status-Punkt pro Outline-Eintrag. Leitet sich aus derselben
    // Zustandsmaschine ab wie der Block-Status (`blockStatus` in der Card) —
    // die Outline kennt nur einen Fehler-Zustand, darum faltet sie
    // conflict → error. Keine zweite Ableitung, die auseinanderlaufen kann.
    outlinePageStatus(block) {
      const status = this.blockStatus(block);
      return status === 'conflict' ? 'error' : status;
    },
};
