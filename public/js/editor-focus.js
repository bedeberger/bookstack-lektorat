// Vollbild-Fokusmodus mit Absatz-Hervorhebung + Typewriter-Scroll.
// Nur im Bearbeitungsmodus aktivierbar.

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'LI', 'PRE']);
const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, pre';

// Wie lange nach einem Pointer-Event ein darauf folgendes selectionchange
// noch als Maus/Touch zählt (kein Recenter). Ein Klick erzeugt Pointerdown→up
// und kurz danach selectionchange – die Spanne deckt das ab.
const POINTER_GRACE_MS = 250;
// Wie lange Scroll-Events nach einem programmatischen scrollBy() ignoriert
// werden. smooth-scroll feuert n Events; Counter wäre nicht deterministisch.
const PROG_SCROLL_GRACE_MS = 400;

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

function findBlockAtViewportCenter(container, visibleBlocks) {
  const rect = container.getBoundingClientRect();
  const centerY = rect.top + rect.height / 2;
  // Bevorzugt das vom IntersectionObserver gepflegte Set (typ. <10 Blöcke).
  // Fallback auf Vollscan, wenn der Observer noch nicht gefeuert hat.
  const pool = (visibleBlocks && visibleBlocks.size > 0)
    ? visibleBlocks
    : container.querySelectorAll(BLOCK_SEL);
  let best = null;
  let bestDist = Infinity;
  for (const el of pool) {
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

function getCaretRect(container) {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.startContainer)) return null;
  const rects = range.getClientRects();
  if (rects.length > 0 && rects[0].height > 0) return rects[0];
  const rect = range.getBoundingClientRect();
  if (rect.height > 0) return rect;
  return null;
}

function typewriterScroll(container, targetRect) {
  if (!container || !targetRect) return;
  const cRect = container.getBoundingClientRect();
  const targetCenter = targetRect.top + targetRect.height / 2;
  const containerCenter = cRect.top + cRect.height / 2;
  const delta = targetCenter - containerCenter;
  if (Math.abs(delta) < 2) return;
  container.scrollBy({ top: delta, behavior: 'smooth' });
}

