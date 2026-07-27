// Sub-Komponenten-Methoden für Alpine.data('editorFocusCard').
//
// State-Machine: idle → entering → active → exiting → idle.
// Re-Entry während entering/exiting wird hart geblockt; ein Generation-Zähler
// (_focusGen) invalidiert asynchrone Nachzügler (RAFs, die nach einem schnellen
// exit noch feuern wollen).
//
// `this` zeigt auf Alpine.data('editorFocusCard'). Root-Zugriff läuft
// ausschliesslich über `editorHost()` (../shared/editor-host.js) — in der SPA
// der reaktive `window.__app`-Proxy, in einer fremden Schale ein injizierter Host.

import {
  BLOCK_TAGS, BLOCK_SEL,
  POINTER_GRACE_MS, POINTER_GRACE_TOUCH_MS,
  HAS_IO, HAS_MO,
  reportError,
} from './constants.js';
import {
  removeAutoAddedParagraph, jumpToTrailingParagraph, getScrollContainer,
  findBlockFromNode, findBlockAtViewportCenter,
  setActiveBlock, setNearBlocks,
} from './dom-blocks.js';
import { applySentenceHighlight } from './sentence.js';
import {
  cachedTypewriterThreshold, getCaretRect, typewriterScroll,
  caretWithinViewport, visibleViewportRect,
} from './typewriter.js';
import { makeCursorHide } from './cursor-hide.js';
import { makeViewportSync } from './viewport.js';
import { writeFocusSnapshot, clearFocusSnapshot } from './storage.js';
import { editorHost } from '../shared/editor-host.js';
import { installEditCounter } from '../shared/edit-counter.js';
import { bindInlineFormattingShortcuts } from '../shared/shortcuts.js';

