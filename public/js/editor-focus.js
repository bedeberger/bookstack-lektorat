// Vollbild-Fokusmodus mit Absatz-Hervorhebung + Typewriter-Scroll.
// Nur im Bearbeitungsmodus aktivierbar.
//
// State-Machine: idle → entering → active → exiting → idle.
// Re-Entry während entering/exiting wird hart geblockt; eine Generation-
// Zähler-Variable invalidiert asynchrone Nachzügler (z.B. RAFs, die nach
// einem schnellen exit noch feuern wollen).
//
// Zweigeteilt:
//   - `focusMethods`: Root-Trampoline (toggleFocusMode, startFocusEdit,
//     enterFocusMode, exitFocusMode, handleFocusHotkey) — dispatchen Events
//     an die Sub. Root hält `focusMode` als sichtbare Flag.
//   - `focusCardMethods`: State-Machine + DOM-Handler in
//     Alpine.data('editorFocusCard').

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
const CURSOR_HIDE_MS = 2000;
const COUNTER_DEBOUNCE_MS = 220;

// Tagesbaseline für „neue Wörter/Zeichen heute". Pro pageId genau ein Snapshot
// pro Tag — bei der ersten Messung wird der aktuelle Stand als Vergleichswert
// festgehalten, jede weitere Messung am selben Tag liefert das Delta dazu.
// Stale Einträge (andere Tage) werden lazy bei jedem Read geprunt, damit der
// Storage nicht über Wochen durch alte Seiten/Tage anwächst.
const DAILY_BASELINE_KEY = 'focus.dailyBaseline';

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-'
       + String(d.getMonth() + 1).padStart(2, '0') + '-'
       + String(d.getDate()).padStart(2, '0');
}

function readDailyBaselines() {
  try {
    const raw = localStorage.getItem(DAILY_BASELINE_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}

function writeDailyBaselines(obj) {
  try { localStorage.setItem(DAILY_BASELINE_KEY, JSON.stringify(obj)); }
  catch { /* quota / private mode — egal, Delta bleibt 0 */ }
}

// Liefert {dw, dc} (delta words/chars) für die heutige Sitzung der Seite.
// Schreibt bei Bedarf einen frischen Baseline-Eintrag und prunt stale.
function dailyDelta(pageId, words, chars) {
  if (pageId == null) return { dw: 0, dc: 0 };
  const today = todayKey();
  const all = readDailyBaselines();
  let dirty = false;
  for (const id of Object.keys(all)) {
    if (all[id]?.date !== today) { delete all[id]; dirty = true; }
  }
  let entry = all[pageId];
  if (!entry || entry.date !== today) {
    entry = { date: today, words, chars };
    all[pageId] = entry;
    dirty = true;
  }
  if (dirty) writeDailyBaselines(all);
  return { dw: words - entry.words, dc: chars - entry.chars };
}

// `±0` für klare Optik bei Null statt nacktem `0`. Unicode-Minus für sauberen
// Tabulator-Look (gleiche Glyph-Breite wie Plus); ASCII-Hyphen ist schmaler.
function fmtSigned(n) {
  if (n > 0) return '+' + n;
  if (n < 0) return '−' + Math.abs(n);
  return '±0';
}

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

// Gibt den *äussersten* Block-Ancestor unterhalb von `root` zurück. Grund:
// Bei verschachtelten Blöcken (z.B. `<blockquote><p>…</p></blockquote>` oder
// `<li><p>…</p></li>`) würde ein innermost-Match nur den inneren `<p>` aktiv
// markieren. Der äussere Wrapper (`<blockquote>`/`<li>`) bekäme weiter
// opacity:0.5 — und da opacity im Stacking-Context multipliziert wird, wäre
// der vermeintlich aktive `<p>` trotzdem halb-gedimmt. Outermost-Wahl löst
// das auf: der sichtbare Container-Block wird aktiv, CSS dimmt ihn nicht,
// Kinder erben volle opacity.
export function findBlockFromNode(node, root, blockTags = BLOCK_TAGS) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  let outermost = null;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && blockTags.has(cur.tagName)) outermost = cur;
    cur = cur.parentNode;
  }
  return outermost;
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

