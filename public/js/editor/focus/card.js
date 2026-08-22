// Sub-Komponenten-Methoden für Alpine.data('editorFocusCard').
//
// State-Machine: idle → entering → active → exiting → idle.
// Re-Entry während entering/exiting wird hart geblockt; ein Generation-Zähler
// (_focusGen) invalidiert asynchrone Nachzügler (RAFs, die nach einem schnellen
// exit noch feuern wollen).
//
// Hier wohnt nur der Lifecycle. Die Nachbarn tragen die Einzelschritte:
//   listeners.js — Listener-/Observer-Setup (wann gerechnet wird)
//   recenter.js  — die Recenter-Schritte (was gerechnet wird)
//   chrome.js    — body-/Cardroot-Klassen, Granularität, Anker-Variable
//   mirror.js    — DOM-Roundtrip Normal ↔ Focus
//
// `this` zeigt auf Alpine.data('editorFocusCard'). Root-Zugriff läuft
// ausschliesslich über `editorHost()` (../shared/editor-host.js) — in der SPA
// der reaktive `window.__app`-Proxy, in einer fremden Schale ein injizierter Host.

import { reportError } from './constants.js';
import {
  removeAutoAddedParagraph, jumpToTrailingParagraph, getScrollContainer,
  clearAllFocusMarks,
} from './dom-blocks.js';
import {
  resolveActiveBlock, applyBlockMarks, syncSentenceMarks, repairBlockMarks,
  runTypewriter, scrollEntryTargetToAnchor,
} from './recenter.js';
import { installFocusListeners } from './listeners.js';
import { writeFocusSnapshot, clearFocusSnapshot } from './storage.js';
import { markFocusChrome, unmarkFocusChrome, applyGranularity } from './chrome.js';
import { mirrorToFocus, mirrorToNormal } from './mirror.js';
import { collapseSoftNewlines } from './soft-newlines.js';
import { FOCUS_SELECTOR } from '../shared/active-editor.js';
import { editorHost } from '../shared/editor-host.js';
import { installEditCounter } from '../shared/edit-counter.js';