export const focusMethods = {
  focusMode: false,
  _focusRaf: null,
  _focusLastProgScroll: 0,
  _focusLastPointer: 0,
  _focusListeners: null,
  _focusVisibleBlocks: null,
  _focusEnteredFromView: false,

  toggleFocusMode() {
    if (this.focusMode) this.exitFocusMode(); else this.enterFocusMode();
  },

  startFocusEdit() {
    const fromView = !this.editMode;
    if (!this.editMode) {
      this.startEdit();
      if (!this.editMode) return;
    }
    this._focusEnteredFromView = fromView;
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

      // IntersectionObserver pflegt das Set sichtbarer Blöcke; MutationObserver
      // observiert neu hinzukommende Blöcke (Enter im Editor erzeugt <p>).
      // So läuft die Center-Suche bei langen Seiten über ~10 statt n Blöcke.
      const visibleBlocks = new Set();
      this._focusVisibleBlocks = visibleBlocks;
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visibleBlocks.add(e.target);
          else visibleBlocks.delete(e.target);
        }
      }, { root: container, threshold: 0 });
      const observeAll = () => {
        for (const el of container.querySelectorAll(BLOCK_SEL)) io.observe(el);
      };
      observeAll();
      const mo = new MutationObserver(observeAll);
      mo.observe(container, { childList: true, subtree: true });

      // Klick/Touch soll NICHT typewriter-scrollen – der Cursor sitzt dort,
      // wo der User hingeklickt hat. Nur Tippen/Pfeiltasten recentern.
      const markPointer = () => { this._focusLastPointer = performance.now(); };
      const onSelection = () => {
        const isPointer = performance.now() - this._focusLastPointer < POINTER_GRACE_MS;
        this._focusUpdateActive(!isPointer);
      };
      const onScroll = () => {
        if (performance.now() - this._focusLastProgScroll < PROG_SCROLL_GRACE_MS) return;
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

      // Mobile-Tastatur: visualViewport schrumpft UND kann scrollen
      // (Android Chrome: offsetTop wird non-zero, wenn die KB den fixed
      // Container nach oben schiebt). --focus-vh treibt die Card-Höhe,
      // --focus-vh-top hält die Card am sichtbaren Viewport-Rand.
      const syncViewport = () => {
        const vv = window.visualViewport;
        const h = vv ? vv.height : window.innerHeight;
        const top = vv ? vv.offsetTop : 0;
        document.documentElement.style.setProperty('--focus-vh', h + 'px');
        document.documentElement.style.setProperty('--focus-vh-top', top + 'px');
        if (this.focusMode) this._focusUpdateActive(true);
      };
      // Sicherheitsnetz: beim Eintritt Dokument-Scroll zurücksetzen, damit
      // position:fixed mit visualViewport nicht auseinanderdriftet.
      window.scrollTo(0, 0);
      syncViewport();

      document.addEventListener('selectionchange', onSelection);
      container.addEventListener('scroll', onScroll, { passive: true });
      container.addEventListener('pointerdown', markPointer);
      container.addEventListener('pointerup', markPointer);
      window.addEventListener('keydown', onKey);
      window.visualViewport?.addEventListener('resize', syncViewport);
      window.visualViewport?.addEventListener('scroll', syncViewport);
      this._focusListeners = { onSelection, onScroll, markPointer, onKey, syncViewport, container, io, mo };

      this._focusUpdateActive(true);
      const editEl = document.querySelector('.page-content-view--editing');
      editEl?.focus();
    });
  },

  exitFocusMode() {
    if (!this.focusMode) return;
    const enteredFromView = this._focusEnteredFromView;
    this._focusEnteredFromView = false;
    this.focusMode = false;
    document.body.classList.remove('focus-mode');
    document.documentElement.style.removeProperty('--focus-vh');
    document.documentElement.style.removeProperty('--focus-vh-top');

    const L = this._focusListeners;
    if (L) {
      document.removeEventListener('selectionchange', L.onSelection);
      L.container?.removeEventListener('scroll', L.onScroll);
      L.container?.removeEventListener('pointerdown', L.markPointer);
      L.container?.removeEventListener('pointerup', L.markPointer);
      window.removeEventListener('keydown', L.onKey);
      if (L.syncViewport) {
        window.visualViewport?.removeEventListener('resize', L.syncViewport);
        window.visualViewport?.removeEventListener('scroll', L.syncViewport);
      }
      L.io?.disconnect();
      L.mo?.disconnect();
      this._focusListeners = null;
    }
    this._focusVisibleBlocks = null;
    this._focusLastPointer = 0;
    this._focusLastProgScroll = 0;
    if (this._focusRaf) { cancelAnimationFrame(this._focusRaf); this._focusRaf = null; }

    document.querySelectorAll('#editor-card .focus-paragraph-active')
      .forEach(el => el.classList.remove('focus-paragraph-active'));

    // Fokus aus Ansichtsmodus gestartet + nichts Ungespeichertes → zurück in die Ansicht.
    if (enteredFromView && this.editMode && !this.editDirty) {
      this._stopAutosave?.();
      this._uninstallOnlineRetry?.();
      this.editMode = false;
      this.editSaving = false;
      this.saveOffline = false;
      this.lastDraftSavedAt = null;
      this.closeSynonymMenu?.();
      this.closeSynonymPicker?.();
      this.updatePageView?.();
    }
  },

  _focusUpdateActive(scroll) {
    if (!this.focusMode) return;
    if (this._focusRaf) cancelAnimationFrame(this._focusRaf);
    this._focusRaf = requestAnimationFrame(() => {
      this._focusRaf = null;
      const container = this._focusListeners?.container;
      if (!container) return;

      let block = null;
      const sel = document.getSelection();
      if (sel && sel.rangeCount > 0) {
        const anchor = sel.anchorNode;
        if (anchor && container.contains(anchor)) {
          block = findBlockFromNode(anchor, container);
        }
      }
      if (!block) block = findBlockAtViewportCenter(container, this._focusVisibleBlocks);

      setActiveBlock(container, block);

      if (scroll && block) {
        // Cursor-Zeile bevorzugen (echter Typewriter-Scroll). Nur wenn keine
        // Caret-Rect ermittelbar ist (z.B. leerer Absatz, kein Fokus), auf
        // Block-Mitte zurückfallen.
        const targetRect = getCaretRect(container) || block.getBoundingClientRect();
        this._focusLastProgScroll = performance.now();
        typewriterScroll(container, targetRect);
      }
    });
  },
};