export const focusCardMethods = {
  // Page-View-Direkteinstieg: Edit-Mode hochfahren (falls nicht bereits aktiv)
  // und dann in Fokus eintreten. Quelle: Focus-Button im Page-View-Header und
  // Hotkey Cmd/Ctrl+Shift+E aus dem Lesemodus. Schritt 5-Stand: Edit-Mode wird
  // weiterhin durchlaufen (Lock, Auto-Save, contenteditable-Mount), Focus-
  // Overlay setzt sich anschliessend drüber. Phase 4f-real: Focus-Cardroot
  // mountet eigenständig, ohne Normal-Editor-Detour.
  enterFocusFromPageview() {
    const app = editorHost();
    if (!app) return;
    if (!app.editMode) {
      app.startEdit?.();
      if (!app.editMode) return;
    }
    this.$nextTick(() => this.enterFocusMode());
  },

  enterFocusMode() {
    const app = editorHost();
    if (!app) return;
    if (this._focusState !== 'idle') return;
    if (!app.showEditorCard || !app.editMode) return;

    // Übergang edit-mode → focus-mode: offenen Debounce-Draft jetzt flushen,
    // damit bei Offline-Sessions kein getippter Inhalt verloren geht, falls
    // der User später im Focus-Mode abbricht oder Crashs auftreten.
    app._flushDraftSaveNow?.();

    this._focusState = 'entering';
    const gen = ++this._focusGen;

    app.focusActive = true;
    document.body.classList.add('focus-mode');
    const editorCard = document.getElementById('editor-card');
    if (editorCard) editorCard.classList.add('focus-host');
    const focusEl = document.querySelector('.focus-editor');
    if (focusEl) {
      focusEl.classList.remove('focus-mode--paragraph', 'focus-mode--sentence', 'focus-mode--window-3', 'focus-mode--typewriter-only');
      focusEl.classList.add('focus-mode--' + (app.focusGranularity || 'paragraph'));
      // `is-active` synchron setzen, damit `getActiveEditorContainer` im
      // folgenden $nextTick den Focus-Container findet — Alpine's
      // `:class="{'is-active': focusActive}"` flushed erst nach unserem
      // $nextTick und liesse _focusInstall sonst auf den Normal-Container
      // greifen (alle Listener am falschen Element → typewriter/highlight/
      // counter/cursor-hide tot).
      focusEl.classList.add('is-active');
    }

    this.$nextTick(() => {
      // Wenn in der Zwischenzeit jemand exit() gerufen oder schneller
      // re-entered hat → abbrechen.
      if (gen !== this._focusGen || this._focusState !== 'entering') return;
      try {
        // DOM-Roundtrip Normal → Focus: Inhalt aus dem Normal-Container in
        // den Focus-Container klonen (kein innerHTML — XSS-Trust kommt vom
        // eigenen contenteditable; cloneNode bleibt strukturidentisch ohne
        // Re-Parsing). Container-Klassen sind entkoppelt: Normal-Editor nutzt
        // `.page-content-view--editing`, Focus-Editor `.focus-editor__content`.
        const normalC = document.querySelector('#editor-card .page-content-view--editing');
        const focusC = document.querySelector('.focus-editor .focus-editor__content');
        if (normalC && focusC && focusC !== normalC) {
          const clones = Array.from(normalC.childNodes).map(n => n.cloneNode(true));
          focusC.replaceChildren(...clones);
        }
        // Live-Counter ist Container-gebunden — beim Mode-Wechsel teardown
        // und am neuen aktiven Container (Smart-Switch via shared/active-
        // editor.js) neu installieren. Andernfalls misst der Counter den
        // alten (jetzt versteckten) Normal-Container.
        app._editCounterCtx?.teardown?.();
        installEditCounter(app);

        this._focusInstall();
        this._focusState = 'active';
        this._focusUpdateActive(true);
        writeFocusSnapshot(app.currentPage?.id);
      } catch (err) {
        reportError('enterFocusMode', err);
        this._focusTeardown();
        clearFocusSnapshot();
        app.focusActive = false;
        document.body.classList.remove('focus-mode');
        document.getElementById('editor-card')?.classList.remove('focus-host');
        document.querySelector('.focus-editor')?.classList.remove('is-active', 'focus-mode--paragraph', 'focus-mode--sentence', 'focus-mode--window-3', 'focus-mode--typewriter-only');
        this._focusState = 'idle';
      }
    });
  },

  _focusInstall() {
    const app = editorHost();
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
      // Short-circuit-Cache für _focusUpdateActive: bleibt der aktive Block
      // gleich (häufigster Fall beim Tippen), sparen wir setActiveBlock /
      // setNearBlocks / sentence-Highlight ein. _lastGranularity invalidiert bei
      // Live-Mode-Switch.
      _lastBlock: null,
      _lastGranularity: null,
      _twCache: { block: null, value: null },  // cachedTypewriterThreshold
      _lastViewportH: null,   // letzte sichtbare Viewport-Höhe (Tastatur-Erkennung)
    };

    // Touch bekommt eine längere Karenz als Maus/Stift: der Fingertipp ist auf
    // Mobile die einzige Art, den Caret zu setzen, und das `selectionchange`
    // kommt dort spät.
    const markPointer = (e) => {
      ctx.pointerIntent = true;
      clearTimeout(ctx.pointerTimer);
      const grace = e?.pointerType === 'touch' ? POINTER_GRACE_TOUCH_MS : POINTER_GRACE_MS;
      ctx.pointerTimer = setTimeout(() => { ctx.pointerIntent = false; }, grace);
    };

    const onSelection = () => {
      if (this._focusState !== 'active') return;
      const isPointer = ctx.pointerIntent;
      ctx.pointerIntent = false;
      clearTimeout(ctx.pointerTimer);
      this._focusUpdateActive(!isPointer, ctx.composing ? { imeSafe: true } : undefined);
    };

    const { showCursor } = makeCursorHide({
      ctx, isActive: () => this._focusState === 'active',
    });

    // Input-Event fängt Fälle, die selectionchange nicht abdeckt: undo/redo
    // ohne Caret-Move, Paste mit stabiler Caret-Position, Content-Rewrite
    // durch externe Module. Wort-/Zeichen-Counter läuft via installEditCounter
    // (in edit.js gestartet, Voraussetzung für Fokus) — kein zweiter Listener
    // hier nötig.
    const onInput = (e) => {
      if (this._focusState !== 'active') return;
      // Composition läuft: kein Markup anfassen (Kandidatenfenster/Composition
      // darf nicht gestört werden), aber der Typewriter bleibt als Notnagel
      // scharf — Android-Soft-Keyboards halten auch für gewöhnliche lateinische
      // Wörter eine Composition offen, teils über ganze Sätze. Ein harter Block
      // liesse die Schreibzeile dort minutenlang nach unten weglaufen.
      if (ctx.composing) { this._focusUpdateActive(true, { imeSafe: true }); return; }
      // Paragraph-/Zeilen-Split: aktiven Block SYNCHRON neu setzen, statt erst
      // im RAF einen Frame später. Chromium kopiert beim Split die
      // .focus-paragraph-active-Klasse auf beide <p>; würde der RAF erst im
      // nächsten Frame aufräumen, leuchteten kurz zwei Absätze. Das frühere
      // Clearen im `beforeinput` vermied zwar den Doppel-, erzeugte aber einen
      // Dim-Flash (für einen Frame ist NICHTS aktiv → ganzer Text snappt auf
      // opacity 0.35 und zurück). `input` feuert synchron im selben Task VOR
      // dem Paint — die korrekte Markierung hier setzen rendert keinen
      // Zwischenzustand, also kein „Ruckeln". RAF reconciliiert + scrollt.
      if (e?.inputType === 'insertParagraph' || e?.inputType === 'insertLineBreak') {
        const sel = document.getSelection();
        const anchor = sel && sel.rangeCount > 0 ? sel.anchorNode : null;
        const block = anchor && container.contains(anchor)
          ? findBlockFromNode(anchor, container) : null;
        const granularity = editorHost()?.focusGranularity || 'paragraph';
        if (granularity === 'typewriter-only') {
          setActiveBlock(container, null);
          setNearBlocks(container, null);
        } else {
          setActiveBlock(container, block);
          setNearBlocks(container, granularity === 'window-3' ? block : null);
        }
        ctx._lastBlock = block;
      }
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
      // Manueller Scroll: Spotlight auf den Absatz in der Viewport-Mitte
      // setzen (preferCenter), nicht auf den Caret. scroll=false → kein
      // programmatischer Typewriter-Scroll, der gegen den User-Scroll kämpft.
      this._focusUpdateActive(false, { preferCenter: true });
    };

    // Editor verliert Fokus (z.B. Modal öffnet, Sidebar-Klick) → aktive
    // Markierung entfernen, damit nichts „hängen" bleibt.
    const onBlur = () => {
      if (this._focusState !== 'active') return;
      setActiveBlock(container, null);
      ctx._lastBlock = null;
    };
    // Editor bekommt Fokus zurück (z.B. nach Modal-Schliessen) → Recenter
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
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyE') {
        e.preventDefault();
        if (this._focusState === 'active') this.exitFocusMode();
        else if (this._focusState === 'idle') this.enterFocusMode();
      } else if ((e.key === 'l' || e.key === 'L') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        // Vim/emacs-Konvention: Ctrl+L recentert Cursor-Zeile auf den Anker.
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

    // Klick ins Padding (oberhalb/unterhalb/neben der Textspalte) soll Caret
    // nicht an Anfang/Ende der Seite werfen. Wheel-Scroll braucht aber
    // pointer-events:auto am Container — preventDefault nur, wenn das Target
    // wirklich der Container selbst ist (nicht ein Absatz darin).
    const onPaddingMousedown = (e) => {
      if (e.target === container) e.preventDefault();
    };

    // Mobile-Tastatur: visualViewport schrumpft UND kann scrollen
    // (Android Chrome: offsetTop wird non-zero, wenn die KB den fixed
    // Container nach oben schiebt). Debounced, damit KB-Öffnen-Storm
    // (scroll-events bei 60Hz) nicht permanent Recenter triggert.
    // Desktop: window.resize (Sidebar, DevTools, Orientation) feuert,
    // visualViewport evtl. nicht – beide Pfade abonnieren.
    const { applyViewport, syncViewport } = makeViewportSync({
      ctx,
      container,
      isActive: () => this._focusState === 'active',
      updateActive: (scroll) => this._focusUpdateActive(scroll),
    });
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
    container.addEventListener('mousedown', onPaddingMousedown, { signal });
    container.addEventListener('blur', onBlur, { signal, capture: true });
    container.addEventListener('focus', onFocus, { signal, capture: true });
    window.addEventListener('keydown', onKey, { signal });
    // Inline-Format-Whitelist im Focus: ausschliesslich Bold/Italic/Underline
    // per Cmd/Ctrl+B/I/U. Hängt am contenteditable (Container), nicht am
    // Window — sonst feuern Shortcuts auch ausserhalb des Focus-Editors.
    bindInlineFormattingShortcuts(container, {
      allowedCommands: ['bold', 'italic', 'underline'],
      signal,
      onCommand: () => { app?._markEditDirty?.(); },
    });
    window.addEventListener('pointermove', onPointerMove, { signal, passive: true });
    window.addEventListener('resize', syncViewport, { signal });
    window.visualViewport?.addEventListener('resize', syncViewport, { signal });
    window.visualViewport?.addEventListener('scroll', syncViewport, { signal });

    this._focusListeners = ctx;
    this._focusVisibleBlocks = visibleBlocks;

    showCursor();

    // container ist via shared/active-editor.js: bei aktiver Focus-Karte der
    // Focus-Cardroot, sonst der Normal-Editor-Container.
    container?.focus?.({ preventScroll: true });
    this._focusAutoAddedP = jumpToTrailingParagraph(container);
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
      this._focusListeners = null;
    }
    this._focusVisibleBlocks = null;
    if (this._focusRaf) { cancelAnimationFrame(this._focusRaf); this._focusRaf = null; }
  },

  async exitFocusMode() {
    const app = editorHost();
    if (!app) return;
    if (this._focusState !== 'active') return;
    this._focusState = 'exiting';
    const gen = ++this._focusGen;

    // Auto-Slot vom Focus-Entry abräumen, falls User nichts reingeschrieben
    // hat. Sonst würde der leere `<p>` als „Änderung" gespeichert werden und
    // bei jedem Focus-Open eine BookStack-Revision erzeugen.
    removeAutoAddedParagraph(this._focusAutoAddedP);
    this._focusAutoAddedP = null;

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
    clearFocusSnapshot();

    // DOM-Roundtrip Focus → Normal: aktuellen Focus-Inhalt zurück in den
    // Normal-Container klonen, bevor focusActive=false greift und Alpine den
    // Focus-Cardroot via x-show ausblendet. Smart-Switch springt mit
    // `focusActive=false` automatisch zurück auf den Normal-Container.
    const focusC = document.querySelector('.focus-editor.is-active .focus-editor__content');
    const normalC = document.querySelector('#editor-card .page-editor-wrap .page-content-view--editing');
    if (focusC && normalC && focusC !== normalC) {
      const clones = Array.from(focusC.childNodes).map(n => n.cloneNode(true));
      normalC.replaceChildren(...clones);
    }
    // Counter wechselt zurück auf den Normal-Container.
    app._editCounterCtx?.teardown?.();

    app.focusActive = false;
    document.body.classList.remove('focus-mode');
    document.getElementById('editor-card')?.classList.remove('focus-host');
    const focusElExit = document.querySelector('.focus-editor');
    if (focusElExit) {
      focusElExit.classList.remove('is-active', 'focus-mode--paragraph', 'focus-mode--sentence', 'focus-mode--window-3', 'focus-mode--typewriter-only');
      focusElExit.classList.remove('focus-cursor-hidden');
    }
    document.documentElement.style.removeProperty('--focus-vh');
    document.documentElement.style.removeProperty('--focus-vh-top');

    document.querySelectorAll('.focus-paragraph-active, .focus-paragraph-near')
      .forEach(el => {
        el.classList.remove('focus-paragraph-active');
        el.classList.remove('focus-paragraph-near');
        if (el.classList.length === 0) el.removeAttribute('class');
      });
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete('focus-sentence-dim');
    }

    // Nichts Ungespeichertes → zurück in die Ansicht (Save im Fokus impliziert
    // Ende der Edit-Session; unsaubere Exits behalten den Edit-Modus).
    if (app.editMode && !app.editDirty) {
      app._stopAutosave?.();
      app._uninstallOnlineRetry?.();
      app._editCounterCtx?.teardown?.();
      app.editMode = false;
      app.editSaving = false;
      app.saveOffline = false;
      app.lastDraftSavedAt = null;
      app.closeSynonymMenu?.();
      app.closeSynonymPicker?.();
      app.closeFigurLookup?.();
    } else if (app.editMode) {
      // Unsauberer Exit (Save fehlgeschlagen, editDirty bleibt) — User landet
      // wieder im Normal-Editor. Counter neu am Normal-Container installieren,
      // damit Live-Anzeige + Tagesdelta weiterzählen.
      installEditCounter(app);
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

  _focusUpdateActive(scroll, opts = {}) {
    if (this._focusState !== 'active') return;
    if (this._focusRaf) cancelAnimationFrame(this._focusRaf);
    const preferCenter = opts.preferCenter === true;
    // IME-Composition aktiv: Markup einfrieren, Typewriter nur als Notnagel.
    const imeSafe = opts.imeSafe === true;
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

        // Block-Quelle: normalerweise Caret-Anchor (Spotlight folgt dem
        // Cursor beim Tippen). `preferCenter` (manueller Scroll) ignoriert den
        // Caret und nimmt den Absatz in der Viewport-Mitte — beim Lese-/Scroll-
        // Durchlauf wandert die Hervorhebung mit dem Sichtfeld, nicht mit dem
        // (unsichtbaren) Cursor im alten Absatz.
        let block = null;
        const sel = document.getSelection();
        if (!preferCenter && sel && sel.rangeCount > 0) {
          const anchor = sel.anchorNode;
          if (anchor && container.contains(anchor)) {
            block = findBlockFromNode(anchor, container);
          }
        }
        if (!block) block = findBlockAtViewportCenter(container, ctx.visibleBlocks);

        const granularity = editorHost()?.focusGranularity || 'paragraph';

        // Defensive gegen den transienten null-Tick: Caret sitzt nach Merge/
        // Voll-Löschen kurz auf dem Container (findBlockFromNode=null) UND der
        // Viewport-Center-Fallback findet (noch) nichts. Ohne Schutz killte
        // setActiveBlock(null) die Hervorhebung („alles dimmt kurz weg"). Vorigen
        // Block halten, solange er noch im Container hängt; nächster Tick fixt's.
        // onBlur setzt ctx._lastBlock=null → der absichtliche Blur-Clear bleibt.
        if (!block && granularity !== 'typewriter-only'
            && ctx._lastBlock && container.contains(ctx._lastBlock)) {
          block = ctx._lastBlock;
        }

        const blockChanged = block !== ctx._lastBlock;
        const granularityChanged = granularity !== ctx._lastGranularity;

        // Während einer Composition wird NICHTS am DOM angefasst — weder
        // Block-Klassen noch Satz-Highlight. Beides würde das Kandidatenfenster
        // versetzen bzw. auf Composition-empfindlichen IMEs die Eingabe
        // abbrechen. `_lastBlock`/`_lastGranularity` bleiben absichtlich stehen,
        // damit `compositionend` als Blockwechsel durchschlägt und einmal sauber
        // reconciliiert. Der Scroll-Teil unten läuft weiter (Notnagel).
        if (!imeSafe) {
          // Block-Markierungen jeden Tick neu setzen — beide Setter sind idempotent
          // (mutieren nur, wenn sich active-/near-Set wirklich ändert), also beim
          // Tippen im selben Absatz mutationsfrei. Der unbedingte Aufruf bleibt die
          // Defense gegen Ghost-Klassen (Chromium-Split-Bug, undo/redo, Paste): er
          // räumt jede fremde `.focus-paragraph-active` im nächsten Tick ab.
          if (granularity === 'typewriter-only') {
            setActiveBlock(container, null);
            setNearBlocks(container, null);
          } else {
            setActiveBlock(container, block);
            setNearBlocks(container, granularity === 'window-3' ? block : null);
          }

          // Sentence-Highlight ist der teure Pfad (Range-Iteration über Text-
          // knoten). Nur neu rechnen bei Block-/Granularitätswechsel oder in
          // Sentence-Mode (Caret kann Satzgrenze im selben Block überqueren).
          if (blockChanged || granularityChanged || granularity === 'sentence') {
            if (granularity === 'sentence') {
              applySentenceHighlight(block, sel);
            } else if (typeof CSS !== 'undefined' && CSS.highlights) {
              CSS.highlights.delete('focus-sentence-dim');
            }
          }
          ctx._lastBlock = block;
          ctx._lastGranularity = granularity;
        }

        // Aktive Textmarkierung: nicht recentern, sonst springt der Viewport
        // während der User die Auswahl aufzieht oder an ihr arbeitet.
        const hasSelection = sel && sel.rangeCount > 0 && !sel.isCollapsed;
        if (scroll && block && !hasSelection) {
          // Ausschliesslich Caret-Rect als Ziel — Block-BBox-Fallback wäre
          // schädlich: bei langen Absätzen mit Soft-Wrap / shift-enter-Brüchen
          // bewegt sich Block-Mitte nicht mit dem Caret. `getCaretRect` hat eine
          // eigene Probe-Range-Expansion für Wrap-Bruch/nach-<br>; liefert sie
          // null (leerer Absatz), bleibt der Scroll aus — nächster Input fixt's.
          const targetRect = getCaretRect(container);
          if (targetRect) {
            const threshold = cachedTypewriterThreshold(block, ctx._twCache);
            // Während einer Composition nur eingreifen, wenn die Caret-Zeile den
            // sichtbaren Bereich (samt einer Zeile Sicherheitsband) verlassen hat.
            // Zeilen-Jitter und ein einzelner Umbruch bleiben unbeantwortet, damit
            // das IME-Kandidatenfenster stehen bleibt; läuft die Zeile aber unter
            // die Tastatur, wird sie geholt.
            const imeQuiet = imeSafe
              && caretWithinViewport(targetRect, visibleViewportRect(), threshold * 2);
            if (!imeQuiet) {
              // Anker-Position des Typewriter-Scrolls (Mitte vs. oberes Drittel).
              // Host-/Config-gesteuert; nicht gesetzt → Default 0.5 (Mitte).
              const anchorRatio = editorHost()?.typewriterAnchor;
              typewriterScroll(container, targetRect, ctx, threshold, anchorRatio);
            }
          }
        }
      } catch (err) {
        reportError('updateActive', err);
      }
    });
  },
};
