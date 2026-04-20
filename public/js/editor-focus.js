// Vollbild-Fokusmodus mit Absatz-Hervorhebung + Typewriter-Scroll.
// Nur im Bearbeitungsmodus aktivierbar.
//
// State-Machine: idle → entering → active → exiting → idle.
// Re-Entry während entering/exiting wird hart geblockt; eine Generation-
// Zähler-Variable invalidiert asynchrone Nachzügler (z.B. RAFs, die nach
// einem schnellen exit noch feuern wollen).
//
// @typedef {Object} FocusHost  Erwartete Felder/Methoden auf der Alpine-Komponente:
//   @property {boolean} editMode, editDirty, editSaving, saveOffline
//   @property {boolean} showEditorCard, showSynonymMenu, showSynonymPicker, showFigurLookup
//   @property {(fn: Function) => Promise<void>} $nextTick
//   @property {() => void} startEdit, cancelEdit
//   @property {() => void} closeSynonymMenu, closeSynonymPicker, closeFigurLookup
//   @property {() => void} _stopAutosave, _uninstallOnlineRetry, updatePageView
//   @property {() => Promise<void>} quickSave

// Block-Elemente, die als „aktiver Absatz" erkannt werden. TABLE-Zellen und
// FIGURE/FIGCAPTION zählen mit, damit Klicks in Tabellen/Bildunterschriften
// nicht auf Viewport-Center zurückfallen. DIV bewusst NICHT drin – Chromium-
// Default-Paragraph-Separator soll <p> erzeugen; DIV würde die Garantie
// aushebeln.
const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'LI', 'PRE',
  'TD', 'TH', 'FIGURE', 'FIGCAPTION',
]);
const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, pre, td, th, figure, figcaption';

const POINTER_GRACE_MS = 300;
const VV_DEBOUNCE_MS = 100;

// --- Feature-Detect ---------------------------------------------------------

const HAS_IO = typeof IntersectionObserver !== 'undefined';
const HAS_MO = typeof MutationObserver !== 'undefined';

function prefersReducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

function reportError(tag, err) {
  // Zentraler Error-Sink, damit späteres Telemetry-Hook an einer Stelle eingeklinkt werden kann.
  try { console.error('[focus:' + tag + ']', err); } catch { /* last-resort swallow */ }
}

function getScrollContainer() {
  // Fokusmodus läuft ausschliesslich im Edit-Modus (Guard in enterFocusMode),
  // also ist `--editing` immer der gewünschte Scroll-Container. Das frühere
  // `:not([style*="display: none"])` konnte in Alpine-x-show-Flush-Races den
  // leeren View-Container fangen (display:none, 0x0) – Folge: keine aktive
  // Absatz-Markierung, keine Dim-Transition, Editor sah „nichts passiert" aus.
  return document.querySelector('#editor-card .page-content-view--editing');
}

// --- Pure helpers (exportiert für Unit-Tests) -------------------------------

export function findBlockFromNode(node, root, blockTags = BLOCK_TAGS) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && blockTags.has(cur.tagName)) return cur;
    cur = cur.parentNode;
  }
  return null;
}

// Nimmt beliebiges Iterable von Elementen mit getBoundingClientRect(). Für
// Unit-Tests reicht {getBoundingClientRect: () => ({top, bottom, height})}.
export function pickCenterBlock(containerRect, blocks) {
  const centerY = containerRect.top + containerRect.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    const dist = Math.abs((r.top + r.bottom) / 2 - centerY);
    if (dist < bestDist) { bestDist = dist; best = el; }
  }
  return best;
}

export function findBlockAtViewportCenter(container, visibleBlocks, blockSel = BLOCK_SEL) {
  if (!container) return null;
  const pool = (visibleBlocks && visibleBlocks.size > 0)
    ? visibleBlocks
    : container.querySelectorAll(blockSel);
  return pickCenterBlock(container.getBoundingClientRect(), pool);
}