export const focusCardMethods = {
  // Page-View-Direkteinstieg: Edit-Mode hochfahren (falls nicht bereits aktiv)
  // und dann in Fokus eintreten. Quelle: Focus-Button im Page-View-Header und
  // Hotkey Cmd/Ctrl+Shift+E aus dem Lesemodus.
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
    markFocusChrome(app.focusGranularity, app.typewriterAnchor);

    this.$nextTick(() => {
      // Wenn in der Zwischenzeit jemand exit() gerufen oder schneller
      // re-entered hat → abbrechen.
      if (gen !== this._focusGen || this._focusState !== 'entering') return;
      try {
        mirrorToFocus();
        // Rohe Umbrüche/Rand-Whitespace aus Alt-Beständen einebnen, BEVOR die
        // pre-wrap-Blöcke sie als Phantom-Zeilen und Einzüge zeigen
        // (Invariante 11c). Nur auf dem Fokus-Klon — der Normal-Container
        // bleibt unberührt, bis der Exit zurückspiegelt.
        collapseSoftNewlines(document.querySelector(FOCUS_SELECTOR));
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
        unmarkFocusChrome();
        // Counter zurück auf den Normal-Container: er hängt an dieser Stelle am
        // gerade wieder ausgeblendeten Focus-Container und würde dort dauerhaft
        // einen unsichtbaren Baum messen (Live-Anzeige im Header friert ein).
        app._editCounterCtx?.teardown?.();
        if (app.editMode) installEditCounter(app);
        this._focusState = 'idle';
      }
    });
  },

  _focusInstall() {
    const container = getScrollContainer();
    if (!container) throw new Error('focus: no scroll container');

    // Der Fokusmodus ist ein fixed Overlay; ein mitgeschleppter Dokument-Scroll
    // würde darunter stehenbleiben und beim Exit sichtbar. `behavior: 'instant'`
    // statt der Kurzform: eine fremde Schale mit `scroll-behavior: smooth` im
    // Host-CSS animierte den Sprung sonst quer durch den Editor-Eintritt (die
    // Kurzform und `behavior: 'auto'` delegieren beide an die CSS-Property).
    try { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }
    catch { window.scrollTo(0, 0); }

    const ctx = installFocusListeners({ ctrl: this, container });
    this._focusListeners = ctx;

    // container ist via shared/active-editor.js: bei aktiver Focus-Karte der
    // Focus-Cardroot, sonst der Normal-Editor-Container.
    container?.focus?.({ preventScroll: true });
    this._focusAutoAddedP = jumpToTrailingParagraph(container);
    // Schreib-Slot auf den Anker holen — dieselbe Geometrie wie der Typewriter
    // danach (siehe scrollEntryTargetToAnchor). `lastElementChild` ist in beiden
    // Fällen der Slot: jumpToTrailingParagraph recycelt den letzten leeren <p>
    // oder hängt einen neuen an.
    scrollEntryTargetToAnchor(container, container.lastElementChild, ctx);
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
    if (this._focusRaf) { cancelAnimationFrame(this._focusRaf); this._focusRaf = null; }
  },

  // Undo/Redo-Einstiegspunkte des Fokusmodus. Aufrufer sind der Tastengriff
  // (listeners.js#onHistoryKey) und — in einer fremden Schale — deren Menü.
  //
  // SPA-Default: die Session-Historie der Notebook-Karte. Der Fokusmodus ist
  // hier kein eigener Editor, sondern derselbe Edit-Vorgang auf einem
  // gespiegelten Container; `_getEditEl` löst ohnehin auf den Fokus-Container
  // auf und `@input="_markEditDirty()"` schiebt die Snapshots schon dorthin.
  // Ein zweiter Stack wäre eine zweite Wahrheit über denselben Inhalt.
  //
  // Die Standalone-Schale (focus/standalone.js) ÜBERSCHREIBT diese vier: dort
  // gibt es keine Notebook-Karte, die Schale hält ihre eigene Instanz des
  // geteilten Kerns (shared/edit-history.js).
  focusUndo() { editorHost()?.notebookUndo?.(); },
  focusRedo() { editorHost()?.notebookRedo?.(); },
  focusCanUndo() { return !!editorHost()?.notebookCanUndo?.(); },
  focusCanRedo() { return !!editorHost()?.notebookCanRedo?.(); },

  // Granularität live umschalten, ohne exit/enter: Cardroot-Klasse tauschen und
  // das Overlay neu rechnen. Aufrufer sind der `$watch` der SPA-Karte und
  // `setGranularity` einer fremden Schale — beide über diesen einen Weg, damit
  // ein neuer Modus nur an einer Stelle nachgezogen werden muss.
  applyFocusGranularity(granularity, root = document) {
    if (this._focusState !== 'active') return;
    applyGranularity(granularity, root);
    this._focusUpdateActive(false);
  },

  async exitFocusMode() {
    const app = editorHost();
    if (!app) return;
    if (this._focusState !== 'active') return;
    this._focusState = 'exiting';
    const gen = ++this._focusGen;

    // `finally` ist Pflicht: bleibt der State auf 'exiting' stehen (weil
    // irgendein Cleanup-Schritt wirft), sind beide Türen zu — `enterFocusMode`
    // verlangt 'idle', `exitFocusMode` verlangt 'active'. Das Overlay hinge
    // samt body-Klasse bis zum Reload fest, ohne Tastatur-Ausweg (die Listener
    // sind zu dem Zeitpunkt schon abgeräumt).
    try {
      // Auto-Slot vom Focus-Entry abräumen, falls User nichts reingeschrieben
      // hat. Sonst würde der leere `<p>` als „Änderung" gespeichert und bei jedem
      // Focus-Open eine Phantom-Revision erzeugen.
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
      // Race-Guard: sollte je ein Pfad entstehen, der während des `await` die
      // Generation bumpt, gehört das Cleanup dem neueren Aufruf.
      if (gen !== this._focusGen) return;

      this._focusTeardown();
      clearFocusSnapshot();

      // DOM-Roundtrip Focus → Normal, bevor focusActive=false greift und Alpine
      // den Focus-Cardroot via x-show ausblendet. Smart-Switch springt mit
      // `focusActive=false` automatisch zurück auf den Normal-Container.
      mirrorToNormal();
      // Counter wechselt zurück auf den Normal-Container.
      app._editCounterCtx?.teardown?.();

      app.focusActive = false;
      unmarkFocusChrome();

      // Restklassen defensiv abräumen (document-weit, nicht container-scoped: der
      // Focus-Container ist zu diesem Zeitpunkt schon ausgeblendet, die Klassen
      // können auch im Normal-Container-Klon stecken).
      clearAllFocusMarks();

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
    } catch (err) {
      reportError('exitFocusMode', err);
    } finally {
      // Nur die eigene Generation aufräumen — ein zwischenzeitlich gestarteter
      // Nachfolger besitzt den State dann bereits.
      if (gen === this._focusGen) {
        // Zuerst und wurffrei: der State ist das, was den Editor sonst
        // dauerhaft sperrt.
        this._focusState = 'idle';
        // Danach das Sicherheitsnetz für die Sichtbarkeit. Alle fünf Schritte
        // sind idempotent, im Normalfall also No-ops (sie liefen oben bereits).
        // Ist die Sequenz oben aber vorzeitig ausgestiegen, wäre der User sonst
        // in einem Overlay gefangen, das keine Listener mehr hat. Reihenfolge
        // wie oben: spiegeln, solange `.is-active` den Focus-Container noch
        // findet — erst danach die Flag umlegen.
        //
        // `clearAllFocusMarks` gehört mit ins Netz: die Dim-Regel ist ein
        // `:not(.focus-paragraph-active)`, die Marks wandern über
        // `mirrorToNormal` in den Normal-Container. Bleiben sie nach einem Wurf
        // stehen, sitzt der User in einer Leseansicht, in der ein Absatz hell
        // und alles andere gedimmt ist — und der nächste Save persistiert sie.
        try {
          mirrorToNormal();
          this._focusTeardown();
          app.focusActive = false;
          unmarkFocusChrome();
          clearAllFocusMarks();
        } catch (err) {
          reportError('exitFocusMode:cleanup', err);
        }
      }
    }
  },

  // Ein Recenter-Tick, gecancelt-gerafft: Burst-Inputs (Paste, Auto-Korrektur,
  // IME) kollabieren auf einen Frame.
  //
  // `opts.preferCenter` — User-Scroll: aktiver Block kommt aus der Viewport-Mitte
  // statt vom Caret. `opts.imeSafe` — Composition läuft: das DOM wird im
  // Normalfall NICHT angefasst (weder Block-Klassen noch Satz-Highlight), weil
  // beides das Kandidatenfenster versetzen bzw. die Eingabe abbrechen würde.
  // Einzige Ausnahme ist der Repair-Pfad: ist die Markierung nachweislich kaputt
  // (der markierte Block wurde weggelöscht/gemerged), wird sie wiederhergestellt
  // — Attribut-Toggle statt Struktur-Eingriff, und der Alternativzustand wäre ein
  // komplett gedimmter Text bis zum `compositionend` (Gboard hält die Composition
  // über ganze Wörter/Sätze offen). Der Typewriter läuft als Notnagel weiter
  // (siehe runTypewriter). `opts.force` — Recompute des Satz-Highlights
  // erzwingen, auch wenn der Block gleich blieb (`compositionend`).
  _focusUpdateActive(scroll, opts = {}) {
    if (this._focusState !== 'active') return;
    if (this._focusRaf) cancelAnimationFrame(this._focusRaf);
    const preferCenter = opts.preferCenter === true;
    const imeSafe = opts.imeSafe === true;
    const force = opts.force === true;
    const gen = this._focusGen;
    this._focusRaf = requestAnimationFrame(() => {
      this._focusRaf = null;
      // try/catch um den gesamten RAF-Body: ein DOM-Edge-Case (Selection über
      // Shadow-Root, obskurer Range-Fehler) darf den Editor nicht stillstellen.
      // Fehler → loggen, nächster Event-Tick versucht neu (Invariante 8).
      try {
        if (gen !== this._focusGen || this._focusState !== 'active') return;
        const ctx = this._focusListeners;
        const container = ctx?.container;
        if (!container) return;

        const sel = document.getSelection();
        const granularity = editorHost()?.focusGranularity || 'paragraph';
        const block = resolveActiveBlock({
          container, sel, granularity, preferCenter,
          visibleBlocks: ctx.visibleBlocks,
          lastBlock: ctx._lastBlock,
        });

        if (imeSafe) {
          if (repairBlockMarks(container, block, granularity, ctx._marks)) {
            syncSentenceMarks({ block, sel, granularity, recompute: true });
            ctx._lastBlock = block;
            ctx._lastGranularity = granularity;
          }
        } else {
          const recompute = force
            || block !== ctx._lastBlock
            || granularity !== ctx._lastGranularity
            || granularity === 'sentence';
          applyBlockMarks(container, block, granularity, ctx._marks);
          syncSentenceMarks({ block, sel, granularity, recompute });
          ctx._lastBlock = block;
          ctx._lastGranularity = granularity;
        }

        // Aktive Textmarkierung: nicht recentern, sonst springt der Viewport
        // während der User die Auswahl aufzieht oder an ihr arbeitet.
        const hasSelection = sel && sel.rangeCount > 0 && !sel.isCollapsed;
        if (scroll && !hasSelection) runTypewriter({ container, block, ctx, imeSafe });
      } catch (err) {
        reportError('updateActive', err);
      }
    });
  },
};
