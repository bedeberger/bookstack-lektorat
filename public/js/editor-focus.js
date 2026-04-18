// Vollbild-Fokusmodus mit Absatz-Hervorhebung + Typewriter-Scroll.
// Nur im Bearbeitungsmodus aktivierbar.

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'LI', 'PRE']);
const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, pre';

function getScrollContainer() {
  return document.querySelector('#editor-card .page-content-view:not([style*="display: none"])')
      || document.querySelector('#editor-card .page-content-view');
}

function findBlockFromNode(node, root) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && BLOCK_TAGS.has(cur.tagName)) return cur;
    cur = cur.parentNode;
  }
  return null;
}

function findBlockAtViewportCenter(container) {
  const rect = container.getBoundingClientRect();
  const centerY = rect.top + rect.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const el of container.querySelectorAll(BLOCK_SEL)) {
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    const dist = Math.abs((r.top + r.bottom) / 2 - centerY);
    if (dist < bestDist) { bestDist = dist; best = el; }
  }
  return best;
}

function setActiveBlock(container, block) {
  if (!container) return;
  const prev = container.querySelector('.focus-paragraph-active');
  if (prev && prev !== block) prev.classList.remove('focus-paragraph-active');
  if (block && !block.classList.contains('focus-paragraph-active')) {
    block.classList.add('focus-paragraph-active');
  }
}

function typewriterScroll(container, block) {
  if (!container || !block) return;
  const cRect = container.getBoundingClientRect();
  const bRect = block.getBoundingClientRect();
  const blockCenter = bRect.top + bRect.height / 2;
  const containerCenter = cRect.top + cRect.height / 2;
  const delta = blockCenter - containerCenter;
  if (Math.abs(delta) < 2) return;
  container.scrollBy({ top: delta, behavior: 'smooth' });
}

export const focusMethods = {
  focusMode: false,
  _focusRaf: null,
  _focusSuppressScroll: 0,
  _focusListeners: null,

  toggleFocusMode() {
    if (this.focusMode) this.exitFocusMode(); else this.enterFocusMode();
  },

  startFocusEdit() {
    if (!this.editMode) {
      this.startEdit();
      if (!this.editMode) return;
    }
    this.$nextTick(() => this.enterFocusMode());
  },

  enterFocusMode() {
    if (this.focusMode) return;
    if (!this.showEditorCard || !this.editMode) return;
    if (this.checkDone) {
      this.closeFindings?.();
      const editEl = document.querySelector('#editor-card .page-content-view--editing');
      if (editEl) {
        editEl.querySelectorAll('mark.lektorat-mark').forEach(m => {
          const parent = m.parentNode;
          while (m.firstChild) parent.insertBefore(m.firstChild, m);
          parent.removeChild(m);
        });
        editEl.normalize();
      }
    }
    this.focusMode = true;
    document.body.classList.add('focus-mode');

    this.$nextTick(() => {
      const container = getScrollContainer();
      if (!container) return;

      // Klick/Touch soll NICHT typewriter-scrollen – der Cursor sitzt dort,
      // wo der User hingeklickt hat. Nur Tippen/Pfeiltasten recentern.
      const onPointerDown = () => { this._focusPointerActive = true; };
      const onPointerUp = () => {
        // Kurze Schonfrist, damit der nachfolgende selectionchange-Event
        // (der direkt nach dem Klick feuert) noch als Maus-Input zählt.
        setTimeout(() => { this._focusPointerActive = false; }, 120);
      };
      const onSelection = () => this._focusUpdateActive(!this._focusPointerActive);
      const onScroll = () => {
        if (this._focusSuppressScroll > 0) { this._focusSuppressScroll--; return; }
        this._focusUpdateActive(false);
      };
      const onKey = (e) => {
        if (e.key === 'Escape' && this.focusMode) {
          if (this.showSynonymMenu || this.showSynonymPicker) return;
          e.preventDefault();
          if (this.editMode && this.editDirty && this.cancelEdit) {
            this.cancelEdit();
          } else {
            this.exitFocusMode();
          }
        } else if (e.key === 'F11') {
          e.preventDefault();
          this.toggleFocusMode();
        }
      };

      // Mobile-Tastatur: visualViewport schrumpft → CSS-Var --focus-vh
      // treibt sowohl Card-Höhe als auch Typewriter-Padding, danach recentern.
      const syncViewport = () => {
        const vv = window.visualViewport;
        const h = vv ? vv.height : window.innerHeight;
        document.documentElement.style.setProperty('--focus-vh', h + 'px');
        if (this.focusMode) this._focusUpdateActive(true);
      };
      syncViewport();

      document.addEventListener('selectionchange', onSelection);
      container.addEventListener('scroll', onScroll, { passive: true });
      container.addEventListener('pointerdown', onPointerDown);
      container.addEventListener('pointerup', onPointerUp);
      window.addEventListener('keydown', onKey);
      window.visualViewport?.addEventListener('resize', syncViewport);
      this._focusListeners = { onSelection, onScroll, onPointerDown, onPointerUp, onKey, syncViewport, container };

      this._focusUpdateActive(true);
      const editEl = document.querySelector('.page-content-view--editing');
      editEl?.focus();
    });
  },

  exitFocusMode() {
    if (!this.focusMode) return;
    this.focusMode = false;
    document.body.classList.remove('focus-mode');
    document.documentElement.style.removeProperty('--focus-vh');

    const L = this._focusListeners;
    if (L) {
      document.removeEventListener('selectionchange', L.onSelection);
      L.container?.removeEventListener('scroll', L.onScroll);
      L.container?.removeEventListener('pointerdown', L.onPointerDown);
      L.container?.removeEventListener('pointerup', L.onPointerUp);
      window.removeEventListener('keydown', L.onKey);
      if (L.syncViewport) {
        window.visualViewport?.removeEventListener('resize', L.syncViewport);
      }
      this._focusListeners = null;
    }
    this._focusPointerActive = false;
    if (this._focusRaf) { cancelAnimationFrame(this._focusRaf); this._focusRaf = null; }

    document.querySelectorAll('#editor-card .focus-paragraph-active')
      .forEach(el => el.classList.remove('focus-paragraph-active'));
  },

  _focusUpdateActive(scroll) {
    if (!this.focusMode) return;
    if (this._focusRaf) cancelAnimationFrame(this._focusRaf);
    this._focusRaf = requestAnimationFrame(() => {
      this._focusRaf = null;
      const container = getScrollContainer();
      if (!container) return;

      let block = null;
      const sel = document.getSelection();
      if (sel && sel.rangeCount > 0) {
        const anchor = sel.anchorNode;
        if (anchor && container.contains(anchor)) {
          block = findBlockFromNode(anchor, container);
        }
      }
      if (!block) block = findBlockAtViewportCenter(container);

      setActiveBlock(container, block);

      if (scroll && block) {
        this._focusSuppressScroll = 2;
        typewriterScroll(container, block);
      }
    });
  },
};