// Räumt defensiv ALLE Active-Markierungen ab und setzt – falls gewünscht –
// genau eine neue. querySelectorAll statt querySelector, weil Chromium beim
// Paragraph-Split in contenteditable die Klasse auf beide <p> kopiert (Enter
// im aktiven Absatz); ohne Vollscan bleibt die „Leiche" stehen und es wirkt,
// als seien zwei Absätze aktiv. block=null → alles ausgrauen.
export function setActiveBlock(container, block) {
  if (!container) return;
  const prevs = container.querySelectorAll('.focus-paragraph-active');
  for (const prev of prevs) {
    if (prev !== block) prev.classList.remove('focus-paragraph-active');
  }
  if (block && !block.classList.contains('focus-paragraph-active')) {
    block.classList.add('focus-paragraph-active');
  }
}

export function getCaretRect(container, selection) {
  const sel = selection || (typeof document !== 'undefined' ? document.getSelection() : null);
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container || !container.contains(range.startContainer)) return null;
  const rects = range.getClientRects();
  if (rects.length > 0 && rects[0].height > 0) return rects[0];
  const rect = range.getBoundingClientRect();
  if (rect.height > 0) return rect;
  return null;
}

// Pure: wie weit muss gescrollt werden, damit targetRect auf containerRect-
// Mitte sitzt? <2px → no-op (kein jitter).
export function computeTypewriterDelta(containerRect, targetRect) {
  if (!containerRect || !targetRect) return 0;
  const targetCenter = targetRect.top + targetRect.height / 2;
  const containerCenter = containerRect.top + containerRect.height / 2;
  const delta = targetCenter - containerCenter;
  return Math.abs(delta) < 2 ? 0 : delta;
}

function typewriterScroll(container, targetRect) {
  if (!container || !targetRect) return 0;
  const delta = computeTypewriterDelta(container.getBoundingClientRect(), targetRect);
  if (delta === 0) return 0;
  // prefers-reduced-motion: User hat System-Weit angegeben „kein Animation-
  // Overhead". Zwei-Schritt-Scroll überspringen und direkt den Zielwert
  // setzen, damit aktiver Absatz trotzdem passt.
  if (prefersReducedMotion()) {
    container.scrollTop += delta;
    return delta;
  }
  container.scrollBy({ top: delta, behavior: 'auto' });
  return delta;
}

// --- Alpine-Methoden --------------------------------------------------------