// Threshold dynamisch aus computed line-height ableiten. Im Fokusmodus ist
// font-size 1.45rem, line-height 1.85 → ~42px. Statisches 16px scrollte schon
// bei subpixel-Jitter; halbe Zeilenhöhe ist die natürliche Grenze für „echter
// Zeilenwechsel". Fallback 16, falls computed style nicht greifbar.
export function dynamicTypewriterThreshold(block, fallback = TYPEWRITER_THRESHOLD_PX) {
  if (!block || typeof window === 'undefined' || !window.getComputedStyle) return fallback;
  try {
    const lh = parseFloat(window.getComputedStyle(block).lineHeight);
    if (Number.isFinite(lh) && lh > 0) return Math.max(fallback, lh * 0.5);
  } catch { /* ignore */ }
  return fallback;
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
// Mitte sitzt? Unter Schwelle → no-op. Schwelle ist grob eine Zeilenhöhe
// (~16px), damit Tippen innerhalb derselben Textzeile (Caret-Rect-Jitter,
// subpixel-Shifts von getBoundingClientRect) keinen Mini-Scroll auslöst und
// der Editor „ruhig" wirkt. Echter Zeilenwechsel / Enter verursacht einen
// grösseren Delta und scrollt.
export const TYPEWRITER_THRESHOLD_PX = 16;
export function computeTypewriterDelta(containerRect, targetRect, threshold = TYPEWRITER_THRESHOLD_PX) {
  if (!containerRect || !targetRect) return 0;
  const targetCenter = targetRect.top + targetRect.height / 2;
  const containerCenter = containerRect.top + containerRect.height / 2;
  const delta = targetCenter - containerCenter;
  return Math.abs(delta) < threshold ? 0 : delta;
}

function typewriterScroll(container, targetRect, ctx, threshold = TYPEWRITER_THRESHOLD_PX) {
  if (!container || !targetRect) return 0;
  const delta = computeTypewriterDelta(container.getBoundingClientRect(), targetRect, threshold);
  if (delta === 0) return 0;
  // Programmatischen Scroll vorab im Counter ankündigen, damit onScroll uns
  // nicht für eine User-Interaktion hält und unnötig recentert.
  if (ctx) ctx.expectedScroll++;
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

// ── Root-Trampoline ─────────────────────────────────────────────────────────
// Dispatcht Events an Alpine.data('editorFocusCard'). Root hält `focusMode`
// als sichtbare Flag (CSS, body-Class, Template-Checks) und die Live-Counter
// `focusCountWords` / `focusCountChars`, die der Header im Fokus-Modus zeigt.
export const focusMethods = {
  focusMode: false,
  focusCountWords: 0,
  focusCountChars: 0,
  focusCountWordsDelta: '±0',
  focusCountCharsDelta: '±0',

  toggleFocusMode() {
    window.dispatchEvent(new CustomEvent('editor:focus:toggle'));
  },

  startFocusEdit() {
    // Root wechselt in Edit-Mode (falls nicht bereits), Sub tritt dann in Fokus ein.
    window.dispatchEvent(new CustomEvent('editor:focus:start-edit'));
  },

  enterFocusMode() {
    window.dispatchEvent(new CustomEvent('editor:focus:enter'));
  },

  exitFocusMode() {
    window.dispatchEvent(new CustomEvent('editor:focus:exit'));
  },

  // Global F11-Hotkey. Läuft auf dem Body-Listener (siehe index.html), damit
  // F11 den Fokusmodus auch aus dem Lesemodus heraus einschaltet.
  handleFocusHotkey(event) {
    if (event.key !== 'F11') return;
    if (!this.showEditorCard) return;
    event.preventDefault();
    if (this.focusMode) {
      window.dispatchEvent(new CustomEvent('editor:focus:exit'));
    } else if (this.editMode) {
      window.dispatchEvent(new CustomEvent('editor:focus:enter'));
    } else {
      window.dispatchEvent(new CustomEvent('editor:focus:start-edit'));
    }
  },
};

// ── Sub-Komponenten-Methoden ────────────────────────────────────────────────
// `this` zeigt auf Alpine.data('editorFocusCard'). `_app` ist der reaktive
// Root-Proxy (window.__app).
export const focusCardMethods = {
  toggleFocusMode() {
    if (this._focusState === 'active') this.exitFocusMode();
    else if (this._focusState === 'idle') this.enterFocusMode();
    // entering/exiting → ignorieren (kein Double-Trigger).
  },

  startFocusEdit() {
    const app = window.__app;
    if (!app) return;
    if (!app.editMode) {
      app.startEdit?.();
      if (!app.editMode) return;
    }
    this.$nextTick(() => this.enterFocusMode());
  },

  enterFocusMode() {
    const app = window.__app;
    if (!app) return;
    if (this._focusState !== 'idle') return;
    if (!app.showEditorCard || !app.editMode) return;

    // Übergang edit-mode → focus-mode: offenen Debounce-Draft jetzt flushen,
    // damit bei Offline-Sessions kein getippter Inhalt verloren geht, falls
    // der User später im Focus-Mode abbricht oder Crashs auftreten.
    app._flushDraftSaveNow?.();

    this._focusState = 'entering';
    const gen = ++this._focusGen;

    app.focusMode = true;
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
        app.focusMode = false;
        document.body.classList.remove('focus-mode');
        this._focusState = 'idle';
      }
    });
  },

  _focusInstall() {
    const app = window.__app;
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
      cursorTimer: 0,
      counterTimer: 0,
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

    // Auto-Hide-Cursor: Maus 2s ruhig → Cursor unsichtbar. Nächste Bewegung
    // bringt ihn zurück. Nur Klassentoggle, kein Style-Reset.
    const showCursor = () => {
      document.body.classList.remove('focus-cursor-hidden');
      clearTimeout(ctx.cursorTimer);
      ctx.cursorTimer = setTimeout(() => {
        if (this._focusState === 'active') {
          document.body.classList.add('focus-cursor-hidden');
        }
      }, CURSOR_HIDE_MS);
    };

    // Wort-/Zeichen-Counter: textContent reicht (DOM-Reflow vermeiden, kein
    // innerText). Whitespace-Split für Wörter, Filter gegen Leerstrings.
    // Zusätzlich Delta gegen die Tages-Baseline, damit der Header anzeigt,
    // wieviel der User heute auf dieser Seite ergänzt hat.
    const updateCounter = () => {
      if (!app) return;
      const txt = container.textContent || '';
      const chars = txt.length;
      const words = txt.trim() ? txt.trim().split(/\s+/).length : 0;
      app.focusCountChars = chars;
      app.focusCountWords = words;
      const { dw, dc } = dailyDelta(app.currentPage?.id, words, chars);
      app.focusCountWordsDelta = fmtSigned(dw);
      app.focusCountCharsDelta = fmtSigned(dc);
    };
    const scheduleCounter = () => {
      clearTimeout(ctx.counterTimer);
      ctx.counterTimer = setTimeout(() => {
        if (this._focusState === 'active') updateCounter();
      }, COUNTER_DEBOUNCE_MS);
    };

    // Input-Event fängt Fälle, die selectionchange nicht abdeckt: undo/redo
    // ohne Caret-Move, Paste mit stabiler Caret-Position, Content-Rewrite
    // durch externe Module.
    const onInput = () => {
      if (this._focusState !== 'active') return;
      scheduleCounter();
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
        if (app?._synonymMenuOpen || app?._synonymPickerOpen) return;
        if (app?._figurLookupOpen) { app.closeFigurLookup?.(); return; }
        if (app?.editSaving) return;   // während Save-Request kein Exit
        e.preventDefault();
        if (app?.editMode && app?.editDirty && app?.cancelEdit) {
          app.cancelEdit();
        } else {
          this.exitFocusMode();
        }
      } else if (e.key === 'F11') {
        e.preventDefault();
        this.toggleFocusMode();
      } else if ((e.key === 'l' || e.key === 'L') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        // Vim/emacs-Konvention: Ctrl+L recentert Cursor-Zeile in Viewport-Mitte.
        // Browser-Default (Adress-Leiste fokussieren) wird im Fokus-Modus
        // unterdrückt — User wollte ohnehin im Editor bleiben.
        e.preventDefault();
        this._focusUpdateActive(true);
      }
    };

    const onPointerMove = () => {
      if (this._focusState !== 'active') return;
      showCursor();
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
      // Nur den aktiven Absatz re-validieren, NICHT recentern. Ein Recenter
      // bei jedem Viewport-Tick würde den Editor bei jedem Mobile-KB-Frame
      // oder Desktop-Resize springen lassen („flattern"). Scrollt der User
      // selbst, greifen onScroll/onSelection ohnehin.
      if (this._focusState === 'active') this._focusUpdateActive(false);
    };
    const syncViewport = () => {
      clearTimeout(ctx.vvTimer);
      ctx.vvTimer = setTimeout(applyViewport, VV_DEBOUNCE_MS);
    };
    // Initial: direkt anwenden (ohne Debounce), damit erster Frame korrekt.
    window.scrollTo(0, 0);
    applyViewport();

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
    window.addEventListener('pointermove', onPointerMove, { signal, passive: true });
    window.addEventListener('resize', syncViewport, { signal });
    window.visualViewport?.addEventListener('resize', syncViewport, { signal });
    window.visualViewport?.addEventListener('scroll', syncViewport, { signal });

    this._focusListeners = ctx;
    this._focusVisibleBlocks = visibleBlocks;

    updateCounter();
    showCursor();

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
      clearTimeout(ctx.cursorTimer);
      clearTimeout(ctx.counterTimer);
      this._focusListeners = null;
    }
    this._focusVisibleBlocks = null;
    if (this._focusRaf) { cancelAnimationFrame(this._focusRaf); this._focusRaf = null; }
  },

  async exitFocusMode() {
    const app = window.__app;
    if (!app) return;
    if (this._focusState !== 'active') return;
    this._focusState = 'exiting';
    const gen = ++this._focusGen;

    // Immer speichern beim Verlassen. UI bleibt optisch bis Save durch,
    // Event-Handler sind via _focusState='exiting' bereits stumm-geschaltet.
    // Bei Offline/Fehler bleibt editDirty true + Draft im LocalStorage →
    // User bleibt im Edit-Modus und kann manuell retten.
    if (app.editMode && app.editDirty && !app.editSaving) {
      try { await app.quickSave?.(); }
      catch (e) { reportError('exitFocusMode:save', e); }
    }
    // Race: jemand hat während await enter() gerufen → abbrechen.
    if (gen !== this._focusGen) return;

    this._focusTeardown();

    app.focusMode = false;
    document.body.classList.remove('focus-mode');
    document.body.classList.remove('focus-cursor-hidden');
    document.documentElement.style.removeProperty('--focus-vh');
    document.documentElement.style.removeProperty('--focus-vh-top');

    document.querySelectorAll('#editor-card .focus-paragraph-active')
      .forEach(el => el.classList.remove('focus-paragraph-active'));

    // Nichts Ungespeichertes → zurück in die Ansicht (Save im Fokus impliziert
    // Ende der Edit-Session; unsaubere Exits behalten den Edit-Modus).
    if (app.editMode && !app.editDirty) {
      app._stopAutosave?.();
      app._uninstallOnlineRetry?.();
      app.editMode = false;
      app.editSaving = false;
      app.saveOffline = false;
      app.lastDraftSavedAt = null;
      app.closeSynonymMenu?.();
      app.closeSynonymPicker?.();
      app.closeFigurLookup?.();
    }

    // View-Mode + Kennzahlen (Wörter/Zeichen/Token) immer auffrischen, egal
    // ob Save erfolgte, no-op war oder fehlschlug. Garantie: beim Verlassen
    // des Fokusmodus reflektieren View-Mode-HTML und tokEsts-Badges den
    // aktuellen originalHtml. Idempotent zu den Save-Pfaden, die diese
    // Calls ohnehin bereits feuern.
    if (app.currentPage && app.originalHtml != null) {
      app._syncPageStatsAfterSave?.(app.currentPage, app.originalHtml);
    }
    app.updatePageView?.();

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
          const threshold = dynamicTypewriterThreshold(block);
          typewriterScroll(container, targetRect, ctx, threshold);
        }
      } catch (err) {
        reportError('updateActive', err);
      }
    });
  },
};