export const focusMethods = {
  focusMode: false,
  // State-machine + generation counter. _focusListeners/_focusVisibleBlocks/
  // _focusRaf bleiben als flache Felder erhalten, damit bestehende Tests
  // (inkl. Leak-Asserts) unverändert funktionieren.
  _focusState: 'idle',
  _focusGen: 0,
  _focusListeners: null,
  _focusVisibleBlocks: null,
  _focusRaf: null,

  toggleFocusMode() {
    if (this._focusState === 'active') this.exitFocusMode();
    else if (this._focusState === 'idle') this.enterFocusMode();
    // entering/exiting → ignorieren (kein Double-Trigger).
  },

  startFocusEdit() {
    if (!this.editMode) {
      this.startEdit();
      if (!this.editMode) return;
    }
    this.$nextTick(() => this.enterFocusMode());
  },

  enterFocusMode() {
    if (this._focusState !== 'idle') return;
    if (!this.showEditorCard || !this.editMode) return;

    this._focusState = 'entering';
    const gen = ++this._focusGen;

    this.focusMode = true;
    document.body.classList.add('focus-mode');

    this.$nextTick(() => {
      // Wenn in der Zwischenzeit jemand exit() gerufen oder schneller
      // re-entered hat → abbrechen.
      if (gen !== this._focusGen || this._focusState !== 'entering') return;
      try {
        this._focusInstall();
        this._focusState = 'active';
        this._focusUpdateActive(true);
      } catch (err) {
        reportError('enterFocusMode', err);
        this._focusTeardown();
        this.focusMode = false;
        document.body.classList.remove('focus-mode');
        this._focusState = 'idle';
      }
    });
  },

  _focusInstall() {
    const container = getScrollContainer();
    if (!container) throw new Error('focus: no scroll container');

    const abort = new AbortController();
    const signal = abort.signal;
    const visibleBlocks = new Set();

    // IntersectionObserver: pflegt Set sichtbarer Blöcke. MutationObserver:
    // beobachtet NEU hinzukommende Blöcke (nur addedNodes, nicht Vollscan bei
    // jeder Mutation – sonst wird Paste von 500 Absätzen O(n²)). removedNodes
    // werden unobserved, damit IO keine Refs auf entfernte DOM-Knoten über
    // lange Edit-Sessions sammelt.
    let io = null;
    if (HAS_IO) {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visibleBlocks.add(e.target);
          else visibleBlocks.delete(e.target);
        }
      }, { root: container, threshold: 0 });
      for (const el of container.querySelectorAll(BLOCK_SEL)) io.observe(el);
    }

    let mo = null;
    if (HAS_MO) {
      const observeSubtree = (node) => {
        if (!io || node.nodeType !== 1) return;
        if (BLOCK_TAGS.has(node.tagName)) io.observe(node);
        const nested = node.querySelectorAll?.(BLOCK_SEL);
        if (nested) for (const el of nested) io.observe(el);
      };
      const unobserveSubtree = (node) => {
        if (!io || node.nodeType !== 1) return;
        visibleBlocks.delete(node);
        if (BLOCK_TAGS.has(node.tagName)) io.unobserve(node);
        const nested = node.querySelectorAll?.(BLOCK_SEL);
        if (nested) for (const el of nested) { visibleBlocks.delete(el); io.unobserve(el); }
      };
      mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) observeSubtree(node);
          for (const node of m.removedNodes) unobserveSubtree(node);
        }
      });
      mo.observe(container, { childList: true, subtree: true });
    }

    // pointerIntent: Flag + Timeout-Fallback. Klick → Flag an → Selection-
    // change konsumiert es und recentert NICHT. Arrow/Tipp ohne Klick →
    // Flag aus → Recenter. Timeout fängt Klicks ab, die nie einen
    // selectionchange erzeugen (Klick in leeren Margin).
    const ctx = {
      abort, container, visibleBlocks, io, mo,
      pointerIntent: false,
      pointerTimer: 0,
      composing: false,       // IME-Composition aktiv (CJK-Eingabe)
      expectedScroll: 0,      // prog-Scroll-Unterscheidung (Counter statt Zeit)
      vvTimer: 0,
    };

    const markPointer = () => {
      ctx.pointerIntent = true;
      clearTimeout(ctx.pointerTimer);
      ctx.pointerTimer = setTimeout(() => { ctx.pointerIntent = false; }, POINTER_GRACE_MS);
    };

    const onSelection = () => {
      if (this._focusState !== 'active') return;
      if (ctx.composing) return;  // IME: nicht recentern während CJK-Composition
      const isPointer = ctx.pointerIntent;
      ctx.pointerIntent = false;
      clearTimeout(ctx.pointerTimer);
      this._focusUpdateActive(!isPointer);
    };

    // Input-Event fängt Fälle, die selectionchange nicht abdeckt: undo/redo
    // ohne Caret-Move, Paste mit stabiler Caret-Position, Content-Rewrite
    // durch externe Module.
    const onInput = () => {
      if (this._focusState !== 'active') return;
      if (ctx.composing) return;
      this._focusUpdateActive(true);
    };

    const onCompositionStart = () => { ctx.composing = true; };
    const onCompositionEnd = () => {
      ctx.composing = false;
      if (this._focusState === 'active') this._focusUpdateActive(true);
    };

    const onScroll = () => {
      if (this._focusState !== 'active') return;
      if (ctx.expectedScroll > 0) { ctx.expectedScroll--; return; }
      this._focusUpdateActive(false);
    };

    // Editor verliert Fokus (z.B. Modal öffnet, Sidebar-Klick) → aktive
    // Markierung entfernen, damit nichts „hängen" bleibt.
    const onBlur = () => {
      if (this._focusState !== 'active') return;
      setActiveBlock(container, null);
    };
    // Editor bekommt Fokus zurück (z.B. nach Modal-Schließen) → Recenter
    // auf aktuelle Caret-Position.
    const onFocus = () => {
      if (this._focusState !== 'active') return;
      this._focusUpdateActive(true);
    };

    const onKey = (e) => {
      if (this._focusState !== 'active') return;
      if (e.key === 'Escape') {
        if (this.showSynonymMenu || this.showSynonymPicker) return;
        if (this.showFigurLookup) { this.closeFigurLookup(); return; }
        if (this.editSaving) return;   // während Save-Request kein Exit
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
    // Container nach oben schiebt). Debounced, damit KB-Öffnen-Storm
    // (scroll-events bei 60Hz) nicht permanent Recenter triggert.
    // Desktop: window.resize (Sidebar, DevTools, Orientation) feuert,
    // visualViewport evtl. nicht – beide Pfade abonnieren.
    const applyViewport = () => {
      const vv = window.visualViewport;
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      document.documentElement.style.setProperty('--focus-vh', h + 'px');
      document.documentElement.style.setProperty('--focus-vh-top', top + 'px');
      if (this._focusState === 'active') this._focusUpdateActive(true);
    };
    const syncViewport = () => {
      clearTimeout(ctx.vvTimer);
      ctx.vvTimer = setTimeout(applyViewport, VV_DEBOUNCE_MS);
    };
    // Initial: direkt anwenden (ohne Debounce), damit erster Frame korrekt.
    window.scrollTo(0, 0);
    applyViewport();

    // Patche scrollBy auf dem Container, damit jeder programmatische Scroll
    // den expectedScroll-Counter inkrementiert. Restore bei teardown.
    const origScrollBy = container.scrollBy.bind(container);
    container.scrollBy = function (opts) {
      ctx.expectedScroll++;
      return origScrollBy(opts);
    };
    ctx.origScrollBy = origScrollBy;

    document.addEventListener('selectionchange', onSelection, { signal });
    container.addEventListener('input', onInput, { signal });
    container.addEventListener('compositionstart', onCompositionStart, { signal });
    container.addEventListener('compositionend', onCompositionEnd, { signal });
    container.addEventListener('scroll', onScroll, { passive: true, signal });
    container.addEventListener('pointerdown', markPointer, { signal });
    container.addEventListener('pointerup', markPointer, { signal });
    container.addEventListener('blur', onBlur, { signal, capture: true });
    container.addEventListener('focus', onFocus, { signal, capture: true });
    window.addEventListener('keydown', onKey, { signal });
    window.addEventListener('resize', syncViewport, { signal });
    window.visualViewport?.addEventListener('resize', syncViewport, { signal });
    window.visualViewport?.addEventListener('scroll', syncViewport, { signal });

    this._focusListeners = ctx;
    this._focusVisibleBlocks = visibleBlocks;

    const editEl = document.querySelector('.page-content-view--editing');
    editEl?.focus();
  },

  _focusTeardown() {
    const ctx = this._focusListeners;
    if (ctx) {
      ctx.abort?.abort();
      ctx.io?.disconnect();
      ctx.mo?.disconnect();
      clearTimeout(ctx.pointerTimer);
      clearTimeout(ctx.vvTimer);
      if (ctx.container && ctx.origScrollBy) {
        // scrollBy-Patch zurücknehmen, falls Container weiterlebt.
        ctx.container.scrollBy = ctx.origScrollBy;
      }
      this._focusListeners = null;
    }
    this._focusVisibleBlocks = null;
    if (this._focusRaf) { cancelAnimationFrame(this._focusRaf); this._focusRaf = null; }
  },

  async exitFocusMode() {
    if (this._focusState !== 'active') return;
    this._focusState = 'exiting';
    const gen = ++this._focusGen;

    // Immer speichern beim Verlassen. UI bleibt optisch bis Save durch,
    // Event-Handler sind via _focusState='exiting' bereits stumm-geschaltet.
    // Bei Offline/Fehler bleibt editDirty true + Draft im LocalStorage →
    // User bleibt im Edit-Modus und kann manuell retten.
    if (this.editMode && this.editDirty && !this.editSaving) {
      try { await this.quickSave?.(); }
      catch (e) { reportError('exitFocusMode:save', e); }
    }
    // Race: jemand hat während await enter() gerufen → abbrechen.
    if (gen !== this._focusGen) return;

    this._focusTeardown();

    this.focusMode = false;
    document.body.classList.remove('focus-mode');
    document.documentElement.style.removeProperty('--focus-vh');
    document.documentElement.style.removeProperty('--focus-vh-top');

    document.querySelectorAll('#editor-card .focus-paragraph-active')
      .forEach(el => el.classList.remove('focus-paragraph-active'));

    // Nichts Ungespeichertes → zurück in die Ansicht (Save im Fokus impliziert
    // Ende der Edit-Session; unsaubere Exits behalten den Edit-Modus).
    if (this.editMode && !this.editDirty) {
      this._stopAutosave?.();
      this._uninstallOnlineRetry?.();
      this.editMode = false;
      this.editSaving = false;
      this.saveOffline = false;
      this.lastDraftSavedAt = null;
      this.closeSynonymMenu?.();
      this.closeSynonymPicker?.();
      this.closeFigurLookup?.();
      this.updatePageView?.();
    }

    this._focusState = 'idle';
  },

  _focusUpdateActive(scroll) {
    if (this._focusState !== 'active') return;
    if (this._focusRaf) cancelAnimationFrame(this._focusRaf);
    const gen = this._focusGen;
    this._focusRaf = requestAnimationFrame(() => {
      this._focusRaf = null;
      // try/catch um den gesamten RAF-Body: ein DOM-Edge-Case (z.B. Selection
      // über Shadow-Root, obskurer Range-Fehler) darf den Editor nicht
      // stillstellen. Fehler → loggen, nächster Event-Tick neu versuchen.
      try {
        // Falls wir mittlerweile exiting/idle sind → nichts tun.
        if (gen !== this._focusGen || this._focusState !== 'active') return;
        const ctx = this._focusListeners;
        if (!ctx) return;
        const container = ctx.container;
        if (!container) return;

        let block = null;
        const sel = document.getSelection();
        if (sel && sel.rangeCount > 0) {
          const anchor = sel.anchorNode;
          if (anchor && container.contains(anchor)) {
            block = findBlockFromNode(anchor, container);
          }
        }
        if (!block) block = findBlockAtViewportCenter(container, ctx.visibleBlocks);

        setActiveBlock(container, block);

        // Aktive Textmarkierung: nicht recentern, sonst springt der Viewport
        // während der User die Auswahl aufzieht oder an ihr arbeitet.
        const hasSelection = sel && sel.rangeCount > 0 && !sel.isCollapsed;
        if (scroll && block && !hasSelection) {
          // Cursor-Zeile bevorzugen (echter Typewriter-Scroll). Nur wenn keine
          // Caret-Rect ermittelbar ist (z.B. leerer Absatz, kein Fokus), auf
          // Block-Mitte zurückfallen.
          const targetRect = getCaretRect(container) || block.getBoundingClientRect();
          typewriterScroll(container, targetRect);
        }
      } catch (err) {
        reportError('updateActive', err);
      }
    });
  },
};
